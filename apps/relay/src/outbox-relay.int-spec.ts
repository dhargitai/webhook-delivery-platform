import { randomUUID } from 'node:crypto';
import {
  createDatabase,
  type Database,
  IdempotentIngest,
  KyselyEventStore,
  KyselyOutboxStore,
  type OutboxBatch,
  OutboxRelay,
  OutboxStore,
  PartialPublishError,
  UuidV7EventIdGenerator,
} from '@wdp/core';
import { createTestDatabase, type TestDatabase } from '@wdp/core/testing';
import {
  BrokerConnection,
  ConfirmPublisher,
  declareEventTopology,
  decodeMessage,
  eventPublishedSchema,
  UnroutableMessageError,
} from '@wdp/messaging';
import { testingNamespace } from '@wdp/messaging/testing';
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
import { BrokerEventPublisher } from './broker-event-publisher.js';

/** The real store, except the process "dies" when asked to record the publish. */
class CrashBeforeMarking extends OutboxStore {
  constructor(private readonly inner: OutboxStore) {
    super();
  }

  processBatch<T>(
    limit: number,
    work: (batch: OutboxBatch) => Promise<T>,
  ): Promise<T> {
    return this.inner.processBatch(limit, (batch) =>
      work({
        ...batch,
        markPublished: async () => {
          throw new Error('process died before commit');
        },
      }),
    );
  }
}

