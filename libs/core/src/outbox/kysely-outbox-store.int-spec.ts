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
import { KyselyOutboxStore } from './kysely-outbox-store.js';

describe('KyselyOutboxStore (real Postgres)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let store: KyselyOutboxStore;
  let tenantId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url, { maxConnections: 20 });
    store = new KyselyOutboxStore(db);
    const tenant = await db
      .insertInto('tenants')
      .values({ name: 'outbox-tests' })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;
  });

  beforeEach(async () => {
    // The store reads every tenant's events, so each test starts from none.
    await db.deleteFrom('events').execute();
  });

  afterAll(async () => {
    await db.destroy();
    await testDb.drop();
  });

  /** Adds events with increasing creation times, which fix the expected order. */
  async function addEvents(
    count: number,
    { published = false }: { published?: boolean } = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < count; i++) {
      const eventId = randomUUID();
      ids.push(eventId);
      await db
        .insertInto('events')
        .values({
          event_id: eventId,
          tenant_id: tenantId,
          idempotency_key: null,
          request_hash: 'hash',
          event_type: 'invoice.paid',
          payload: JSON.stringify({ n: i }),
          created_at: new Date(base + i * 1_000),
          published_at: published ? new Date() : null,
        })
        .execute();
    }
    return ids;
  }

  const unpublishedIds = async () =>
    (
      await db
        .selectFrom('events')
        .select('event_id')
        .where('published_at', 'is', null)
        .orderBy('created_at')
        .execute()
    ).map((r) => r.event_id);

  /**
   * Fails after two seconds instead of hanging: a batch that waits on locked
   * rows would otherwise block until the test timeout.
   */
  function withinTwoSeconds<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('batch blocked on rows another batch holds')),
          2_000,
        ),
      ),
    ]);
  }

  /** A promise and the function that resolves it, to hold a batch open. */
  function gate() {
    let open: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { closed, open };
  }

  it('returns unpublished events oldest first and skips published ones', async () => {
    const ids = await addEvents(5);
    await addEvents(2, { published: true });

    const seen = await store.processBatch(100, async (batch) =>
      batch.events.map((e) => e.eventId),
    );

    expect(seen).toEqual(ids);
  });

  it('honours the batch size', async () => {
    const ids = await addEvents(5);

    const taken = await store.processBatch(3, async (batch) =>
      batch.events.map((e) => e.eventId),
    );

    expect(taken).toEqual(ids.slice(0, 3));
  });

  it('maps an event to its id, tenant, type, payload and creation time', async () => {
    const [id] = await addEvents(1);

    const events = await store.processBatch(10, async (batch) => batch.events);

    expect(events).toEqual([
      {
        eventId: id,
        tenantId,
        eventType: 'invoice.paid',
        payload: { n: 0 },
        createdAt: expect.any(Date),
      },
    ]);
  });

  it('marks events published when the batch finishes, so they are not returned again', async () => {
    await addEvents(3);

    await store.processBatch(100, async (batch) => {
      await batch.markPublished(batch.events.map((e) => e.eventId));
    });

    expect(await unpublishedIds()).toEqual([]);
    const again = await store.processBatch(100, async (batch) => batch.events);
    expect(again).toEqual([]);
    const row = await db
      .selectFrom('events')
      .select('published_at')
      .executeTakeFirstOrThrow();
    expect(row.published_at).toBeInstanceOf(Date);
  });

  it('marks only the events it is told to', async () => {
    const ids = await addEvents(3);

    await store.processBatch(100, async (batch) => {
      await batch.markPublished([ids[0] ?? '', ids[2] ?? '']);
    });

    expect(await unpublishedIds()).toEqual([ids[1]]);
  });

  it('accepts an empty list of events to mark', async () => {
    const ids = await addEvents(2);

    await store.processBatch(100, async (batch) => {
      await batch.markPublished([]);
    });

    expect(await unpublishedIds()).toEqual(ids);
  });

  it('keeps every event unpublished when the batch work fails after marking', async () => {
    const ids = await addEvents(3);

    await expect(
      store.processBatch(100, async (batch) => {
        await batch.markPublished(batch.events.map((e) => e.eventId));
        throw new Error('crashed after marking, before commit');
      }),
    ).rejects.toThrow('crashed after marking');

    expect(await unpublishedIds()).toEqual(ids);
  });

  it('gives concurrent batches disjoint events', async () => {
    const ids = await addEvents(10);
    const held = gate();
    const firstHasEvents = gate();

    // The first batch holds its row locks while the second one runs.
    const first = store.processBatch(5, async (batch) => {
      firstHasEvents.open();
      await held.closed;
      return batch.events.map((e) => e.eventId);
    });
    await firstHasEvents.closed;
    let second: string[];
    try {
      second = await withinTwoSeconds(
        store.processBatch(5, async (batch) =>
          batch.events.map((e) => e.eventId),
        ),
      );
    } finally {
      held.open();
    }
    const firstIds = await first;

    expect(firstIds).toHaveLength(5);
    expect(second).toHaveLength(5);
    expect(firstIds.filter((id) => second.includes(id))).toEqual([]);
    expect([...firstIds, ...second].sort()).toEqual([...ids].sort());
  });

  it('skips events that another batch has locked instead of waiting for them', async () => {
    await addEvents(2);
    const held = gate();
    const holding = gate();
    const holder = store.processBatch(10, async () => {
      holding.open();
      await held.closed;
    });
    await holding.closed;

    let seen: unknown[];
    try {
      // Would hang until the holder commits if it waited for the locks.
      seen = await withinTwoSeconds(
        store.processBatch(10, async (batch) => batch.events),
      );
    } finally {
      held.open();
      await holder;
    }

    expect(seen).toEqual([]);
  });
});
