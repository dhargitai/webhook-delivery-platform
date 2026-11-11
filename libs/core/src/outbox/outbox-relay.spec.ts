import { beforeEach, describe, expect, it } from 'vitest';
import { EventPublisher } from './event-publisher.js';
import { OutboxRelay, PartialPublishError } from './outbox-relay.js';
import {
  type OutboxBatch,
  type OutboxEvent,
  OutboxStore,
} from './outbox-store.js';

interface Row extends OutboxEvent {
  publishedAt: Date | null;
}

/**
 * In-memory outbox with the real store's transaction semantics: the events a
 * batch marks only become published if the batch's work finishes.
 */
class FakeOutboxStore extends OutboxStore {
  readonly rows: Row[] = [];
  /** Simulates the process dying after publishing, before the commit. */
  crashWhileMarking = false;

  add(id: string, createdAt: Date): void {
    this.rows.push({
      eventId: id,
      tenantId: 'tenant-a',
      eventType: 'invoice.paid',
      payload: { id },
      createdAt,
      publishedAt: null,
    });
  }

  unpublishedIds(): string[] {
    return this.rows
      .filter((r) => r.publishedAt === null)
      .map((r) => r.eventId);
  }

  async processBatch<T>(
    limit: number,
    work: (batch: OutboxBatch) => Promise<T>,
  ): Promise<T> {
    const locked = this.rows
      .filter((r) => r.publishedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
    const marked: string[] = [];
    const batch: OutboxBatch = {
      events: locked.map(({ publishedAt: _unused, ...event }) => event),
      markPublished: async (ids) => {
        if (this.crashWhileMarking) {
          throw new Error('process died before commit');
        }
        marked.push(...ids);
      },
    };

    const result = await work(batch); // a throw here is a rollback
    for (const row of this.rows) {
      if (marked.includes(row.eventId)) row.publishedAt = new Date();
    }
    return result;
  }
}

class FakePublisher extends EventPublisher {
  readonly published: string[] = [];
  readonly events: OutboxEvent[] = [];
  readonly failing = new Set<string>();

  async publish(event: OutboxEvent): Promise<void> {
    if (this.failing.has(event.eventId)) {
      throw new Error(`broker refused ${event.eventId}`);
    }
    this.published.push(event.eventId);
    this.events.push(event);
  }
}

describe('OutboxRelay', () => {
  let store: FakeOutboxStore;
  let publisher: FakePublisher;
  let relay: OutboxRelay;

  beforeEach(() => {
    store = new FakeOutboxStore();
    publisher = new FakePublisher();
    relay = new OutboxRelay(store, publisher, { batchSize: 10 });
  });

  const at = (n: number) => new Date(2026, 0, 1, 0, 0, n);

  it('publishes every unpublished event, marks them, and returns how many', async () => {
    store.add('a', at(1));
    store.add('b', at(2));
    store.add('c', at(3));

    const count = await relay.runOnce();

    expect(count).toBe(3);
    expect(publisher.published).toEqual(['a', 'b', 'c']);
    expect(store.unpublishedIds()).toEqual([]);
  });

  it('does nothing when there is nothing to publish', async () => {
    expect(await relay.runOnce()).toBe(0);
    expect(publisher.published).toEqual([]);
  });

  it('publishes the oldest events first', async () => {
    store.add('late', at(30));
    store.add('early', at(10));
    store.add('middle', at(20));

    await relay.runOnce();

    expect(publisher.published).toEqual(['early', 'middle', 'late']);
  });

  it('takes at most one batch per run', async () => {
    const small = new OutboxRelay(store, publisher, { batchSize: 2 });
    for (let i = 1; i <= 5; i++) store.add(`e${i}`, at(i));

    expect(await small.runOnce()).toBe(2);
    expect(publisher.published).toEqual(['e1', 'e2']);
    expect(await small.runOnce()).toBe(2);
    expect(await small.runOnce()).toBe(1);
    expect(publisher.published).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('hands the publisher the full event', async () => {
    store.add('a', at(1));

    await relay.runOnce();

    expect(publisher.events[0]).toEqual({
      eventId: 'a',
      tenantId: 'tenant-a',
      eventType: 'invoice.paid',
      payload: { id: 'a' },
      createdAt: at(1),
    });
  });

  describe('when the broker refuses some events', () => {
    beforeEach(() => {
      store.add('ok-1', at(1));
      store.add('bad', at(2));
      store.add('ok-2', at(3));
      publisher.failing.add('bad');
    });

    it('marks only the confirmed events and keeps the refused one', async () => {
      await expect(relay.runOnce()).rejects.toBeInstanceOf(PartialPublishError);

      expect(store.unpublishedIds()).toEqual(['bad']);
    });

    it('reports how many went out and which ones failed', async () => {
      let error: unknown;
      try {
        await relay.runOnce();
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(PartialPublishError);
      const partial = error as PartialPublishError;
      expect(partial.published).toBe(2);
      expect(partial.failures).toEqual([
        { eventId: 'bad', error: new Error('broker refused bad') },
      ]);
    });

    it('retries the refused event on the next run and does not resend the others', async () => {
      await expect(relay.runOnce()).rejects.toBeInstanceOf(PartialPublishError);
      publisher.failing.clear();

      expect(await relay.runOnce()).toBe(1);

      expect(publisher.published).toEqual(['ok-1', 'ok-2', 'bad']);
      expect(store.unpublishedIds()).toEqual([]);
    });
  });

  it('marks nothing when every publish fails', async () => {
    store.add('a', at(1));
    store.add('b', at(2));
    publisher.failing.add('a').add('b');

    await expect(relay.runOnce()).rejects.toBeInstanceOf(PartialPublishError);

    expect(store.unpublishedIds()).toEqual(['a', 'b']);
  });

  it('republishes after a crash between publishing and committing, losing nothing', async () => {
    store.add('a', at(1));
    store.add('b', at(2));
    store.crashWhileMarking = true;

    await expect(relay.runOnce()).rejects.toThrow('process died before commit');
    // Published, but never marked: still waiting in the outbox.
    expect(publisher.published).toEqual(['a', 'b']);
    expect(store.unpublishedIds()).toEqual(['a', 'b']);

    store.crashWhileMarking = false;
    expect(await relay.runOnce()).toBe(2);

    // At-least-once: consumers receive the duplicate and deduplicate on its id.
    expect(publisher.published).toEqual(['a', 'b', 'a', 'b']);
    expect(store.unpublishedIds()).toEqual([]);
  });
});
