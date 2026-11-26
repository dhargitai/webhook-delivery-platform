import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  createDatabase,
  type Database,
  type DeliveryJob,
  LaneRouter,
} from '@wdp/core';
import {
  createTestDatabase,
  type TestDatabase,
  sealedEndpointRow,
  testCipher,
  testKek,
} from '@wdp/core/testing';
import {
  BrokerConnection,
  ConfirmPublisher,
  declareTopology,
  encodeMessage,
  RETRY_READY_ROUTING_KEY,
  topologyNames,
  type TopologyNames,
} from '@wdp/messaging';
import { eventually, testingNamespace } from '@wdp/messaging/testing';
import type { Kysely } from 'kysely';
import { type Collection, type Document, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

// The worker opens endpoint secrets with this key; the spec seals them with it.
const KEK = testKek();
const cipher = testCipher(KEK);

const LANES = 4;

// The PRD's split: each fresh lane takes 20 jobs at once, `retry.ready` 5.
// Set here, not left to the defaults, so the numbers the tests assert on are
// the ones the worker runs with.
const PREFETCH = 20;
const RETRY_PREFETCH = 5;

// The PRD's test settings: a parked job is back within 20 ms.
const TIME_SCALE = 1000;
const RETRY_MIN_DELAY_MS = 20;

// How long "nothing more happens" is watched for. Well under the 10 s HTTP
// timeout, so no held request times out while a test runs.
const QUIET_MS = 1_500;

// How soon a fresh job must reach its receiver while retries are backed up:
// well inside the PRD's 5 s first-attempt target, so a regression shows long
// before the target itself is missed.
const FIRST_ATTEMPT_BOUND_MS = 1_000;

type Behaviour = { status: number } | 'hold';

interface Hit {
  webhookId: string;
  at: number;
}

describe('fresh versus retry traffic in the worker (real Postgres, RabbitMQ, MongoDB and Redis)', () => {
  const namespace = testingNamespace();
  const names: TopologyNames = topologyNames(namespace);
  const lanes = new LaneRouter(LANES);
  const mongoDbName = `wdp_test_${randomUUID().replaceAll('-', '')}`;
  let mongo: MongoClient;
  let attempts: Collection<Document>;
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let conn: BrokerConnection;
  let publisher: ConfirmPublisher;
  let worker: TestingModule;
  let receiverServer: Server;
  let receiverBase: string;
  let tenantId: string;

  // Each endpoint gets its own path, `/hook/<key>`, with its own behaviour,
  // and the receiver keeps what each one got and when.
  const behaviours = new Map<string, Behaviour>();
  const hits = new Map<string, Hit[]>();
  const held = new Map<string, ServerResponse[]>();

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
        const key = new URL(req.url ?? '/', 'http://localhost').pathname
          .split('/')
          .at(-1);
        if (key === undefined) return;
        hits.set(key, [
          ...(hits.get(key) ?? []),
          { webhookId: String(req.headers['webhook-id']), at: Date.now() },
        ]);
        const behaviour = behaviours.get(key) ?? { status: 200 };
        if (behaviour === 'hold') {
          held.set(key, [...(held.get(key) ?? []), res]);
          return;
        }
        res.statusCode = behaviour.status;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      receiverServer.listen(0, '127.0.0.1', resolve),
    );
    const { port } = receiverServer.address() as AddressInfo;
    receiverBase = `http://localhost:${port}/hook`;

    // The config module validates the environment while the worker module is
    // evaluated, so the import comes after the environment is set. The
    // breaker and the limiter are the real ones, with the PRD's values.
    process.env.DATABASE_URL = testDb.url;
    process.env.RABBITMQ_URL = inject('rabbitUrl');
    process.env.MONGO_URL = inject('mongoUrl');
    process.env.REDIS_URL = inject('redisUrl');
    process.env.MONGO_DB = mongoDbName;
    process.env.BROKER_NAMESPACE = namespace;
    process.env.LANE_COUNT = String(LANES);
    process.env.WORKER_PREFETCH = String(PREFETCH);
    process.env.WORKER_RETRY_PREFETCH = String(RETRY_PREFETCH);
    process.env.SSRF_ALLOW_HOSTS = 'localhost';
    process.env.SECRETS_KEK_V1 = KEK;
    process.env.TIME_SCALE = String(TIME_SCALE);
    process.env.RETRY_MIN_DELAY_MS = String(RETRY_MIN_DELAY_MS);
    const { WorkerModule } = await import('./worker.module.js');
    worker = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await worker.init();

    const tenant = await db
      .insertInto('tenants')
      .values({ name: `tenant-${randomUUID()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;
  });

  afterAll(async () => {
    // Held requests would keep the worker's consumers, and the receiver,
    // from stopping.
    for (const key of held.keys()) release(key, 200);
    await worker.close();
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    await conn.close();
    await db.destroy();
    await testDb.drop();
    await mongo.db(mongoDbName).dropDatabase();
    await mongo.close();
  });

  /** A new endpoint behind its own receiver path. */
  async function addEndpoint(
    behaviour: Behaviour,
    rate: { ratePerSecond?: number; burst?: number } = {},
  ): Promise<{ id: string; key: string }> {
    const key = randomUUID();
    behaviours.set(key, behaviour);
    const row = await db
      .insertInto('endpoints')
      .values({
        ...(await sealedEndpointRow(cipher, tenantId)),
        tenant_id: tenantId,
        url: `${receiverBase}/${key}`,
        status: 'active',
        rate_per_second: rate.ratePerSecond ?? null,
        burst: rate.burst ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: row.id, key };
  }

  /** A new endpoint whose jobs share a lane with `other`'s. */
  async function addEndpointOnLaneOf(
    other: string,
    behaviour: Behaviour,
  ): Promise<{ id: string; key: string }> {
    for (;;) {
      const endpoint = await addEndpoint(behaviour);
      if (lanes.lane(endpoint.id) === lanes.lane(other)) return endpoint;
    }
  }

  function newJob(endpointId: string, attemptNo?: number): DeliveryJob {
    return {
      deliveryId: randomUUID(),
      eventId: randomUUID(),
      tenantId,
      endpointId,
      eventType: 'invoice.paid',
      payload: { invoice: 'INV-42' },
      ...(attemptNo === undefined ? {} : { attemptNo }),
    };
  }

  /** A first attempt, onto the endpoint's own lane, as the dispatcher would. */
  async function publishJob(endpointId: string): Promise<DeliveryJob> {
    const job = newJob(endpointId);
    await publisher.publish(
      names.deliveriesExchange,
      lanes.routingKey(endpointId),
      encodeMessage(job),
      { messageId: job.deliveryId, correlationId: job.eventId },
    );
    return job;
  }

  /** A retry, into `retry.ready`, as a tier queue does once its wait is over. */
  async function publishRetry(
    endpointId: string,
    attemptNo: number,
  ): Promise<DeliveryJob> {
    const job = newJob(endpointId, attemptNo);
    await publisher.publish(
      names.deliveriesExchange,
      RETRY_READY_ROUTING_KEY,
      encodeMessage(job),
      { messageId: job.deliveryId, correlationId: job.eventId },
    );
    return job;
  }

  /** Answers every request the endpoint holds, and the later ones at once. */
  function release(key: string, status: number): void {
    behaviours.set(key, { status });
    for (const res of held.get(key)?.splice(0) ?? []) {
      res.statusCode = status;
      res.end('ok');
    }
  }

  const hitsOf = (key: string) => hits.get(key) ?? [];
  const heldOf = (key: string) => held.get(key)?.length ?? 0;

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('holds at most WORKER_RETRY_PREFETCH retries at once, while fresh jobs on its lane are delivered', async () => {
    const hanging = await addEndpoint('hold');
    const healthy = await addEndpointOnLaneOf(hanging.id, { status: 200 });
    const backlog = 40;
    for (let i = 0; i < backlog; i++) await publishRetry(hanging.id, 2);

    await eventually(() => {
      expect(heldOf(hanging.key)).toBe(RETRY_PREFETCH);
    });
    await sleep(QUIET_MS);
    // The retries never take more of the worker than their own prefetch,
    // however many are waiting.
    expect(heldOf(hanging.key)).toBe(RETRY_PREFETCH);

    // While they hang, first attempts on the same lane go straight through.
    const published = new Map<string, number>();
    for (let i = 0; i < PREFETCH; i++) {
      const job = await publishJob(healthy.id);
      published.set(job.deliveryId, Date.now());
    }
    await eventually(() => {
      expect(hitsOf(healthy.key)).toHaveLength(PREFETCH);
    });
    for (const { webhookId, at } of hitsOf(healthy.key)) {
      const sentAt = published.get(webhookId);
      expect(sentAt).toBeDefined();
      expect(at - (sentAt ?? 0)).toBeLessThan(FIRST_ATTEMPT_BOUND_MS);
    }

    // Drain the backlog, so the next test starts with a free retry consumer.
    release(hanging.key, 200);
    await eventually(() => {
      expect(hitsOf(hanging.key)).toHaveLength(backlog);
    });
  });

  it('returns a deferred retry to retry.ready, never to a fresh lane', async () => {
    // One call at once, then one every 200 ms: most retries are deferred
    // and parked at least once.
    const limited = await addEndpoint(
      { status: 200 },
      { ratePerSecond: 5, burst: 1 },
    );
    // A spy on the endpoint's fresh lane: the broker copies anything routed
    // there into it as well, and nothing consumes it.
    const spy = `${namespace}.spy.${randomUUID()}`;
    const channel = await conn.createChannel();
    // Durable and quorum, as RabbitMQ 4 refuses transient shared queues.
    await channel.assertQueue(spy, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum' },
    });
    await channel.bindQueue(
      spy,
      names.deliveriesExchange,
      lanes.routingKey(limited.id),
    );

    const count = 10;
    for (let i = 0; i < count; i++) await publishRetry(limited.id, 2);

    await eventually(async () => {
      expect(await attempts.countDocuments({ endpoint_id: limited.id })).toBe(
        count,
      );
    });
    expect(hitsOf(limited.key)).toHaveLength(count);
    // Deferred, not attempted: each retry is still attempt 2 when it lands.
    const records = await attempts.find({ endpoint_id: limited.id }).toArray();
    expect(
      records.every((r) => r.attempt_no === 2 && r.status === 'success'),
    ).toBe(true);
    // None of them came back by way of the fresh lane.
    expect((await channel.checkQueue(spy)).messageCount).toBe(0);

    await channel.deleteQueue(spy);
    await channel.close();
  });
});
