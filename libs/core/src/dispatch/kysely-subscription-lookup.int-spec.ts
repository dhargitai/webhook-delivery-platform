import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, type Database } from '../db/database.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../testing/test-database.js';
import { KyselySubscriptionLookup } from './kysely-subscription-lookup.js';

describe('KyselySubscriptionLookup (real Postgres)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let lookup: KyselySubscriptionLookup;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url);
    lookup = new KyselySubscriptionLookup(db);
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

  /** Creates an endpoint subscribed to the given event types. */
  async function addEndpoint(
    tenantId: string,
    eventTypes: string[],
    { status = 'active' }: { status?: 'active' | 'disabled' } = {},
  ): Promise<string> {
    const endpoint = await db
      .insertInto('endpoints')
      .values({
        tenant_id: tenantId,
        url: 'https://hooks.acme.test/in',
        status,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (eventTypes.length > 0) {
      await db
        .insertInto('subscriptions')
        .values(
          eventTypes.map((event_type) => ({
            tenant_id: tenantId,
            endpoint_id: endpoint.id,
            event_type,
          })),
        )
        .execute();
    }
    return endpoint.id;
  }

  it('returns the active endpoints subscribed to the event type', async () => {
    const tenantId = await createTenant();
    const a = await addEndpoint(tenantId, ['invoice.paid']);
    const b = await addEndpoint(tenantId, ['invoice.paid', 'invoice.failed']);

    const found = await lookup.findActiveEndpointIds(tenantId, 'invoice.paid');

    expect(found).toEqual([a, b]);
  });

  it('returns endpoints in the order they were registered', async () => {
    const tenantId = await createTenant();
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await addEndpoint(tenantId, ['t']));
    }

    expect(await lookup.findActiveEndpointIds(tenantId, 't')).toEqual(ids);
  });

  it('skips endpoints subscribed to other event types', async () => {
    const tenantId = await createTenant();
    const wanted = await addEndpoint(tenantId, ['invoice.paid']);
    await addEndpoint(tenantId, ['card.moved']);
    await addEndpoint(tenantId, []);

    expect(
      await lookup.findActiveEndpointIds(tenantId, 'invoice.paid'),
    ).toEqual([wanted]);
  });

  it('never returns another tenant’s endpoints, even for the same event type', async () => {
    const mine = await createTenant();
    const theirs = await createTenant();
    const own = await addEndpoint(mine, ['invoice.paid']);
    await addEndpoint(theirs, ['invoice.paid']);

    expect(await lookup.findActiveEndpointIds(mine, 'invoice.paid')).toEqual([
      own,
    ]);
  });

  it('skips disabled endpoints', async () => {
    const tenantId = await createTenant();
    const active = await addEndpoint(tenantId, ['t']);
    await addEndpoint(tenantId, ['t'], { status: 'disabled' });

    expect(await lookup.findActiveEndpointIds(tenantId, 't')).toEqual([active]);
  });

  it('returns nothing when no endpoint is subscribed', async () => {
    const tenantId = await createTenant();

    expect(
      await lookup.findActiveEndpointIds(tenantId, 'nobody.cares'),
    ).toEqual([]);
  });

  it('stops returning an endpoint once its subscription is removed', async () => {
    const tenantId = await createTenant();
    const id = await addEndpoint(tenantId, ['t']);
    await db
      .deleteFrom('subscriptions')
      .where('endpoint_id', '=', id)
      .execute();

    expect(await lookup.findActiveEndpointIds(tenantId, 't')).toEqual([]);
  });

  it('sees an endpoint registered after earlier lookups, so late subscribers get later events', async () => {
    const tenantId = await createTenant();
    expect(await lookup.findActiveEndpointIds(tenantId, 't')).toEqual([]);

    const late = await addEndpoint(tenantId, ['t']);

    expect(await lookup.findActiveEndpointIds(tenantId, 't')).toEqual([late]);
  });
});
