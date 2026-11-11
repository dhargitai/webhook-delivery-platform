import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createDatabase, generateApiKey, type Database } from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const PROBLEM_JSON = /^application\/problem\+json/;

describe('POST /v1/events (e2e)', () => {
  let testDb: TestDatabase;
  let app: NestExpressApplication;
  let db: Kysely<Database>;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    // The config module validates the environment while app.module.ts is
    // evaluated, so the variables must exist before that import.
    process.env.DATABASE_URL = testDb.url;
    process.env.REDIS_URL = inject('redisUrl');
    process.env.INGEST_RATE_PER_SECOND = '1';
    process.env.INGEST_BURST = '5';

    const { AppModule } = await import('../src/app.module.js');
    const { configureApp } = await import('../src/configure-app.js');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();

    db = createDatabase(testDb.url);
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await testDb.drop();
  });

  /** A fresh tenant with its own API key, so rate limit buckets never overlap. */
  async function seedTenant() {
    const tenant = await db
      .insertInto('tenants')
      .values({ name: `tenant-${Math.random()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    const { key, prefix, hash } = generateApiKey();
    await db
      .insertInto('api_keys')
      .values({ tenant_id: tenant.id, prefix, key_hash: hash })
      .execute();
    return { tenantId: tenant.id, key };
  }

  const post = (key: string | null, body: unknown, idempotencyKey?: string) => {
    const req = request(app.getHttpServer()).post('/v1/events');
    if (key !== null) req.set('Authorization', `Bearer ${key}`);
    if (idempotencyKey !== undefined)
      req.set('Idempotency-Key', idempotencyKey);
    return req.send(body as object);
  };

  const invoice = { type: 'invoice.paid', payload: { invoice: 'INV-42' } };

  describe('authentication', () => {
    it('rejects a request without an API key as problem+json', async () => {
      const res = await post(null, invoice);

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({ status: 401 });
    });

    it('rejects an API key that was never issued', async () => {
      const res = await post(generateApiKey().key, invoice);

      expect(res.status).toBe(401);
    });

    it('rejects a revoked API key', async () => {
      const { tenantId } = await seedTenant();
      const { key, prefix, hash } = generateApiKey();
      await db
        .insertInto('api_keys')
        .values({
          tenant_id: tenantId,
          prefix,
          key_hash: hash,
          revoked_at: new Date(),
        })
        .execute();

      const res = await post(key, invoice);

      expect(res.status).toBe(401);
    });
  });

  describe('accepting an event', () => {
    it('answers 202 with an event id and stores one unpublished event for the tenant', async () => {
      const { tenantId, key } = await seedTenant();

      const res = await post(key, invoice);

      expect(res.status).toBe(202);
      expect(res.body.event_id).toMatch(/^[0-9a-f-]{36}$/);
      const row = await db
        .selectFrom('events')
        .selectAll()
        .where('event_id', '=', res.body.event_id)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        tenant_id: tenantId,
        event_type: 'invoice.paid',
        payload: { invoice: 'INV-42' },
        idempotency_key: null,
        published_at: null,
      });
    });

    it('returns the same event id for a repeated Idempotency-Key and stores one event', async () => {
      const { tenantId, key } = await seedTenant();

      const first = await post(key, invoice, 'retry-1');
      const second = await post(key, invoice, 'retry-1');

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.body.event_id).toBe(first.body.event_id);
      const rows = await db
        .selectFrom('events')
        .select('event_id')
        .where('tenant_id', '=', tenantId)
        .execute();
      expect(rows).toHaveLength(1);
    });

    it('answers 422 when an Idempotency-Key is reused with a different body', async () => {
      const { key } = await seedTenant();
      await post(key, invoice, 'reused');

      const res = await post(
        key,
        { type: 'invoice.paid', payload: { invoice: 'INV-43' } },
        'reused',
      );

      expect(res.status).toBe(422);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    });

    it('treats the same Idempotency-Key from two tenants as two separate events', async () => {
      const a = await seedTenant();
      const b = await seedTenant();

      const fromA = await post(a.key, invoice, 'shared');
      const fromB = await post(b.key, invoice, 'shared');

      expect(fromB.status).toBe(202);
      expect(fromB.body.event_id).not.toBe(fromA.body.event_id);
    });
  });

  describe('validation and limits', () => {
    it('answers 422 and names the invalid field', async () => {
      const { key } = await seedTenant();

      const res = await post(key, { payload: {} });

      expect(res.status).toBe(422);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body.errors).toEqual([
        expect.objectContaining({ path: 'type' }),
      ]);
    });

    it('answers 422 for an Idempotency-Key longer than 255 characters', async () => {
      const { key } = await seedTenant();

      const res = await post(key, invoice, 'k'.repeat(256));

      expect(res.status).toBe(422);
    });

    it('answers 400 for malformed JSON', async () => {
      const { key } = await seedTenant();

      const res = await request(app.getHttpServer())
        .post('/v1/events')
        .set('Authorization', `Bearer ${key}`)
        .set('Content-Type', 'application/json')
        .send('{"type": "t", "payload": ');

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    });

    it('answers 413 for a body larger than 64 KB', async () => {
      const { key } = await seedTenant();

      const res = await post(key, {
        type: 't',
        payload: 'x'.repeat(70 * 1024),
      });

      expect(res.status).toBe(413);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    });

    it('answers unknown routes with problem+json', async () => {
      const { key } = await seedTenant();

      const res = await request(app.getHttpServer())
        .get('/v1/nope')
        .set('Authorization', `Bearer ${key}`);

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    });
  });

  describe('rate limiting', () => {
    it('answers 429 with Retry-After once the burst is spent, for that tenant only', async () => {
      const noisy = await seedTenant();
      const quiet = await seedTenant();

      for (let i = 0; i < 5; i++) {
        expect((await post(noisy.key, invoice)).status).toBe(202);
      }
      const limited = await post(noisy.key, invoice);

      expect(limited.status).toBe(429);
      expect(limited.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect((await post(quiet.key, invoice)).status).toBe(202);
    });

    it('does not store a rejected event', async () => {
      const { tenantId, key } = await seedTenant();
      for (let i = 0; i < 5; i++) await post(key, invoice);

      await post(key, invoice);

      const rows = await db
        .selectFrom('events')
        .select('event_id')
        .where('tenant_id', '=', tenantId)
        .execute();
      expect(rows).toHaveLength(5);
    });
  });
});
