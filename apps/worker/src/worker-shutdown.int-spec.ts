import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  createDatabase,
  type Database,
  type DeliveryJob,
  generateEndpointSecret,
} from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import { laneRoutingKey } from '@wdp/domain';
import {
  BrokerConnection,
  ConfirmPublisher,
  declareTopology,
  decodeMessage,
  deliveryRequestedSchema,
  encodeMessage,
  topologyNames,
  type TopologyNames,
} from '@wdp/messaging';
import { eventually, testingNamespace } from '@wdp/messaging/testing';
import type { Kysely } from 'kysely';
import { type Collection, type Document, MongoClient } from 'mongodb';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
} from 'vitest';

const LANES = 4;

// The PRD's test settings, so a retry reaches `retry.ready` within 20 ms.
const TIME_SCALE = 1000;
const RETRY_MIN_DELAY_MS = 20;

// Long enough for the worker to cancel its consumers once a stop has begun,
// and for a stop that does not wait for its jobs to have finished already.
const SETTLE_MS = 400;

describe('a worker that is stopped mid-delivery (real Postgres, RabbitMQ and MongoDB)', () => {
  const namespace = testingNamespace();
  const names: TopologyNames = topologyNames(namespace);
  const mongoDbName = `wdp_test_${randomUUID().replaceAll('-', '')}`;
  let mongo: MongoClient;
  let attempts: Collection<Document>;
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let conn: BrokerConnection;
  let publisher: ConfirmPublisher;
  let WorkerModule: typeof import('./worker.module.js').WorkerModule;
  let receiverServer: Server;
  let receiverUrl: string;
  let worker: TestingModule | undefined;

  // While `holding`, the receiver keeps every request open, like a slow
  // endpoint, until `release` answers them all with the given status.
  // Requests after the release are answered at once with that status.
  const received: string[] = [];
  const held: ServerResponse[] = [];
  let holding = true;
  let releaseStatus = 200;

  function release(status: number): void {
    holding = false;
    releaseStatus = status;
    for (const res of held.splice(0)) {
      res.statusCode = status;
      res.end('ok');
    }
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url);
    mongo = await MongoClient.connect(inject('mongoUrl'));
    attempts = mongo.db(mongoDbName).collection('attempts');
    conn = await BrokerConnection.connect(inject('rabbitUrl'), () => undefined);
    const setup = await conn.createChannel();
    await declareTopology(setup, { laneCount: LANES, namespace });
    await setup.close();
    publisher = new ConfirmPublisher(await conn.createConfirmChannel());

    receiverServer = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received.push(String(req.headers['webhook-id']));
        if (holding) {
          held.push(res);
        } else {
          res.statusCode = releaseStatus;
          res.end('ok');
        }
      });
    });
    await new Promise<void>((resolve) =>
      receiverServer.listen(0, '127.0.0.1', resolve),
    );
    const { port } = receiverServer.address() as AddressInfo;
    receiverUrl = `http://localhost:${port}/hook`;

    // The config module validates the environment while the worker module is
    // evaluated, so the import comes after the environment is set.
    process.env.DATABASE_URL = testDb.url;
    process.env.RABBITMQ_URL = inject('rabbitUrl');
    process.env.MONGO_URL = inject('mongoUrl');
    process.env.MONGO_DB = mongoDbName;
    process.env.BROKER_NAMESPACE = namespace;
    process.env.LANE_COUNT = String(LANES);
    process.env.SSRF_ALLOW_HOSTS = 'localhost';
    process.env.TIME_SCALE = String(TIME_SCALE);
    process.env.RETRY_MIN_DELAY_MS = String(RETRY_MIN_DELAY_MS);
    ({ WorkerModule } = await import('./worker.module.js'));
  });

  beforeEach(async () => {
    received.length = 0;
    holding = true;
    // A job a previous test left waiting must not reach this test's worker.
    for (let lane = 0; lane < LANES; lane++) {
      await drain(names.laneQueue(lane));
    }
    worker = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await worker.init();
  });

  afterEach(async () => {
    // Whatever the test left held must end, or a worker still waiting on it
    // could never close.
    release(200);
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    await conn.close();
    await db.destroy();
    await testDb.drop();
    await mongo.db(mongoDbName).dropDatabase();
    await mongo.close();
  });

  async function count(queue: string): Promise<number> {
    const channel = await conn.createChannel();
    const { messageCount } = await channel.checkQueue(queue);
    await channel.close();
    return messageCount;
  }

  async function drain(queue: string) {
    const channel = await conn.createChannel();
    const messages = [];
    for (;;) {
      const message = await channel.get(queue, { noAck: true });
      if (message === false) break;
      messages.push(message);
    }
    await channel.close();
    return messages;
  }

  async function laneBacklog(): Promise<number> {
    let total = 0;
    for (let lane = 0; lane < LANES; lane++) {
      total += await count(names.laneQueue(lane));
    }
    return total;
  }

  async function newJob(): Promise<DeliveryJob> {
    const tenant = await db
      .insertInto('tenants')
      .values({ name: `tenant-${randomUUID()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    const endpoint = await db
      .insertInto('endpoints')
      .values({
        tenant_id: tenant.id,
        url: receiverUrl,
        signing_secret: generateEndpointSecret(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return {
      deliveryId: randomUUID(),
      eventId: randomUUID(),
      tenantId: tenant.id,
      endpointId: endpoint.id,
      eventType: 'invoice.paid',
      payload: { invoice: 'INV-42' },
    };
  }

  async function publishJob(job: DeliveryJob, lane = 0): Promise<void> {
    await publisher.publish(
      names.deliveriesExchange,
      laneRoutingKey(lane),
      encodeMessage(job),
      { messageId: job.deliveryId, correlationId: job.eventId },
    );
  }

  /**
   * Starts a stop, as SIGTERM does through Nest's shutdown hooks, while the
   * receiver still holds the job, and checks that the stop waits for it.
   * The pending close comes back wrapped: an async function returning the
   * promise itself would wait for it.
   */
  async function startStop(
    stopping: TestingModule,
  ): Promise<{ closing: Promise<void> }> {
    let closed = false;
    const closing = stopping.close().then(() => {
      closed = true;
    });
    worker = undefined;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(closed).toBe(false);
    return { closing };
  }

  function current(): TestingModule {
    if (!worker) throw new Error('no worker running');
    return worker;
  }

  it('finishes a delivery in flight and acks it before it stops', async () => {
    const job = await newJob();
    await publishJob(job);
    await eventually(() => expect(received).toEqual([job.deliveryId]));

    const { closing } = await startStop(current());
    release(200);
    await closing;

    // Acked before its channel closed: a job still unacked then would be
    // back on its lane, with no worker left to take it.
    expect(await laneBacklog()).toBe(0);
    expect(
      (await drain(names.deadLetterQueue)).filter(
        (message) => message.properties.messageId === job.deliveryId,
      ),
    ).toEqual([]);
    expect(
      await attempts.countDocuments({
        delivery_id: job.deliveryId,
        status: 'success',
      }),
    ).toBe(1);
    expect(received).toEqual([job.deliveryId]);
  });

  it('parks the retry of a failed attempt in flight before it stops', async () => {
    const job = await newJob();
    await publishJob(job);
    await eventually(() => expect(received).toEqual([job.deliveryId]));

    const { closing } = await startStop(current());
    release(503);
    await closing;

    expect(await laneBacklog()).toBe(0);
    expect(
      await attempts.countDocuments({
        delivery_id: job.deliveryId,
        attempt_no: 1,
        status: 'failure',
      }),
    ).toBe(1);
    // The retry comes back from its 20 ms tier, and no worker is left to take it.
    await eventually(async () => {
      expect(await count(names.retryReadyQueue)).toBe(1);
    });
    const [retry] = await drain(names.retryReadyQueue);
    expect(retry?.properties.messageId).toBe(job.deliveryId);
    expect(
      decodeMessage(retry?.content ?? Buffer.alloc(0), deliveryRequestedSchema),
    ).toEqual({ ...job, attemptNo: 2 });
  });

  it('takes no new job once it has started stopping', async () => {
    const first = await newJob();
    await publishJob(first);
    await eventually(() => expect(received).toEqual([first.deliveryId]));

    const { closing } = await startStop(current());
    const second = await newJob();
    await publishJob(second, 1);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    release(200);
    await closing;

    // The second job waits on its lane for the next worker.
    expect(received).toEqual([first.deliveryId]);
    expect(await count(names.laneQueue(0))).toBe(0);
    expect(await count(names.laneQueue(1))).toBe(1);
  });
});
