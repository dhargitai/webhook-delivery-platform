import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  createDatabase,
  type Database,
  generateApiKey,
  SignatureService,
} from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import { deliveryId } from '@wdp/domain';
import { eventually, testingNamespace } from '@wdp/messaging/testing';
import type { Kysely } from 'kysely';
import { type Collection, type Document, MongoClient } from 'mongodb';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
} from 'vitest';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * Phase 2's first slice, with the real apps: API -> Postgres outbox -> relay
 * -> RabbitMQ -> dispatcher -> lane queue -> worker -> a receiver that checks
 * what arrives.
 */
describe('first delivery (e2e)', () => {
  const signatures = new SignatureService();
  const mongoDbName = `wdp_test_${randomUUID().replaceAll('-', '')}`;
  let mongo: MongoClient;
  let attempts: Collection<Document>;
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let api: NestExpressApplication;
  const services: INestApplicationContext[] = [];
  let receiverServer: Server;
  let receiverBase: string;
  // Everything that reaches the receiver, whichever path it was called on.
  const received: Received[] = [];
  // Requests so far per webhook id, for the path that fails before it recovers.
  const hits = new Map<string, number>();

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url);
    mongo = await MongoClient.connect(inject('mongoUrl'));
    attempts = mongo.db(mongoDbName).collection('attempts');

    // A receiver on loopback. It is plain http on a private address, so it is
    // reachable only because both the API (at registration) and the worker (at
    // connect time) have its name on their allowlist.
    receiverServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          headers: { ...req.headers, 'x-path': req.url ?? '' },
          body: Buffer.concat(chunks).toString(),
        });
        if (req.url === '/recovering') {
          // Down for the first two requests of a delivery, then back up.
          const id = String(req.headers['webhook-id']);
          const count = (hits.get(id) ?? 0) + 1;
          hits.set(id, count);
          res.statusCode = count <= 2 ? 503 : 200;
        }
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      receiverServer.listen(0, '127.0.0.1', resolve),
    );
    receiverBase = `http://localhost:${(receiverServer.address() as AddressInfo).port}`;

    // Each app's config module validates the environment while its module file
    // is evaluated, so every variable must exist before the imports below.
    process.env.DATABASE_URL = testDb.url;
    process.env.REDIS_URL = inject('redisUrl');
    process.env.RABBITMQ_URL = inject('rabbitUrl');
    process.env.MONGO_URL = inject('mongoUrl');
    process.env.MONGO_DB = mongoDbName;
    process.env.BROKER_NAMESPACE = testingNamespace();
    process.env.LANE_COUNT = '4';
    process.env.RELAY_POLL_INTERVAL_MS = '20';
    process.env.SSRF_ALLOW_HOSTS = 'localhost';
    // The PRD's test settings: retry delays divided by 1000, none below 20 ms.
    process.env.TIME_SCALE = '1000';
    process.env.RETRY_MIN_DELAY_MS = '20';

    const { AppModule } = await import('../apps/api/src/app.module.js');
    const { configureApp } = await import('../apps/api/src/configure-app.js');
    const { RelayModule } = await import('../apps/relay/src/relay.module.js');
    const { DispatcherModule } =
      await import('../apps/dispatcher/src/dispatcher.module.js');
    const { WorkerModule } =
      await import('../apps/worker/src/worker.module.js');

    const apiModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    api = apiModule.createNestApplication<NestExpressApplication>();
    configureApp(api);
    await api.init();

    for (const module of [RelayModule, DispatcherModule, WorkerModule]) {
      const service = await Test.createTestingModule({
        imports: [module],
      }).compile();
      await service.init();
      services.push(service);
    }
  });

  beforeEach(() => {
    received.length = 0;
  });

  afterAll(async () => {
    // Stop in the order work flows, so nothing is cut off mid-handoff.
    await api.close();
    for (const service of services) {
      await service.close();
    }
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    await db.destroy();
    await testDb.drop();
    await mongo.db(mongoDbName).dropDatabase();
    await mongo.close();
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
    path: string,
    eventTypes: string[],
  ): Promise<{ id: string; secret: string }> {
    const created = await call('post', '/endpoints', key, {
      url: `${receiverBase}${path}`,
    });
    expect(created.status).toBe(201);
    const subscribed = await call(
      'put',
      `/endpoints/${created.body.id}/subscriptions`,
      key,
      { event_types: eventTypes },
    );
    expect(subscribed.status).toBe(200);
    return { id: created.body.id, secret: created.body.secret };
  }

  async function postEvent(
    key: string,
    type: string,
    headers: Record<string, string> = {},
  ) {
    const res = await call(
      'post',
      '/events',
      key,
      { type, payload: { invoice: 'INV-42' } },
      headers,
    );
    expect(res.status).toBe(202);
    return res.body.event_id as string;
  }

  const to = (path: string) =>
    received.filter((r) => r.headers['x-path'] === path);

  it('delivers an accepted event to its endpoint with a valid signature', async () => {
    const { key } = await seedTenant();
    const endpoint = await registerEndpoint(key, '/in', ['invoice.paid']);

    const eventId = await postEvent(key, 'invoice.paid');

    await eventually(() => expect(to('/in')).toHaveLength(1));
    const [delivery] = to('/in') as [Received];
    expect(JSON.parse(delivery.body)).toEqual({
      id: eventId,
      type: 'invoice.paid',
      data: { invoice: 'INV-42' },
    });
    // The id a receiver deduplicates on comes from the real fan-out.
    expect(delivery.headers['webhook-id']).toBe(
      deliveryId(eventId, endpoint.id),
    );
    // Verifiable with the secret the API showed once, at registration.
    expect(
      signatures.verify(
        String(delivery.headers['webhook-signature']),
        String(delivery.headers['webhook-id']),
        Number(delivery.headers['webhook-timestamp']),
        delivery.body,
        [endpoint.secret],
        new Date(),
      ),
    ).toBe(true);
  });

  it('logs the attempt, so it can be found by event and endpoint', async () => {
    const { tenantId, key } = await seedTenant();
    const endpoint = await registerEndpoint(key, '/logged', ['invoice.paid']);

    const eventId = await postEvent(key, 'invoice.paid');

    await eventually(() => expect(to('/logged')).toHaveLength(1));
    await eventually(async () => {
      expect(
        await attempts.countDocuments({
          tenant_id: tenantId,
          event_id: eventId,
        }),
      ).toBe(1);
    });
    expect(
      await attempts.findOne(
        { tenant_id: tenantId, event_id: eventId },
        { projection: { _id: 0, ts: 0, latency_ms: 0 } },
      ),
    ).toEqual({
      tenant_id: tenantId,
      endpoint_id: endpoint.id,
      event_id: eventId,
      delivery_id: deliveryId(eventId, endpoint.id),
      attempt_no: 1,
      status: 'success',
      http_status: 200,
      response_snippet: 'ok',
    });
  });

  it('delivers only to endpoints subscribed to the event type', async () => {
    const { key } = await seedTenant();
    await registerEndpoint(key, '/wanted', ['invoice.paid']);
    await registerEndpoint(key, '/other', ['card.moved']);

    await postEvent(key, 'invoice.paid');

    await eventually(() => expect(to('/wanted')).toHaveLength(1));
    // Leave time for a wrong delivery to show up.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(to('/other')).toHaveLength(0);
  });

  it('retries a failing receiver until it recovers, then stops', async () => {
    const { tenantId, key } = await seedTenant();
    const endpoint = await registerEndpoint(key, '/recovering', [
      'invoice.paid',
    ]);

    const eventId = await postEvent(key, 'invoice.paid');

    await eventually(() => expect(to('/recovering')).toHaveLength(3), {
      timeoutMs: 15_000,
    });
    // Leave time for an attempt after the success to show up.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(to('/recovering')).toHaveLength(3);
    // The same id on every try, so the receiver can deduplicate.
    expect(
      new Set(to('/recovering').map((r) => r.headers['webhook-id'])),
    ).toEqual(new Set([deliveryId(eventId, endpoint.id)]));
    // Every try is in the log under its own number.
    const logged = await attempts
      .find({ tenant_id: tenantId, event_id: eventId })
      .sort({ attempt_no: 1 })
      .toArray();
    expect(logged.map((d) => [d['attempt_no'], d['status']])).toEqual([
      [1, 'failure'],
      [2, 'failure'],
      [3, 'success'],
    ]);
  });

  it('delivers once when the same Idempotency-Key is sent twice', async () => {
    const { key } = await seedTenant();
    await registerEndpoint(key, '/once', ['invoice.paid']);

    const first = await postEvent(key, 'invoice.paid', {
      'Idempotency-Key': 'demo-1',
    });
    const second = await postEvent(key, 'invoice.paid', {
      'Idempotency-Key': 'demo-1',
    });

    expect(second).toBe(first);
    await eventually(() => expect(to('/once')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(to('/once')).toHaveLength(1);
  });
});
