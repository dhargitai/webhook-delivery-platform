import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, type Database } from '../db/database.js';
import { generateEndpointSecret } from '../endpoint-secret.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../testing/test-database.js';
import { KyselyEndpointTargetLookup } from './kysely-endpoint-target-lookup.js';

describe('KyselyEndpointTargetLookup (real Postgres)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let lookup: KyselyEndpointTargetLookup;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url);
    lookup = new KyselyEndpointTargetLookup(db);
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

  async function addEndpoint(
    tenantId: string,
    {
      url = 'https://hooks.acme.test/in',
      secret = generateEndpointSecret(),
      status = 'active',
    }: {
      url?: string;
      secret?: string;
      status?: 'active' | 'disabled';
    } = {},
  ): Promise<string> {
    const row = await db
      .insertInto('endpoints')
      .values({
        tenant_id: tenantId,
        url,
        signing_secret: secret,
        status,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  it('returns the url, the signing secret and the status of an endpoint', async () => {
    const tenantId = await createTenant();
    const secret = generateEndpointSecret();
    const id = await addEndpoint(tenantId, {
      url: 'https://hooks.acme.test/exact',
      secret,
    });

    expect(await lookup.find(tenantId, id)).toEqual({
      url: 'https://hooks.acme.test/exact',
      signingSecret: secret,
      status: 'active',
    });
  });

  it('keeps each endpoint’s own secret apart', async () => {
    const tenantId = await createTenant();
    const first = await addEndpoint(tenantId);
    const second = await addEndpoint(tenantId);

    const a = await lookup.find(tenantId, first);
    const b = await lookup.find(tenantId, second);

    expect(a?.signingSecret).not.toEqual(b?.signingSecret);
  });

  it('returns a disabled endpoint as disabled, so the caller can skip it', async () => {
    const tenantId = await createTenant();
    const id = await addEndpoint(tenantId, { status: 'disabled' });

    expect((await lookup.find(tenantId, id))?.status).toBe('disabled');
  });

  it('returns null for an unknown endpoint', async () => {
    const tenantId = await createTenant();

    expect(await lookup.find(tenantId, randomUUID())).toBeNull();
  });

  it('returns null for another tenant’s endpoint, so a secret never crosses tenants', async () => {
    const mine = await createTenant();
    const theirs = await createTenant();
    const theirEndpoint = await addEndpoint(theirs);

    expect(await lookup.find(mine, theirEndpoint)).toBeNull();
  });

  it('returns null once the endpoint is deleted', async () => {
    const tenantId = await createTenant();
    const id = await addEndpoint(tenantId);
    await db.deleteFrom('endpoints').where('id', '=', id).execute();

    expect(await lookup.find(tenantId, id)).toBeNull();
  });
});
