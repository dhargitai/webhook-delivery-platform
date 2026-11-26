import { randomUUID } from 'node:crypto';
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
import {
  createTestDatabase,
  type TestDatabase,
} from '../testing/test-database.js';
import { KyselyEventPurger } from './kysely-event-purger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

describe('KyselyEventPurger (real Postgres)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let tenantId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url, { maxConnections: 10 });
    const tenant = await db
      .insertInto('tenants')
      .values({ name: 'purge-tests' })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;
  });

  beforeEach(async () => {
    // The purger reads every tenant's events, so each test starts from none.
    await db.deleteFrom('events').execute();
  });

  afterAll(async () => {
    await db.destroy();
    await testDb.drop();
  });

  /** Adds one event created `ageMs` ago, published or still in the outbox. */
  async function addEvent(
    ageMs: number,
    { published }: { published: boolean },
  ): Promise<string> {
    const eventId = randomUUID();
    const createdAt = new Date(Date.now() - ageMs);
    await db
      .insertInto('events')
      .values({
        event_id: eventId,
        tenant_id: tenantId,
        idempotency_key: null,
        request_hash: 'hash',
        event_type: 'invoice.paid',
        payload: JSON.stringify({}),
        created_at: createdAt,
        published_at: published ? createdAt : null,
      })
      .execute();
    return eventId;
  }

  const remainingIds = async () =>
    (await db.selectFrom('events').select('event_id').execute())
      .map((row) => row.event_id)
      .sort();

  const purger = (options: { retentionMs?: number; batchSize?: number } = {}) =>
    new KyselyEventPurger(db, {
      retentionMs: options.retentionMs ?? THIRTY_DAYS_MS,
      batchSize: options.batchSize ?? 100,
    });

  it('removes a published event older than the retention and counts it', async () => {
    await addEvent(31 * DAY_MS, { published: true });

    const purged = await purger().purgeBatch();

    expect(purged).toBe(1);
    expect(await remainingIds()).toEqual([]);
  });

  it('never removes an unpublished event, however old', async () => {
    const waiting = await addEvent(400 * DAY_MS, { published: false });

    const purged = await purger().purgeBatch();

    expect(purged).toBe(0);
    expect(await remainingIds()).toEqual([waiting]);
  });

  it('keeps a published event younger than the retention', async () => {
    const recent = await addEvent(29 * DAY_MS, { published: true });

    const purged = await purger().purgeBatch();

    expect(purged).toBe(0);
    expect(await remainingIds()).toEqual([recent]);
  });

  it('measures age against the configured retention', async () => {
    await addEvent(2 * DAY_MS, { published: true });
    const recent = await addEvent(DAY_MS / 2, { published: true });

    const purged = await purger({ retentionMs: DAY_MS }).purgeBatch();

    expect(purged).toBe(1);
    expect(await remainingIds()).toEqual([recent]);
  });

  it('removes at most one batch per call, the oldest first', async () => {
    // Inserted newest first, so the table's physical order is the reverse of
    // age order and only an explicit sort picks the oldest.
    const newestFirst: string[] = [];
    for (let day = 31; day <= 35; day++) {
      newestFirst.push(await addEvent(day * DAY_MS, { published: true }));
    }
    const batched = purger({ batchSize: 2 });

    expect(await batched.purgeBatch()).toBe(2);
    // The two oldest (35 and 34 days) are gone.
    expect(await remainingIds()).toEqual(newestFirst.slice(0, 3).sort());

    expect(await batched.purgeBatch()).toBe(2);
    expect(await batched.purgeBatch()).toBe(1);
    expect(await batched.purgeBatch()).toBe(0);
    expect(await remainingIds()).toEqual([]);
  });

  it('lets two purgers run at once, each taking rows the other has not locked', async () => {
    for (let day = 34; day > 30; day--) {
      await addEvent(day * DAY_MS, { published: true });
    }
    // Its own pool with a lock timeout: if it waited for the held rows instead
    // of skipping them, it would wait on a transaction that waits on it. The
    // timeout turns that deadlock into a failure instead of a hung run.
    const url = new URL(testDb.url);
    url.searchParams.set('options', '-c lock_timeout=2000');
    const contenderDb = createDatabase(url.toString(), { maxConnections: 1 });
    const contender = new KyselyEventPurger(contenderDb, {
      retentionMs: THIRTY_DAYS_MS,
      batchSize: 2,
    });

    try {
      // The first purger's batch stays locked until its transaction ends, so
      // the contender runs while those rows are held.
      const counts = await db.transaction().execute(async (trx) => {
        const holder = new KyselyEventPurger(trx, {
          retentionMs: THIRTY_DAYS_MS,
          batchSize: 2,
        });
        const first = await holder.purgeBatch();
        const second = await contender.purgeBatch();
        return [first, second];
      });

      expect(counts).toEqual([2, 2]);
      expect(await remainingIds()).toEqual([]);
    } finally {
      await contenderDb.destroy();
    }
  });

  it.each([
    ['retentionMs', 0],
    ['retentionMs', -1],
    ['retentionMs', 1.5],
    ['batchSize', 0],
    ['batchSize', 2.5],
  ])('rejects %s = %s', (name, value) => {
    expect(() => purger({ [name]: value })).toThrow(RangeError);
  });
});
