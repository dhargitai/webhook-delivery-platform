import { randomUUID } from 'node:crypto';
import { IdempotencyConflictError } from '@wdp/domain';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { IdempotentIngest } from '../idempotent-ingest.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../testing/test-database.js';
import { UuidV7EventIdGenerator } from '../uuid-event-id-generator.js';
import { createDatabase, type Database } from './database.js';
import { KyselyEventStore } from './kysely-event-store.js';

describe('KyselyEventStore (real Postgres)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let ingest: IdempotentIngest;

  /** Inserts a tenant directly, so events have a valid owner. */
  async function createTenant(): Promise<string> {
    const row = await db
      .insertInto('tenants')
      .values({ name: `tenant-${randomUUID()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const countEvents = async (tenantId: string) =>
    Number(
      (
        await db
          .selectFrom('events')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('tenant_id', '=', tenantId)
          .executeTakeFirstOrThrow()
      ).n,
    );

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    // Enough connections for the concurrency test to truly race.
    db = createDatabase(testDb.url, { maxConnections: 50 });
    ingest = new IdempotentIngest(
      new KyselyEventStore(db),
      new UuidV7EventIdGenerator(),
    );
  });

  afterAll(async () => {
    await db.destroy();
    await testDb.drop();
  });

  const request = { type: 'invoice.paid', payload: { invoice: 'INV-42' } };

  it('stores one row and one event id when 50 identical requests race', async () => {
    const tenantId = await createTenant();

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        ingest.accept(tenantId, 'same-key', request),
      ),
    );

    expect(await countEvents(tenantId)).toBe(1);
    expect(new Set(results.map((r) => r.eventId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('rejects the same key with a different body and keeps the original row', async () => {
    const tenantId = await createTenant();
    const first = await ingest.accept(tenantId, 'key-1', request);

    await expect(
      ingest.accept(tenantId, 'key-1', {
        type: 'invoice.paid',
        payload: { invoice: 'INV-43' },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(await countEvents(tenantId)).toBe(1);
    const row = await db
      .selectFrom('events')
      .select(['event_id', 'payload'])
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    expect(row.event_id).toBe(first.eventId);
    expect(row.payload).toEqual({ invoice: 'INV-42' });
  });

  it('creates separate events for requests without a key', async () => {
    const tenantId = await createTenant();

    const first = await ingest.accept(tenantId, null, request);
    const second = await ingest.accept(tenantId, null, request);

    expect(first.eventId).not.toBe(second.eventId);
    expect(await countEvents(tenantId)).toBe(2);
  });

  it('keeps the same key separate per tenant', async () => {
    const a = await createTenant();
    const b = await createTenant();

    const first = await ingest.accept(a, 'shared-key', request);
    const second = await ingest.accept(b, 'shared-key', request);

    expect(second.created).toBe(true);
    expect(second.eventId).not.toBe(first.eventId);
  });

  it.each([
    { name: 'an array', payload: [1, { a: 2 }, 'three'] },
    { name: 'a nested object', payload: { a: { b: [1, 2, { c: null }] } } },
    { name: 'a string', payload: 'just a string' },
  ])('stores $name payload as the same JSON', async ({ payload }) => {
    const tenantId = await createTenant();

    await ingest.accept(tenantId, null, { type: 't', payload });

    const row = await db
      .selectFrom('events')
      .select('payload')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    expect(row.payload).toEqual(payload);
  });

  it('stores new events as unpublished', async () => {
    const tenantId = await createTenant();

    await ingest.accept(tenantId, null, request);

    const row = await db
      .selectFrom('events')
      .select('published_at')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    expect(row.published_at).toBeNull();
  });
});
