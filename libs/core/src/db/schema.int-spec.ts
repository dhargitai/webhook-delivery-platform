import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createTestDatabase,
  type TestDatabase,
} from '../testing/test-database.js';
import { migrate } from './migrate.js';

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
      'INSERT INTO endpoints (tenant_id, url) VALUES ($1, $2) RETURNING id',
      [tenantId, 'https://hooks.acme.test/in'],
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
