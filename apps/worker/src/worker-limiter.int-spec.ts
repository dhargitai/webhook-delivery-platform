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

// The PRD's test settings: a job parked by the limiter is back on its lane
// within 20 ms, so a gate that let calls through would show many times over.
const TIME_SCALE = 1000;
const RETRY_MIN_DELAY_MS = 20;

// Above the PRD's cap of 20 slots: without the limiter, one hanging endpoint
// would hold every job its lane can take at once.
const PREFETCH = 25;
const CAP = 20;

// How long "nothing more happens" is watched for. Well under the 10 s HTTP
// timeout, so no held request times out while a test runs.
const QUIET_MS = 1_500;

type Behaviour = { status: number } | 'hold';

describe('the endpoint limiter in the worker (real Postgres, RabbitMQ, MongoDB and Redis)', () => {
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
  // and the receiver keeps the webhook ids of what each one got.
  const behaviours = new Map<string, Behaviour>();
  const hits = new Map<string, string[]>();
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
          String(req.headers['webhook-id']),
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
    // limiter is the real one, with the PRD's cap, lease and rate.
    process.env.DATABASE_URL = testDb.url;
    process.env.RABBITMQ_URL = inject('rabbitUrl');
    process.env.MONGO_URL = inject('mongoUrl');
    process.env.REDIS_URL = inject('redisUrl');
    process.env.MONGO_DB = mongoDbName;
    process.env.BROKER_NAMESPACE = namespace;
    process.env.LANE_COUNT = String(LANES);
    process.env.WORKER_PREFETCH = String(PREFETCH);
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

  async function publishJob(endpointId: string): Promise<DeliveryJob> {
    const job: DeliveryJob = {
      deliveryId: randomUUID(),
      eventId: randomUUID(),
      tenantId,
      endpointId,
      eventType: 'invoice.paid',
      payload: { invoice: 'INV-42' },
    };
    // Onto the endpoint's own lane, as the dispatcher would.
    await publisher.publish(
      names.deliveriesExchange,
      lanes.routingKey(endpointId),
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

  it('lets a hanging endpoint hold at most 20 slots, and keeps delivering to others on its lane', async () => {
    const hanging = await addEndpoint('hold');
    const healthy = await addEndpointOnLaneOf(hanging.id, { status: 200 });
    for (let i = 0; i < CAP * 2; i++) await publishJob(hanging.id);
    const job = await publishJob(healthy.id);

    await eventually(() => {
      expect(heldOf(hanging.key)).toBe(CAP);
    });
    await sleep(QUIET_MS);

    // Its other jobs keep coming back from the park queue, but none reaches
    // the receiver while the 20 calls hang.
    expect(heldOf(hanging.key)).toBe(CAP);
    expect(hitsOf(hanging.key)).toHaveLength(CAP);
    // The lane still has room, so a job for another endpoint gets through.
    await eventually(() => {
      expect(hitsOf(healthy.key)).toEqual([job.deliveryId]);
    });
  });

  it('honours the endpoint’s stored rate override, without using up attempts', async () => {
    // Two calls at once, then one every 10 s.
    const slow = await addEndpoint(
      { status: 200 },
      { ratePerSecond: 0.1, burst: 2 },
    );
    for (let i = 0; i < 5; i++) await publishJob(slow.id);

    await eventually(async () => {
      expect(await attempts.countDocuments({ endpoint_id: slow.id })).toBe(2);
    });
    await sleep(QUIET_MS);

    expect(hitsOf(slow.key)).toHaveLength(2);
    // The deferred jobs are neither logged nor counted as attempts.
    const records = await attempts.find({ endpoint_id: slow.id }).toArray();
    expect(records).toMatchObject([
      { attempt_no: 1, status: 'success' },
      { attempt_no: 1, status: 'success' },
    ]);
  });
});
