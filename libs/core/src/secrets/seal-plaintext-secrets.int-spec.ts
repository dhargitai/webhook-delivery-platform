import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
} from 'vitest';
import { createDatabase, type Database } from '../db/database.js';
import { generateEndpointSecret } from '../endpoint-secret.js';
import {
  createTestDatabase,
  type TestDatabase,
} from '../testing/test-database.js';
import { EnvKeyProvider } from './env-key-provider.js';
import { sealPlaintextSecrets } from './seal-plaintext-secrets.js';
import { type SealedSecret, SecretCipher, secretAad } from './secret-cipher.js';

describe('sealPlaintextSecrets (real Postgres)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let tenantId: string;
  const cipher = new SecretCipher(
    new EnvKeyProvider({ kekId: 'v1', key: randomBytes(32) }),
  );

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url, { maxConnections: 10 });
    const tenant = await db
      .insertInto('tenants')
      .values({ name: 'seal-tests' })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;
  });

  beforeEach(async () => {
    // The backfill reads every tenant's endpoints, so each test starts from none.
    await db.deleteFrom('endpoints').execute();
  });

  afterAll(async () => {
    await db.destroy();
    await testDb.drop();
  });

  /** Adds `count` endpoints with a plaintext secret, as before Task 22. */
  async function addPlaintext(
    count: number,
  ): Promise<{ id: string; secret: string }[]> {
    const rows = Array.from({ length: count }, () => ({
      tenant_id: tenantId,
      url: 'https://hooks.acme.test/in',
      signing_secret: generateEndpointSecret(),
    }));
    const inserted = await db
      .insertInto('endpoints')
      .values(rows)
      .returning(['id', 'signing_secret'])
      .execute();
    return inserted.map((row) => ({
      id: row.id,
      secret: row.signing_secret ?? '',
    }));
  }

  async function storedSecret(id: string) {
    return db
      .selectFrom('endpoints')
      .select([
        'tenant_id',
        'signing_secret',
        'secret_kek_id',
        'secret_wrapped_dek',
        'secret_iv',
        'secret_ciphertext',
        'secret_tag',
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  function asSealed(row: Awaited<ReturnType<typeof storedSecret>>) {
    const {
      secret_kek_id,
      secret_wrapped_dek,
      secret_iv,
      secret_ciphertext,
      secret_tag,
    } = row;
    if (
      secret_kek_id === null ||
      secret_wrapped_dek === null ||
      secret_iv === null ||
      secret_ciphertext === null ||
      secret_tag === null
    ) {
      throw new Error('the row holds no sealed secret');
    }
    return {
      kekId: secret_kek_id,
      wrappedDek: secret_wrapped_dek,
      iv: secret_iv,
      ciphertext: secret_ciphertext,
      tag: secret_tag,
    } satisfies SealedSecret;
  }

  it('seals every plaintext secret in place, bound to its own endpoint', async () => {
    const endpoints = await addPlaintext(3);

    await expect(sealPlaintextSecrets(db, cipher)).resolves.toBe(3);

    for (const { id, secret } of endpoints) {
      const row = await storedSecret(id);
      expect(row.signing_secret).toBeNull();
      await expect(
        cipher.open(asSealed(row), secretAad(tenantId, id)),
      ).resolves.toBe(secret);
    }
    const [first, second] = endpoints;
    const firstRow = await storedSecret(first?.id ?? '');
    await expect(
      cipher.open(asSealed(firstRow), secretAad(tenantId, second?.id ?? '')),
    ).rejects.toThrow();
  });

  it('seals nothing on a second run', async () => {
    await addPlaintext(2);
    await sealPlaintextSecrets(db, cipher);

    await expect(sealPlaintextSecrets(db, cipher)).resolves.toBe(0);
  });

  it('leaves an already sealed secret untouched', async () => {
    const [endpoint] = await addPlaintext(1);
    await sealPlaintextSecrets(db, cipher);
    const before = await storedSecret(endpoint?.id ?? '');
    await addPlaintext(1);

    await sealPlaintextSecrets(db, cipher);

    expect(await storedSecret(endpoint?.id ?? '')).toEqual(before);
  });

  it('works through more rows than one batch', async () => {
    await addPlaintext(5);

    await expect(
      sealPlaintextSecrets(db, cipher, { batchSize: 2 }),
    ).resolves.toBe(5);

    const left = await db
      .selectFrom('endpoints')
      .select('id')
      .where('signing_secret', 'is not', null)
      .execute();
    expect(left).toHaveLength(0);
  });

  it('seals each row once when two backfills run at once', async () => {
    const endpoints = await addPlaintext(40);
    // Its own pool, so a backfill that waits on the other's row locks instead
    // of skipping them fails fast rather than hanging the run.
    const url = new URL(testDb.url);
    url.searchParams.set('options', '-c lock_timeout=2000');
    const other = createDatabase(url.toString(), { maxConnections: 2 });
    const timed = createDatabase(url.toString(), { maxConnections: 2 });
    try {
      const counts = await Promise.all([
        sealPlaintextSecrets(timed, cipher, { batchSize: 5 }),
        sealPlaintextSecrets(other, cipher, { batchSize: 5 }),
      ]);

      expect(counts[0] + counts[1]).toBe(40);
      for (const { id, secret } of endpoints) {
        const row = await storedSecret(id);
        await expect(
          cipher.open(asSealed(row), secretAad(tenantId, id)),
        ).resolves.toBe(secret);
      }
    } finally {
      await other.destroy();
      await timed.destroy();
    }
  });

  it('skips a row another transaction holds instead of waiting for it', async () => {
    const [held, ...free] = await addPlaintext(3);
    // A backfill that waits on the held row instead of skipping it fails
    // after 2 s with "canceling statement due to lock timeout".
    const url = new URL(testDb.url);
    url.searchParams.set('options', '-c lock_timeout=2000');
    const timed = createDatabase(url.toString(), { maxConnections: 2 });
    let release = (): void => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('endpoints')
        .select('id')
        .where('id', '=', held?.id ?? '')
        .forUpdate()
        .execute();
      locked();
      await released;
    });
    try {
      await isLocked;

      await expect(sealPlaintextSecrets(timed, cipher)).resolves.toBe(2);

      expect((await storedSecret(held?.id ?? '')).signing_secret).toBe(
        held?.secret,
      );
      for (const { id } of free) {
        expect((await storedSecret(id)).signing_secret).toBeNull();
      }
    } finally {
      release();
      await holder;
      await timed.destroy();
    }
    await expect(sealPlaintextSecrets(db, cipher)).resolves.toBe(1);
  });

  it.each([0, -1, 1.5])('rejects a batch size of %s', async (batchSize) => {
    await expect(
      sealPlaintextSecrets(db, cipher, { batchSize }),
    ).rejects.toThrow(RangeError);
  });
});
