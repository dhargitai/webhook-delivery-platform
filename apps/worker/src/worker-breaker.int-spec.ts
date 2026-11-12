import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test, type TestingModule } from '@nestjs/testing';
import { REDIS } from '@wdp/common';
import {
  CircuitBreaker,
  createDatabase,
  type Database,
  type DeliveryJob,
  generateEndpointSecret,
  LaneRouter,
} from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import {
  BrokerConnection,
  ConfirmPublisher,
  declareTopology,
  encodeMessage,
  topologyNames,
  type TopologyNames,
} from '@wdp/messaging';
import { eventually, testingNamespace } from '@wdp/messaging/testing';
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { type Collection, type Document, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { CIRCUIT_BREAKER } from './tokens.js';

const LANES = 4;

// The PRD's test settings: a parked job is back on its lane within 20 ms, so
// a job on an open circuit goes round many times in a second.
const TIME_SCALE = 1000;
const RETRY_MIN_DELAY_MS = 20;

// The PRD's trip rule needs 20 samples; 4 keep the tests short. The cooldown
// is long, so a circuit stays open until a test ends it (see `endCooldown`).
const MIN_SAMPLES = 4;
const COOLDOWN_MS = 60_000;

// How long "nothing more happens" is watched for. A parked job comes back
// every ~20 ms, so a gate that let calls through would show many times over.
const QUIET_MS = 1_500;

type Behaviour = { status: number } | 'hold';

describe('the circuit breaker in the worker (real Postgres, RabbitMQ, MongoDB and Redis)', () => {
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
  let redis: Redis;
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
    redis = new Redis(inject('redisUrl'));
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
    // evaluated, so the import comes after the environment is set.
    process.env.DATABASE_URL = testDb.url;
    process.env.RABBITMQ_URL = inject('rabbitUrl');
    process.env.MONGO_URL = inject('mongoUrl');
    process.env.REDIS_URL = inject('redisUrl');
    process.env.MONGO_DB = mongoDbName;
    process.env.BROKER_NAMESPACE = namespace;
    process.env.LANE_COUNT = String(LANES);
    process.env.SSRF_ALLOW_HOSTS = 'localhost';
    process.env.TIME_SCALE = String(TIME_SCALE);
    process.env.RETRY_MIN_DELAY_MS = String(RETRY_MIN_DELAY_MS);
    const { WorkerModule } = await import('./worker.module.js');
    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(CIRCUIT_BREAKER)
      .useFactory({
        inject: [REDIS],
        factory: (client: Redis) =>
          new CircuitBreaker(client, {
            minSamples: MIN_SAMPLES,
            baseCooldownMs: COOLDOWN_MS,
          }),
      })
      .compile();
    await worker.init();

    const tenant = await db
      .insertInto('tenants')
      .values({ name: `tenant-${randomUUID()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;
  });

  afterAll(async () => {
    // Held requests would keep the receiver from closing.
    for (const key of held.keys()) release(key, 200);
    await worker.close();
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    await conn.close();
    redis.disconnect();
    await db.destroy();
    await testDb.drop();
    await mongo.db(mongoDbName).dropDatabase();
    await mongo.close();
  });

  /** A new endpoint behind its own receiver path. */
  async function addEndpoint(
    behaviour: Behaviour,
  ): Promise<{ id: string; key: string }> {
    const key = randomUUID();
    behaviours.set(key, behaviour);
    const row = await db
      .insertInto('endpoints')
      .values({
        tenant_id: tenantId,
        url: `${receiverBase}/${key}`,
        signing_secret: generateEndpointSecret(),
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { id: row.id, key };
  }

  async function publishJob(
    endpointId: string,
    attemptNo?: number,
  ): Promise<DeliveryJob> {
    const job: DeliveryJob = {
      deliveryId: randomUUID(),
      eventId: randomUUID(),
      tenantId,
      endpointId,
      eventType: 'invoice.paid',
      payload: { invoice: 'INV-42' },
      ...(attemptNo === undefined ? {} : { attemptNo }),
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

  /** The circuit's state hash; empty while the circuit is closed. */
  const circuitOf = (endpointId: string) =>
    redis.hgetall(`cb:{${endpointId}}:state`);

  /**
   * Ends an open circuit's cooldown at once, instead of waiting it out: the
   * next delivery finds `openUntil` passed and is elected as the probe.
   */
  async function endCooldown(endpointId: string): Promise<void> {
    await redis.hset(`cb:{${endpointId}}:state`, 'openUntil', 0);
  }

  /** Fails enough deliveries to an endpoint to open its circuit. */
  async function openCircuit(): Promise<{
    id: string;
    key: string;
    jobs: DeliveryJob[];
  }> {
    const endpoint = await addEndpoint({ status: 503 });
    const jobs: DeliveryJob[] = [];
    for (let i = 0; i < MIN_SAMPLES; i++) {
      jobs.push(await publishJob(endpoint.id));
    }
    await eventually(async () => {
      expect((await circuitOf(endpoint.id)).state).toBe('open');
    });
    // A call that was let through just before the trip may still be on its
    // way to the receiver.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { ...endpoint, jobs };
  }

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('stops calling a dead endpoint once its circuit opens, and keeps delivering to others', async () => {
    const dead = await openCircuit();
    const callsAtTrip = hitsOf(dead.key).length;
    // At least the tripping calls were made, and every one was logged.
    expect(callsAtTrip).toBeGreaterThanOrEqual(MIN_SAMPLES);

    await sleep(QUIET_MS);

    // Its jobs keep coming back from the park queue, but none gets through.
    expect(hitsOf(dead.key)).toHaveLength(callsAtTrip);
    expect(await attempts.countDocuments({ endpoint_id: dead.id })).toBe(
      callsAtTrip,
    );

    const healthy = await addEndpoint({ status: 200 });
    const job = await publishJob(healthy.id);
    await eventually(() => {
      expect(hitsOf(healthy.key)).toEqual([job.deliveryId]);
    });
  });

  it('uses up no attempt while the circuit is open', async () => {
    const dead = await openCircuit();
    const job = await publishJob(dead.id, 3);

    await sleep(QUIET_MS);

    expect(hitsOf(dead.key)).not.toContain(job.deliveryId);
    expect(await attempts.countDocuments({ delivery_id: job.deliveryId })).toBe(
      0,
    );

    // The endpoint recovers and the cooldown ends: a probe closes the circuit
    // and the job is delivered, still as its third attempt.
    release(dead.key, 200);
    await endCooldown(dead.id);
    await eventually(async () => {
      const records = await attempts
        .find({ delivery_id: job.deliveryId })
        .toArray();
      expect(records).toMatchObject([{ attempt_no: 3, status: 'success' }]);
    });
    expect(hitsOf(dead.key).filter((id) => id === job.deliveryId)).toHaveLength(
      1,
    );
  });

  it('lets exactly one probe through once the cooldown ends, and closes the circuit on its success', async () => {
    const dead = await openCircuit();
    const callsAtTrip = hitsOf(dead.key).length;

    behaviours.set(dead.key, 'hold');
    await endCooldown(dead.id);

    // The probe is held open at the receiver; every other job is denied.
    await eventually(() => {
      expect(hitsOf(dead.key)).toHaveLength(callsAtTrip + 1);
    });
    await sleep(QUIET_MS);
    expect(hitsOf(dead.key)).toHaveLength(callsAtTrip + 1);
    expect((await circuitOf(dead.id)).state).toBe('half_open');

    release(dead.key, 200);

    await eventually(async () => {
      expect(await circuitOf(dead.id)).toEqual({});
    });
    // Every job that was parked on the open circuit is delivered.
    await eventually(async () => {
      const delivered = await attempts.distinct('delivery_id', {
        endpoint_id: dead.id,
        status: 'success',
      });
      // `distinct` gives each id once, so comparing as sets loses nothing.
      expect(new Set(delivered)).toEqual(
        new Set(dead.jobs.map((job) => job.deliveryId)),
      );
    });
  });

  it('reopens the circuit one level up when the probe fails, and calls nothing more', async () => {
    const dead = await openCircuit();
    const callsAtTrip = hitsOf(dead.key).length;

    behaviours.set(dead.key, 'hold');
    await endCooldown(dead.id);
    await eventually(() => {
      expect(hitsOf(dead.key)).toHaveLength(callsAtTrip + 1);
    });

    release(dead.key, 503);

    await eventually(async () => {
      expect(await circuitOf(dead.id)).toMatchObject({
        state: 'open',
        level: '1',
      });
    });
    await sleep(QUIET_MS);
    expect(hitsOf(dead.key)).toHaveLength(callsAtTrip + 1);
  });
});
