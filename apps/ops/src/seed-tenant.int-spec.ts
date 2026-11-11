import { randomUUID } from 'node:crypto';
import {
  createDatabase,
  type Database,
  parseApiKey,
  verifyApiKey,
} from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { seedTenant } from './seed-tenant.js';

describe('seedTenant (real Postgres)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url);
  });

  afterAll(async () => {
    await db.destroy();
    await testDb.drop();
  });

  const name = () => `seed-${randomUUID()}`;

  const keysOf = (tenantId: string) =>
    db
      .selectFrom('api_keys')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at')
      .execute();

  it('creates the tenant and an API key that matches what was stored', async () => {
    const tenantName = name();

    const result = await seedTenant(db, { tenantName });

    expect(result.created).toBe(true);
    const tenant = await db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', result.tenantId)
      .executeTakeFirstOrThrow();
    expect(tenant.name).toBe(tenantName);
    const [stored] = await keysOf(result.tenantId);
    expect(stored?.prefix).toBe(parseApiKey(result.apiKey)?.prefix);
    expect(verifyApiKey(result.apiKey, stored?.key_hash ?? '')).toBe(true);
  });

  it('stores only the hash, never the key itself', async () => {
    const result = await seedTenant(db, { tenantName: name() });

    const [stored] = await keysOf(result.tenantId);
    expect(Object.values(stored ?? {}).map(String)).not.toContain(
      result.apiKey,
    );
    expect(JSON.stringify(stored)).not.toContain(result.apiKey);
  });

  it('reuses the tenant when run again with the same name', async () => {
    const tenantName = name();

    const first = await seedTenant(db, { tenantName });
    const second = await seedTenant(db, { tenantName });

    expect(second.tenantId).toBe(first.tenantId);
    expect(second.created).toBe(false);
    const tenants = await db
      .selectFrom('tenants')
      .select('id')
      .where('name', '=', tenantName)
      .execute();
    expect(tenants).toHaveLength(1);
  });

  it('issues a new key each run and leaves earlier keys valid', async () => {
    const tenantName = name();

    const first = await seedTenant(db, { tenantName });
    const second = await seedTenant(db, { tenantName });

    expect(second.apiKey).not.toBe(first.apiKey);
    const stored = await keysOf(first.tenantId);
    expect(stored).toHaveLength(2);
    for (const { apiKey } of [first, second]) {
      expect(stored.some((row) => verifyApiKey(apiKey, row.key_hash))).toBe(
        true,
      );
    }
  });

  it('gives different names different tenants', async () => {
    const a = await seedTenant(db, { tenantName: name() });
    const b = await seedTenant(db, { tenantName: name() });

    expect(a.tenantId).not.toBe(b.tenantId);
  });
});
