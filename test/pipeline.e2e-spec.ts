import { randomUUID } from 'node:crypto';
import { type INestApplicationContext, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  createDatabase,
  type Database,
  type DeliveryJob,
  generateApiKey,
  LaneRouter,
} from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import { deliveryId } from '@wdp/domain';
import {
  BrokerConnection,
  declareTopology,
  decodeMessage,
  deliveryRequestedSchema,
  type TopologyNames,
} from '@wdp/messaging';
import { eventually, testingNamespace } from '@wdp/messaging/testing';
import { type Kysely, sql } from 'kysely';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';

const LANES = 4;

/**
 * The whole Phase 1 path, with the real apps: API -> Postgres outbox ->
 * relay -> RabbitMQ -> dispatcher -> one job per subscribed endpoint.
 */
describe('Phase 1 pipeline (e2e)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let conn: BrokerConnection;
  let names: TopologyNames;
  let api: NestExpressApplication;
  let relay: INestApplicationContext;
  let DispatcherModule: typeof import('../apps/dispatcher/src/dispatcher.module.js').DispatcherModule;
  const running: INestApplicationContext[] = [];
  const brokerErrors: Error[] = [];
  const router = new LaneRouter(LANES);

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    const namespace = testingNamespace();
    // Each app's config module validates the environment while its module file
    // is evaluated, so every variable must exist before the imports below.
    process.env.DATABASE_URL = testDb.url;
    process.env.REDIS_URL = inject('redisUrl');
    process.env.RABBITMQ_URL = inject('rabbitUrl');
    process.env.BROKER_NAMESPACE = namespace;
    process.env.LANE_COUNT = String(LANES);
    process.env.RELAY_POLL_INTERVAL_MS = '20';

    const { AppModule } = await import('../apps/api/src/app.module.js');
    const { configureApp } = await import('../apps/api/src/configure-app.js');
    const { RelayModule } = await import('../apps/relay/src/relay.module.js');
    ({ DispatcherModule } =
      await import('../apps/dispatcher/src/dispatcher.module.js'));

    conn = await BrokerConnection.connect(inject('rabbitUrl'), (e) =>
      brokerErrors.push(e),
    );
    // Declared up front so the specs can inspect and purge every queue.
    names = await declareTopology(await conn.createChannel(), {
      laneCount: LANES,
      namespace,
    });
    db = createDatabase(testDb.url);

    const apiModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    api = apiModule.createNestApplication<NestExpressApplication>();
    configureApp(api);
    await api.init();

    relay = await Test.createTestingModule({
      imports: [RelayModule],
    }).compile();
    await relay.init();
  });

  beforeEach(async () => {
    const channel = await conn.createChannel();
    for (const queue of [
      names.dispatchQueue,
      names.deadLetterQueue,
      ...Array.from({ length: LANES }, (_, i) => names.laneQueue(i)),
    ]) {
      await channel.purgeQueue(queue);
    }
    await channel.close();
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map((app) => app.close()));
  });

  afterAll(async () => {
    await relay.close();
    await api.close();
    await conn.close();
    await db.destroy();
    await testDb.drop();
  });

  async function seedTenant() {
    const tenant = await db
      .insertInto('tenants')
      .values({ name: `tenant-${randomUUID()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    const { key, prefix, hash } = generateApiKey();
    await db
      .insertInto('api_keys')
      .values({ tenant_id: tenant.id, prefix, key_hash: hash })
      .execute();
    return { tenantId: tenant.id, key };
  }

  const call = (
    method: 'post' | 'put',
    path: string,
    key: string,
    body: object,
    headers: Record<string, string> = {},
  ) =>
    request(api.getHttpServer())
      [method](`/v1${path}`)
      .set('Authorization', `Bearer ${key}`)
      .set(headers)
      .send(body);

  /** Registers an endpoint through the API and subscribes it. */
  async function registerEndpoint(
    key: string,
    eventTypes: string[],
  ): Promise<string> {
    const created = await call('post', '/endpoints', key, {
      url: 'https://hooks.acme.test/in',
    });
    expect(created.status).toBe(201);
    const subscribed = await call(
      'put',
      `/endpoints/${created.body.id}/subscriptions`,
      key,
      { event_types: eventTypes },
    );
    expect(subscribed.status).toBe(200);
    return created.body.id;
  }

  async function postEvent(key: string, headers: Record<string, string> = {}) {
    const res = await call(
      'post',
      '/events',
      key,
      { type: 'invoice.paid', payload: { invoice: 'INV-42' } },
      headers,
    );
    expect(res.status).toBe(202);
    return res.body.event_id as string;
  }

  async function startDispatcher(): Promise<INestApplicationContext> {
    const moduleRef = await Test.createTestingModule({
      imports: [DispatcherModule],
    }).compile();
    await moduleRef.init();
    running.push(moduleRef);
    return moduleRef;
  }

  async function count(queue: string): Promise<number> {
    const channel = await conn.createChannel();
    const { messageCount } = await channel.checkQueue(queue);
    await channel.close();
    return messageCount;
  }

  /** Takes every job currently on the lane queues. */
  async function takeJobs() {
    const jobs: {
      lane: number;
      correlationId: string;
      body: DeliveryJob;
    }[] = [];
    const channel = await conn.createChannel();
    for (let lane = 0; lane < LANES; lane++) {
      for (;;) {
        const message = await channel.get(names.laneQueue(lane), {
          noAck: true,
        });
        if (message === false) break;
        jobs.push({
          lane,
          correlationId: String(message.properties.correlationId),
          body: decodeMessage(message.content, deliveryRequestedSchema),
        });
      }
    }
    await channel.close();
    return jobs;
  }

  /** Waits until `expected` jobs have arrived, returning them. */
  async function waitForJobs(expected: number) {
    const jobs: Awaited<ReturnType<typeof takeJobs>> = [];
    await eventually(async () => {
      jobs.push(...(await takeJobs()));
      expect(jobs).toHaveLength(expected);
    });
    return jobs;
  }

  const publishedCount = async (tenantId: string) =>
    Number(
      (
        await db
          .selectFrom('events')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('tenant_id', '=', tenantId)
          .where('published_at', 'is not', null)
          .executeTakeFirstOrThrow()
      ).n,
    );

  it('delivers an accepted event to every endpoint subscribed to it, each on its own lane', async () => {
    const { key } = await seedTenant();
    const endpoints = [
      await registerEndpoint(key, ['invoice.paid']),
      await registerEndpoint(key, ['invoice.paid', 'invoice.failed']),
      await registerEndpoint(key, ['invoice.paid']),
    ];
    await registerEndpoint(key, ['card.moved']);
    await startDispatcher();

    const eventId = await postEvent(key);

    const jobs = await waitForJobs(3);
    expect(jobs.map((j) => j.body.endpointId).sort()).toEqual(
      [...endpoints].sort(),
    );
    for (const job of jobs) {
      expect(job.body).toMatchObject({
        eventId,
        eventType: 'invoice.paid',
        payload: { invoice: 'INV-42' },
        deliveryId: deliveryId(eventId, job.body.endpointId),
      });
      expect(job.correlationId).toBe(eventId);
      expect(`fresh.shard.0${job.lane}`).toBe(
        router.routingKey(job.body.endpointId),
      );
    }
  });

  it('sends one set of jobs when the client retries with the same Idempotency-Key', async () => {
    const { key } = await seedTenant();
    await registerEndpoint(key, ['invoice.paid']);
    await registerEndpoint(key, ['invoice.paid']);
    await startDispatcher();

    const first = await postEvent(key, { 'Idempotency-Key': 'retry-1' });
    const second = await postEvent(key, { 'Idempotency-Key': 'retry-1' });

    expect(second).toBe(first);
    await waitForJobs(2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await takeJobs()).toEqual([]);
  });

  it('only dispatches to the tenant that sent the event', async () => {
    const sender = await seedTenant();
    const other = await seedTenant();
    const own = await registerEndpoint(sender.key, ['invoice.paid']);
    await registerEndpoint(other.key, ['invoice.paid']);
    await startDispatcher();

    await postEvent(sender.key);

    const jobs = await waitForJobs(1);
    expect(jobs[0]?.body.endpointId).toBe(own);
  });

  it('accepts and publishes an event nobody subscribes to, producing no jobs', async () => {
    const { tenantId, key } = await seedTenant();
    await startDispatcher();

    await postEvent(key);

    await eventually(async () => {
      expect(await publishedCount(tenantId)).toBe(1);
      expect(await count(names.dispatchQueue)).toBe(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await takeJobs()).toEqual([]);
    expect(await count(names.deadLetterQueue)).toBe(0);
  });

  it('dispatches to an endpoint registered after the event was accepted but before it was dispatched', async () => {
    const { key } = await seedTenant();
    // No dispatcher yet: the event waits on the dispatch queue.
    await postEvent(key);
    await eventually(async () => {
      expect(await count(names.dispatchQueue)).toBe(1);
    });

    const late = await registerEndpoint(key, ['invoice.paid']);
    await startDispatcher();

    const jobs = await waitForJobs(1);
    expect(jobs[0]?.body.endpointId).toBe(late);
  });

  it('finishes the event it is working on before it shuts down, so nothing in flight is lost', async () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const { tenantId, key } = await seedTenant();
      const endpointId = await registerEndpoint(key, ['invoice.paid']);
      const dispatcher = await startDispatcher();

      // Hold a lock on `endpoints`, so the dispatcher's subscription lookup
      // blocks partway through handling the event.
      let releaseLock: () => void = () => undefined;
      const lockHeld = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      let lockTaken: () => void = () => undefined;
      const lockReady = new Promise<void>((resolve) => {
        lockTaken = resolve;
      });
      const locker = db.transaction().execute(async (trx) => {
        await sql`lock table endpoints in access exclusive mode`.execute(trx);
        lockTaken();
        await lockHeld;
      });
      await lockReady;

      await postEvent(key);
      await eventually(async () => {
        expect(await publishedCount(tenantId)).toBe(1);
      });
      // Long enough for the dispatcher to take the event and block on the lookup.
      await new Promise((resolve) => setTimeout(resolve, 500));

      let closed = false;
      const closing = dispatcher.close().then(() => {
        closed = true;
      });
      running.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 400));
      // A graceful stop is still waiting for the event in flight.
      expect(closed).toBe(false);

      releaseLock();
      await locker;
      await closing;

      const jobs = await takeJobs();
      expect(jobs.map((j) => j.body.endpointId)).toEqual([endpointId]);
      expect(await count(names.dispatchQueue)).toBe(0);
      expect(await count(names.deadLetterQueue)).toBe(0);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it('shuts the dispatcher down cleanly, with no failed work left behind', async () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const { tenantId, key } = await seedTenant();
      const dispatcher = await startDispatcher();
      await postEvent(key);
      await eventually(async () => {
        expect(await publishedCount(tenantId)).toBe(1);
        expect(await count(names.dispatchQueue)).toBe(0);
      });

      await expect(dispatcher.close()).resolves.toBeUndefined();
      running.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
