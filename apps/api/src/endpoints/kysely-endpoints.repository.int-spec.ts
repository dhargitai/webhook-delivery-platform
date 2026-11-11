import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { KyselyEndpointsRepository } from './kysely-endpoints.repository.js';

describe('KyselyEndpointsRepository (real Postgres)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let repo: KyselyEndpointsRepository;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    // More connections than the concurrent replaces below, so they really overlap.
    db = createDatabase(testDb.url, { maxConnections: 20 });
    repo = new KyselyEndpointsRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
    await testDb.drop();
  });

  async function createTenant(): Promise<string> {
    const row = await db
      .insertInto('tenants')
      .values({ name: `tenant-${randomUUID()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const input = { url: 'https://hooks.acme.test/in', description: null };

  it('stores an endpoint and reads it back', async () => {
    const tenantId = await createTenant();

    const created = await repo.create(tenantId, {
      url: 'https://hooks.acme.test/in',
      description: 'billing',
    });
    const found = await repo.find(tenantId, created.id);

    expect(found).toEqual(created);
    expect(created).toMatchObject({
      tenantId,
      url: 'https://hooks.acme.test/in',
      description: 'billing',
      status: 'active',
    });
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  describe('tenant scoping', () => {
    it('hides an endpoint from every other tenant', async () => {
      const owner = await createTenant();
      const other = await createTenant();
      const endpoint = await repo.create(owner, input);

      expect(await repo.find(other, endpoint.id)).toBeNull();
      expect(await repo.list(other)).toEqual([]);
      expect(await repo.listSubscriptions(other, endpoint.id)).toBeNull();
    });

    it("refuses to delete or change another tenant's endpoint", async () => {
      const owner = await createTenant();
      const other = await createTenant();
      const endpoint = await repo.create(owner, input);
      await repo.replaceSubscriptions(owner, endpoint.id, ['invoice.paid']);

      expect(await repo.delete(other, endpoint.id)).toBe(false);
      expect(await repo.replaceSubscriptions(other, endpoint.id, ['x'])).toBe(
        false,
      );

      expect(await repo.find(owner, endpoint.id)).not.toBeNull();
      expect(await repo.listSubscriptions(owner, endpoint.id)).toEqual([
        'invoice.paid',
      ]);
    });

    it('lists a tenant’s endpoints in creation order', async () => {
      const tenantId = await createTenant();
      const first = await repo.create(tenantId, input);
      const second = await repo.create(tenantId, input);
      const third = await repo.create(tenantId, input);

      const listed = await repo.list(tenantId);

      expect(listed.map((e) => e.id)).toEqual([first.id, second.id, third.id]);
    });
  });

  describe('delete', () => {
    it('removes the endpoint and its subscriptions', async () => {
      const tenantId = await createTenant();
      const endpoint = await repo.create(tenantId, input);
      await repo.replaceSubscriptions(tenantId, endpoint.id, ['a', 'b']);

      expect(await repo.delete(tenantId, endpoint.id)).toBe(true);

      expect(await repo.find(tenantId, endpoint.id)).toBeNull();
      const orphans = await db
        .selectFrom('subscriptions')
        .select('id')
        .where('endpoint_id', '=', endpoint.id)
        .execute();
      expect(orphans).toEqual([]);
    });

    it('reports false for an endpoint that does not exist', async () => {
      const tenantId = await createTenant();

      expect(await repo.delete(tenantId, randomUUID())).toBe(false);
    });
  });

  describe('replaceSubscriptions', () => {
    it('replaces the previous set and lists it sorted', async () => {
      const tenantId = await createTenant();
      const endpoint = await repo.create(tenantId, input);
      await repo.replaceSubscriptions(tenantId, endpoint.id, ['a', 'b']);

      await repo.replaceSubscriptions(tenantId, endpoint.id, ['d', 'c']);

      expect(await repo.listSubscriptions(tenantId, endpoint.id)).toEqual([
        'c',
        'd',
      ]);
    });

    it('is idempotent', async () => {
      const tenantId = await createTenant();
      const endpoint = await repo.create(tenantId, input);

      await repo.replaceSubscriptions(tenantId, endpoint.id, ['a', 'b']);
      await repo.replaceSubscriptions(tenantId, endpoint.id, ['a', 'b']);

      expect(await repo.listSubscriptions(tenantId, endpoint.id)).toEqual([
        'a',
        'b',
      ]);
    });

    it('clears the set when given an empty list', async () => {
      const tenantId = await createTenant();
      const endpoint = await repo.create(tenantId, input);
      await repo.replaceSubscriptions(tenantId, endpoint.id, ['a']);

      await repo.replaceSubscriptions(tenantId, endpoint.id, []);

      expect(await repo.listSubscriptions(tenantId, endpoint.id)).toEqual([]);
    });

    it("stamps every subscription with the endpoint's tenant", async () => {
      const tenantId = await createTenant();
      const endpoint = await repo.create(tenantId, input);

      await repo.replaceSubscriptions(tenantId, endpoint.id, ['a', 'b']);

      const rows = await db
        .selectFrom('subscriptions')
        .select('tenant_id')
        .where('endpoint_id', '=', endpoint.id)
        .execute();
      expect(rows.map((r) => r.tenant_id)).toEqual([tenantId, tenantId]);
    });

    it('leaves the old set untouched when the new one cannot be stored', async () => {
      const tenantId = await createTenant();
      const endpoint = await repo.create(tenantId, input);
      await repo.replaceSubscriptions(tenantId, endpoint.id, [
        'keep-1',
        'keep-2',
      ]);

      // A duplicate breaks UNIQUE (endpoint_id, event_type) after the old rows
      // were already deleted inside the transaction.
      await expect(
        repo.replaceSubscriptions(tenantId, endpoint.id, ['x', 'x']),
      ).rejects.toThrow();

      expect(await repo.listSubscriptions(tenantId, endpoint.id)).toEqual([
        'keep-1',
        'keep-2',
      ]);
    });

    it('survives concurrent replaces of the same endpoint', async () => {
      const tenantId = await createTenant();
      const endpoint = await repo.create(tenantId, input);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          repo.replaceSubscriptions(tenantId, endpoint.id, ['a', 'b']),
        ),
      );

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await repo.listSubscriptions(tenantId, endpoint.id)).toEqual([
        'a',
        'b',
      ]);
    });
  });
});
