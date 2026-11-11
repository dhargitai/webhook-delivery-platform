import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../testing/test-database.js';
import { MIGRATIONS_DIR, migrate } from './migrate.js';

describe('database schema (real Postgres)', () => {
  let testDb: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    pool = new pg.Pool({ connectionString: testDb.url });
  });

  afterAll(async () => {
    await pool.end();
    await testDb.drop();
  });

  async function insertTenant(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [`tenant-${randomUUID()}`],
    );
    return rows[0]?.id ?? '';
  }

  async function insertEndpoint(tenantId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO endpoints (tenant_id, url, signing_secret) VALUES ($1, $2, $3) RETURNING id',
      [tenantId, 'https://hooks.acme.test/in', 'whsec_test'],
    );
    return rows[0]?.id ?? '';
  }

  const insertEvent = (tenantId: string, key: string | null) =>
    pool.query(
      `INSERT INTO events (event_id, tenant_id, idempotency_key, request_hash, event_type, payload)
       VALUES ($1, $2, $3, 'hash', 'invoice.paid', '{}')`,
      [randomUUID(), tenantId, key],
    );

  it('can be migrated again without error', async () => {
    await expect(migrate(testDb.url)).resolves.not.toThrow();
  });

  describe('events', () => {
    it('rejects a second event with the same tenant and idempotency key', async () => {
      const tenantId = await insertTenant();
      await insertEvent(tenantId, 'k');

      await expect(insertEvent(tenantId, 'k')).rejects.toMatchObject({
        code: '23505', // unique_violation
      });
    });

    it('allows many events without an idempotency key', async () => {
      const tenantId = await insertTenant();

      await insertEvent(tenantId, null);

      await expect(insertEvent(tenantId, null)).resolves.toBeDefined();
    });

    it.each([
      { name: 'empty', key: '' },
      { name: 'longer than 255 characters', key: 'k'.repeat(256) },
    ])('rejects an idempotency key that is $name', async ({ key }) => {
      const tenantId = await insertTenant();

      await expect(insertEvent(tenantId, key)).rejects.toMatchObject({
        code: '23514', // check_violation
      });
    });

    it('rejects an event for a tenant that does not exist', async () => {
      await expect(insertEvent(randomUUID(), null)).rejects.toMatchObject({
        code: '23503', // foreign_key_violation
      });
    });

    it('has a partial index covering only unpublished events', async () => {
      const { rows } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'events' AND indexname = 'events_unpublished_idx'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.indexdef).toContain('WHERE (published_at IS NULL)');
    });
  });

  describe('endpoints', () => {
    it('rejects an endpoint without a signing secret', async () => {
      const tenantId = await insertTenant();

      await expect(
        pool.query('INSERT INTO endpoints (tenant_id, url) VALUES ($1, $2)', [
          tenantId,
          'https://hooks.acme.test/in',
        ]),
      ).rejects.toMatchObject({ code: '23502' });
    });

    it('gives endpoints that predate the signing secret their own valid one', async () => {
      const adminUrl = inject('postgresAdminUrl');
      const name = `wdp_test_${randomUUID().replaceAll('-', '')}`;
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      // Only the migrations that existed before the signing secret.
      const oldDir = await mkdtemp(join(tmpdir(), 'wdp-migrations-'));
      const client = new pg.Client({ connectionString: url.toString() });
      try {
        for (const file of [
          '0001_tenants-and-api-keys.sql',
          '0002_endpoints-and-subscriptions.sql',
          '0003_events.sql',
        ]) {
          await copyFile(join(MIGRATIONS_DIR, file), join(oldDir, file));
        }
        await migrate(url.toString(), oldDir);
        await client.connect();
        const { rows: tenants } = await client.query<{ id: string }>(
          `INSERT INTO tenants (name) VALUES ('old') RETURNING id`,
        );
        for (let i = 0; i < 2; i++) {
          await client.query(
            'INSERT INTO endpoints (tenant_id, url) VALUES ($1, $2)',
            [tenants[0]?.id, 'https://hooks.acme.test/in'],
          );
        }

        await migrate(url.toString());

        const { rows } = await client.query<{ signing_secret: string }>(
          'SELECT signing_secret FROM endpoints',
        );
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.signing_secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
        }
        expect(rows[0]?.signing_secret).not.toBe(rows[1]?.signing_secret);
      } finally {
        await client.end();
        await rm(oldDir, { recursive: true, force: true });
        // Waits for the client above to be gone before dropping.
        await new Promise((resolve) => setTimeout(resolve, 100));
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });
  });

  describe('subscriptions', () => {
    it('rejects subscribing the same endpoint to the same event type twice', async () => {
      const tenantId = await insertTenant();
      const endpointId = await insertEndpoint(tenantId);
      const subscribe = () =>
        pool.query(
          'INSERT INTO subscriptions (tenant_id, endpoint_id, event_type) VALUES ($1, $2, $3)',
          [tenantId, endpointId, 'invoice.paid'],
        );
      await subscribe();

      await expect(subscribe()).rejects.toMatchObject({ code: '23505' });
    });

    it('rejects a subscription whose tenant differs from its endpoint tenant', async () => {
      const owner = await insertTenant();
      const other = await insertTenant();
      const endpointId = await insertEndpoint(owner);

      await expect(
        pool.query(
          'INSERT INTO subscriptions (tenant_id, endpoint_id, event_type) VALUES ($1, $2, $3)',
          [other, endpointId, 'invoice.paid'],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('is removed together with its endpoint', async () => {
      const tenantId = await insertTenant();
      const endpointId = await insertEndpoint(tenantId);
      await pool.query(
        'INSERT INTO subscriptions (tenant_id, endpoint_id, event_type) VALUES ($1, $2, $3)',
        [tenantId, endpointId, 'invoice.paid'],
      );

      await pool.query('DELETE FROM endpoints WHERE id = $1', [endpointId]);

      const { rows } = await pool.query(
        'SELECT 1 FROM subscriptions WHERE endpoint_id = $1',
        [endpointId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('api_keys', () => {
    it('rejects two keys with the same prefix', async () => {
      const tenantId = await insertTenant();
      const insertKey = () =>
        pool.query(
          'INSERT INTO api_keys (tenant_id, prefix, key_hash) VALUES ($1, $2, $3)',
          [tenantId, 'Ab3dEf9h', 'hash'],
        );
      await insertKey();

      await expect(insertKey()).rejects.toMatchObject({ code: '23505' });
    });
  });
});