describe('outbox relay (real Postgres and RabbitMQ)', () => {
  let testDb: TestDatabase;
  let db: Kysely<Database>;
  let conn: BrokerConnection;
  let tenantId: string;
  const brokerErrors: Error[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase(inject('postgresAdminUrl'));
    db = createDatabase(testDb.url, { maxConnections: 20 });
    conn = await BrokerConnection.connect(inject('rabbitUrl'), (e) =>
      brokerErrors.push(e),
    );
    const tenant = await db
      .insertInto('tenants')
      .values({ name: 'relay-tests' })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;
  });

  beforeEach(async () => {
    await db.deleteFrom('events').execute();
  });

  afterAll(async () => {
    await conn.close();
    await db.destroy();
    await testDb.drop();
  });

  /** A relay wired to its own broker namespace, so specs never share queues. */
  async function setUp({
    batchSize = 200,
    store,
  }: { batchSize?: number; store?: OutboxStore } = {}) {
    const namespace = testingNamespace();
    const setup = await conn.createChannel();
    const names = await declareEventTopology(setup, { namespace });
    return { names, ...(await buildRelay(names, { batchSize, store })) };
  }

  async function buildRelay(
    names: Awaited<ReturnType<typeof declareEventTopology>>,
    { batchSize, store }: { batchSize: number; store?: OutboxStore },
  ) {
    const channel = await conn.createConfirmChannel();
    const publisher = new BrokerEventPublisher(
      new ConfirmPublisher(channel),
      names,
    );
    const relay = new OutboxRelay(
      store ?? new KyselyOutboxStore(db),
      publisher,
      {
        batchSize,
      },
    );
    return { relay };
  }

  /** Reads every message currently on the queue, in order. */
  async function drain(queue: string) {
    const channel = await conn.createChannel();
    const messages = [];
    for (;;) {
      const message = await channel.get(queue, { noAck: true });
      if (message === false) break;
      messages.push(message);
    }
    await channel.close();
    return messages;
  }

  const ingest = new IdempotentIngest(
    // Bound lazily: `db` exists only after beforeAll.
    { insertIfAbsent: (row) => new KyselyEventStore(db).insertIfAbsent(row) },
    new UuidV7EventIdGenerator(),
  );

  const unpublishedCount = async () =>
    Number(
      (
        await db
          .selectFrom('events')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('published_at', 'is', null)
          .executeTakeFirstOrThrow()
      ).n,
    );

  it('moves accepted events from Postgres to the dispatch queue and marks them published', async () => {
    const accepted = [];
    for (let i = 0; i < 3; i++) {
      accepted.push(
        await ingest.accept(tenantId, null, {
          type: 'invoice.paid',
          payload: { invoice: `INV-${i}` },
        }),
      );
    }
    const { relay, names } = await setUp();

    expect(await relay.runOnce()).toBe(3);

    const messages = await drain(names.dispatchQueue);
    const bodies = messages.map((m) =>
      decodeMessage(m.content, eventPublishedSchema),
    );
    expect(bodies.map((b) => b.eventId)).toEqual(
      accepted.map((a) => a.eventId),
    );
    expect(bodies.map((b) => b.payload)).toEqual([
      { invoice: 'INV-0' },
      { invoice: 'INV-1' },
      { invoice: 'INV-2' },
    ]);
    expect(bodies.every((b) => b.tenantId === tenantId)).toBe(true);
    expect(messages.map((m) => m.properties.messageId)).toEqual(
      accepted.map((a) => a.eventId),
    );
    expect(await unpublishedCount()).toBe(0);
  });

  it('publishes nothing and keeps nothing waiting when the outbox is empty', async () => {
    const { relay, names } = await setUp();

    expect(await relay.runOnce()).toBe(0);

    expect(await drain(names.dispatchQueue)).toEqual([]);
  });

  it('republishes after a crash between publishing and committing, losing nothing', async () => {
    const accepted = [
      await ingest.accept(tenantId, null, { type: 't', payload: 1 }),
      await ingest.accept(tenantId, null, { type: 't', payload: 2 }),
    ];
    const first = await setUp({
      store: new CrashBeforeMarking(new KyselyOutboxStore(db)),
    });

    await expect(first.relay.runOnce()).rejects.toThrow('process died');

    // On the broker already, yet still waiting in the outbox.
    expect(await unpublishedCount()).toBe(2);
    const second = await buildRelay(first.names, { batchSize: 200 });
    expect(await second.relay.runOnce()).toBe(2);

    const messages = await drain(first.names.dispatchQueue);
    const ids = messages.map((m) => m.properties.messageId);
    // Both events arrived, twice: at-least-once, deduplicated by message id.
    expect(ids).toHaveLength(4);
    expect(new Set(ids)).toEqual(new Set(accepted.map((a) => a.eventId)));
    expect(await unpublishedCount()).toBe(0);
  });

  it('does not mark an event published when no queue received it', async () => {
    await ingest.accept(tenantId, null, { type: 't', payload: 1 });
    const { relay, names } = await setUp();
    const admin = await conn.createChannel();
    await admin.unbindQueue(
      names.dispatchQueue,
      names.eventsExchange,
      'event.published',
    );

    let error: unknown;
    try {
      await relay.runOnce();
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(PartialPublishError);
    expect((error as PartialPublishError).failures[0]?.error).toBeInstanceOf(
      UnroutableMessageError,
    );
    expect(await unpublishedCount()).toBe(1);
  });

  it('delivers the outbox in creation order across batches', async () => {
    const accepted = [];
    for (let i = 0; i < 25; i++) {
      accepted.push(
        await ingest.accept(tenantId, null, { type: 't', payload: i }),
      );
    }
    const { relay, names } = await setUp({ batchSize: 10 });

    expect(await relay.runOnce()).toBe(10);
    expect(await relay.runOnce()).toBe(10);
    expect(await relay.runOnce()).toBe(5);
    expect(await relay.runOnce()).toBe(0);

    const messages = await drain(names.dispatchQueue);
    expect(messages.map((m) => m.properties.messageId)).toEqual(
      accepted.map((a) => a.eventId),
    );
  });

  it('publishes each event once when two relays run at the same time', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      event_id: randomUUID(),
      tenant_id: tenantId,
      idempotency_key: null,
      request_hash: 'hash',
      event_type: 't',
      payload: JSON.stringify(i),
      created_at: new Date(Date.now() - 1_000_000 + i),
    }));
    await db.insertInto('events').values(rows).execute();
    const first = await setUp({ batchSize: 50 });
    const second = await buildRelay(first.names, { batchSize: 50 });

    const results = await Promise.all([
      first.relay.runOnce(),
      second.relay.runOnce(),
    ]);

    expect(results[0] + results[1]).toBe(100);
    const ids = (await drain(first.names.dispatchQueue)).map(
      (m) => m.properties.messageId,
    );
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    expect(await unpublishedCount()).toBe(0);
  });
});
