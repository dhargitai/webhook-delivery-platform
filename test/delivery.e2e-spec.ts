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
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let api: NestExpressApplication;
  const services: INestApplicationContext[] = [];
  let receiverServer: Server;
  let receiverBase: string;
  // Everything that reaches the receiver, whichever path it was called on.
  const received: Received[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url);

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
    process.env.BROKER_NAMESPACE = testingNamespace();
    process.env.LANE_COUNT = '4';
    process.env.RELAY_POLL_INTERVAL_MS = '20';
    process.env.SSRF_ALLOW_HOSTS = 'localhost';

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
