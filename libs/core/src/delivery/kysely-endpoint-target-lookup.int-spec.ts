import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, type Database } from '../db/database.js';
import { generateEndpointSecret } from '../endpoint-secret.js';
import type { SealedSecret, SecretOpener } from '../secrets/secret-cipher.js';
import {
  sealedSecretColumns,
  testCipher,
  testKek,
} from '../testing/sealed-secret.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../testing/test-database.js';
import { KyselyEndpointTargetLookup } from './kysely-endpoint-target-lookup.js';

/** Opens with the real cipher and remembers what it was asked. */
class RecordingOpener implements SecretOpener {
  readonly calls: { sealed: SealedSecret; aad: string }[] = [];
  constructor(private readonly inner: SecretOpener) {}
  open(sealed: SealedSecret, aad: string): Promise<string> {
    this.calls.push({ sealed, aad });
    return this.inner.open(sealed, aad);
  }
}

describe('KyselyEndpointTargetLookup (real Postgres)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let lookup: KyselyEndpointTargetLookup;
  const cipher = testCipher(testKek());
  const opener = new RecordingOpener(cipher);

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url);
    lookup = new KyselyEndpointTargetLookup(db, opener);
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
      ratePerSecond = null,
      burst = null,
    }: {
      url?: string;
      secret?: string;
      status?: 'active' | 'disabled';
      ratePerSecond?: number | null;
      burst?: number | null;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('endpoints')
      .values({
        id,
        tenant_id: tenantId,
        url,
        ...(await sealedSecretColumns(cipher, tenantId, id, secret)),
        status,
        rate_per_second: ratePerSecond,
        burst,
      })
      .execute();
    return id;
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
      // No override stored: the limiter's defaults apply.
      rate: {},
    });
  });

  it('opens the sealed secret with the opener, bound to the tenant and endpoint', async () => {
    const tenantId = await createTenant();
    const id = await addEndpoint(tenantId);
    opener.calls.length = 0;

    await lookup.find(tenantId, id);

    expect(opener.calls).toHaveLength(1);
    expect(opener.calls[0]?.aad).toBe(
      `wdp:endpoint-secret:v1:${tenantId}:${id}`,
    );
  });

  it('refuses a sealed secret copied from another endpoint', async () => {
    const tenantId = await createTenant();
    const source = await addEndpoint(tenantId);
    const target = await addEndpoint(tenantId);
    const sealed = await db
      .selectFrom('endpoints')
      .select([
        'secret_kek_id',
        'secret_wrapped_dek',
        'secret_iv',
        'secret_ciphertext',
        'secret_tag',
      ])
      .where('id', '=', source)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('endpoints')
      .set(sealed)
      .where('id', '=', target)
      .execute();

    await expect(lookup.find(tenantId, target)).rejects.toThrow();
  });

  it('refuses an endpoint whose secret is still in plaintext', async () => {
    const tenantId = await createTenant();
    const row = await db
      .insertInto('endpoints')
      .values({
        tenant_id: tenantId,
        url: 'https://hooks.acme.test/in',
        signing_secret: generateEndpointSecret(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await expect(lookup.find(tenantId, row.id)).rejects.toThrow(/sealed/);
  });

  it('returns the endpoint’s stored rate override', async () => {
    const tenantId = await createTenant();
    const id = await addEndpoint(tenantId, { ratePerSecond: 2.5, burst: 10 });

    expect((await lookup.find(tenantId, id))?.rate).toEqual({
      ratePerSecond: 2.5,
      burst: 10,
    });
  });

  it('leaves an unset part of the override out, rather than undefined', async () => {
    const tenantId = await createTenant();
    const id = await addEndpoint(tenantId, { burst: 3 });

    const rate = (await lookup.find(tenantId, id))?.rate;

    expect(rate).toEqual({ burst: 3 });
    // The limiter rejects a present `undefined`, which toEqual would not see.
    expect(rate !== undefined && 'ratePerSecond' in rate).toBe(false);
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
