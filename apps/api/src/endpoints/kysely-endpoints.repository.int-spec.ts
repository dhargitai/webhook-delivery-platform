import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, type Database, type SealedSecret } from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import { type Kysely, sql } from 'kysely';
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

  /** A well-formed sealed secret; the repository stores it and never opens it. */
  const aSealedSecret = (): SealedSecret => ({
    kekId: 'v1',
    wrappedDek: randomBytes(60),
    iv: randomBytes(12),
    ciphertext: randomBytes(50),
    tag: randomBytes(16),
  });

  it('stores an endpoint and reads it back', async () => {
    const tenantId = await createTenant();

    const created = await repo.create(
      tenantId,
      randomUUID(),
      { url: 'https://hooks.acme.test/in', description: 'billing' },
      aSealedSecret(),
    );
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

  describe('signing secret', () => {
    it('stores the endpoint under its id with the sealed secret it is given, and no plaintext', async () => {
      const tenantId = await createTenant();
      const id = randomUUID();
      const sealed = aSealedSecret();

      const endpoint = await repo.create(tenantId, id, input, sealed);

      expect(endpoint.id).toBe(id);
      const row = await db
        .selectFrom('endpoints')
        .select([
          'signing_secret',
          'secret_kek_id',
          'secret_wrapped_dek',
          'secret_iv',
          'secret_ciphertext',
          'secret_tag',
        ])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        signing_secret: null,
        secret_kek_id: sealed.kekId,
        secret_wrapped_dek: sealed.wrappedDek,
        secret_iv: sealed.iv,
        secret_ciphertext: sealed.ciphertext,
        secret_tag: sealed.tag,
      });
    });

    it('never returns the sealed secret when reading', async () => {
      const tenantId = await createTenant();
      const sealed = aSealedSecret();
      const created = await repo.create(tenantId, randomUUID(), input, sealed);

      const found = await repo.find(tenantId, created.id);
      const listed = await repo.list(tenantId);

      for (const endpoint of [created, found, ...listed]) {
        const text = JSON.stringify(endpoint);
        expect(text).not.toContain(sealed.ciphertext.toString('base64'));
        expect(endpoint).not.toHaveProperty('secret_ciphertext');
        expect(endpoint).not.toHaveProperty('signingSecret');
      }
    });
  });

  describe('rotateSecret', () => {
    const DAY_SECONDS = 86_400;

    /** The current and previous sealed columns, and the end of the overlap. */
    const secretColumns = (id: string) =>
      db
        .selectFrom('endpoints')
        .select([
          'secret_kek_id',
          'secret_wrapped_dek',
          'secret_iv',
          'secret_ciphertext',
          'secret_tag',
          'previous_secret_kek_id',
          'previous_secret_wrapped_dek',
          'previous_secret_iv',
          'previous_secret_ciphertext',
          'previous_secret_tag',
          'previous_secret_expires_at',
        ])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

    const dbNow = async (): Promise<Date> => {
      const { rows } = await sql<{
        now: Date;
      }>`select now() as now`.execute(db);
      return rows[0]?.now ?? new Date(Number.NaN);
    };

    async function endpointWith(sealed: SealedSecret) {
      const tenantId = await createTenant();
      const id = randomUUID();
      await repo.create(tenantId, id, input, sealed);
      return { tenantId, id };
    }

    it('keeps the current secret as the previous one and stores the new one', async () => {
      const old = aSealedSecret();
      const next = aSealedSecret();
      const { tenantId, id } = await endpointWith(old);

      const result = await repo.rotateSecret(tenantId, id, next, DAY_SECONDS);

      expect(result.kind).toBe('rotated');
      expect(await secretColumns(id)).toMatchObject({
        secret_kek_id: next.kekId,
        secret_wrapped_dek: next.wrappedDek,
        secret_iv: next.iv,
        secret_ciphertext: next.ciphertext,
        secret_tag: next.tag,
        previous_secret_kek_id: old.kekId,
        previous_secret_wrapped_dek: old.wrappedDek,
        previous_secret_iv: old.iv,
        previous_secret_ciphertext: old.ciphertext,
        previous_secret_tag: old.tag,
      });
    });

    it('ends the overlap after the given time, by the database clock, and reports when', async () => {
      const { tenantId, id } = await endpointWith(aSealedSecret());

      const result = await repo.rotateSecret(
        tenantId,
        id,
        aSealedSecret(),
        DAY_SECONDS,
      );
      const now = await dbNow();

      const { previous_secret_expires_at: stored } = await secretColumns(id);
      expect(result).toEqual({ kind: 'rotated', previousExpiresAt: stored });
      const expected = now.getTime() + DAY_SECONDS * 1000;
      expect(Math.abs((stored?.getTime() ?? 0) - expected)).toBeLessThan(5_000);
    });

    it('refuses a second rotation while the overlap lasts, and changes nothing', async () => {
      const { tenantId, id } = await endpointWith(aSealedSecret());
      await repo.rotateSecret(tenantId, id, aSealedSecret(), DAY_SECONDS);
      const before = await secretColumns(id);

      const result = await repo.rotateSecret(
        tenantId,
        id,
        aSealedSecret(),
        DAY_SECONDS,
      );

      expect(result).toEqual({
        kind: 'in_progress',
        until: before.previous_secret_expires_at,
      });
      expect(await secretColumns(id)).toEqual(before);
    });

    it('rotates again once the overlap has ended', async () => {
      const second = aSealedSecret();
      const { tenantId, id } = await endpointWith(aSealedSecret());
      await repo.rotateSecret(tenantId, id, second, DAY_SECONDS);
      await db
        .updateTable('endpoints')
        .set({
          previous_secret_expires_at: sql<Date>`now() - interval '1 second'`,
        })
        .where('id', '=', id)
        .execute();

      const result = await repo.rotateSecret(
        tenantId,
        id,
        aSealedSecret(),
        DAY_SECONDS,
      );

      expect(result.kind).toBe('rotated');
      expect((await secretColumns(id)).previous_secret_iv).toEqual(second.iv);
    });

    it("reports not found for an unknown id or another tenant's endpoint, and changes nothing", async () => {
      const { id } = await endpointWith(aSealedSecret());
      const other = await createTenant();
      const before = await secretColumns(id);

      expect(
        await repo.rotateSecret(other, id, aSealedSecret(), DAY_SECONDS),
      ).toEqual({ kind: 'not_found' });
      expect(
        await repo.rotateSecret(
          other,
          randomUUID(),
          aSealedSecret(),
          DAY_SECONDS,
        ),
      ).toEqual({ kind: 'not_found' });
      expect(await secretColumns(id)).toEqual(before);
    });
  });

  describe('tenant scoping', () => {
    it('hides an endpoint from every other tenant', async () => {
      const owner = await createTenant();
      const other = await createTenant();
      const endpoint = await repo.create(
        owner,
        randomUUID(),
        input,
        aSealedSecret(),
      );

      expect(await repo.find(other, endpoint.id)).toBeNull();
      expect(await repo.list(other)).toEqual([]);
      expect(await repo.listSubscriptions(other, endpoint.id)).toBeNull();
    });

    it("refuses to delete or change another tenant's endpoint", async () => {
      const owner = await createTenant();
      const other = await createTenant();
      const endpoint = await repo.create(
        owner,
        randomUUID(),
        input,
        aSealedSecret(),
      );
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
      const first = await repo.create(
        tenantId,
        randomUUID(),
        input,
        aSealedSecret(),
      );
      const second = await repo.create(
        tenantId,
        randomUUID(),
        input,
        aSealedSecret(),
      );
      const third = await repo.create(
        tenantId,
        randomUUID(),
        input,
        aSealedSecret(),
      );

      const listed = await repo.list(tenantId);

      expect(listed.map((e) => e.id)).toEqual([first.id, second.id, third.id]);
    });
  });

  describe('delete', () => {
    it('removes the endpoint and its subscriptions', async () => {
      const tenantId = await createTenant();
      const endpoint = await repo.create(
        tenantId,
        randomUUID(),
        input,
        aSealedSecret(),
      );
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
      const endpoint = await repo.create(
        tenantId,
        randomUUID(),
        input,
        aSealedSecret(),
      );
      await repo.replaceSubscriptions(tenantId, endpoint.id, ['a', 'b']);

      await repo.replaceSubscriptions(tenantId, endpoint.id, ['d', 'c']);

      expect(await repo.listSubscriptions(tenantId, endpoint.id)).toEqual([
        'c',
        'd',
      ]);
    });

    it('is idempotent', async () => {
      const tenantId = await createTenant();
      const endpoint = await repo.create(
        tenantId,
        randomUUID(),
        input,
        aSealedSecret(),
      );

      await repo.replaceSubscriptions(tenantId, endpoint.id, ['a', 'b']);
      await repo.replaceSubscriptions(tenantId, endpoint.id, ['a', 'b']);

      expect(await repo.listSubscriptions(tenantId, endpoint.id)).toEqual([
        'a',
        'b',
      ]);
    });

    it('clears the set when given an empty list', async () => {
      const tenantId = await createTenant();
      const endpoint = await repo.create(
        tenantId,
        randomUUID(),
        input,
        aSealedSecret(),
      );
      await repo.replaceSubscriptions(tenantId, endpoint.id, ['a']);

      await repo.replaceSubscriptions(tenantId, endpoint.id, []);

      expect(await repo.listSubscriptions(tenantId, endpoint.id)).toEqual([]);
    });

    it("stamps every subscription with the endpoint's tenant", async () => {
      const tenantId = await createTenant();
      const endpoint = await repo.create(
        tenantId,
        randomUUID(),
        input,
        aSealedSecret(),
      );

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
      const endpoint = await repo.create(
        tenantId,
        randomUUID(),
        input,
        aSealedSecret(),
      );
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
      const endpoint = await repo.create(
        tenantId,
        randomUUID(),
        input,
        aSealedSecret(),
      );

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
