import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createDatabase, type Database } from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import type { Kysely } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { seedTenant } from '../apps/ops/src/seed-tenant.js';

/** What `bun run db:seed` prints has to open the door it was made for. */
describe('seeded API key (e2e)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let app: NestExpressApplication;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    // The config module validates the environment while app.module.ts is
    // evaluated, so the variables must exist before that import.
    process.env.DATABASE_URL = testDb.url;
    process.env.REDIS_URL = inject('redisUrl');
    const { AppModule } = await import('../apps/api/src/app.module.js');
    const { configureApp } = await import('../apps/api/src/configure-app.js');
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

  const post = (key: string) =>
    request(app.getHttpServer())
      .post('/v1/events')
      .set('Authorization', `Bearer ${key}`)
      .send({ type: 'invoice.paid', payload: { invoice: 'INV-1' } });

  it('authenticates against the API and the event belongs to the seeded tenant', async () => {
    const { tenantId, apiKey } = await seedTenant(db, { tenantName: 'demo' });

    const res = await post(apiKey);

    expect(res.status).toBe(202);
    const event = await db
      .selectFrom('events')
      .select('tenant_id')
      .where('event_id', '=', res.body.event_id)
      .executeTakeFirstOrThrow();
    expect(event.tenant_id).toBe(tenantId);
  });

  it('keeps an earlier key working after the seed is run again', async () => {
    const first = await seedTenant(db, { tenantName: 'again' });
    await seedTenant(db, { tenantName: 'again' });

    expect((await post(first.apiKey)).status).toBe(202);
  });
});
