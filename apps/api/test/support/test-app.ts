import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  createDatabase,
  generateApiKey,
  type Database,
  type SecretCipher,
} from '@wdp/core';
import {
  createTestDatabase,
  testCipher,
  testKek,
  type TestDatabase,
} from '@wdp/core/testing';
import type { Kysely } from 'kysely';
import { inject } from 'vitest';

export interface TestApp {
  app: NestExpressApplication;
  /** Direct database access, for seeding and for asserting on stored state. */
  db: Kysely<Database>;
  /** Built from the app's own KEK, to open what it stored. */
  cipher: SecretCipher;
  /** A fresh tenant with its own API key, so buckets and data never overlap. */
  seedTenant(): Promise<{ tenantId: string; key: string }>;
  close(): Promise<void>;
}

/**
 * Starts the real app against the shared Postgres and Redis containers, with
 * its own migrated database. `env` overrides environment variables before the
 * app module is loaded.
 */
export async function startTestApp(
  env: Record<string, string> = {},
): Promise<TestApp> {
  const testDb: TestDatabase = await createTestDatabase(
    inject('postgresAdminUrl'),
  );
  // The config module validates the environment while app.module.ts is
  // evaluated, so the variables must exist before that import.
  process.env.DATABASE_URL = testDb.url;
  process.env.REDIS_URL = inject('redisUrl');
  // A KEK of its own, unless the spec brings one.
  const kek = env.SECRETS_KEK_V1 ?? testKek();
  process.env.SECRETS_KEK_V1 = kek;
  Object.assign(process.env, env);

  const { AppModule } = await import('../../src/app.module.js');
  const { configureApp } = await import('../../src/configure-app.js');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();

  const db = createDatabase(testDb.url);

  return {
    app,
    db,
    cipher: testCipher(kek),
    async seedTenant() {
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
    },
    async close() {
      await app.close();
      await db.destroy();
      await testDb.drop();
    },
  };
}
