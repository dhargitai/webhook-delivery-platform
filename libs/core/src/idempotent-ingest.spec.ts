import { beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyConflictError } from '@wdp/domain';
import { IdempotentIngest } from './idempotent-ingest.js';
import { requestHash } from './request-hash.js';
import {
  FakeEventStore,
  SequentialEventIdGenerator,
} from './testing/fake-event-store.js';

const request = { type: 'invoice.paid', payload: { invoice: 'INV-42' } };

describe('IdempotentIngest', () => {
  let store: FakeEventStore;
  let ingest: IdempotentIngest;

  beforeEach(() => {
    store = new FakeEventStore();
    ingest = new IdempotentIngest(store, new SequentialEventIdGenerator());
  });

  it('stores a new event with its key and request hash', async () => {
    const result = await ingest.accept('tenant-a', 'key-1', request);

    expect(result).toEqual({ eventId: 'evt-1', created: true });
    expect(store.rows).toEqual([
      {
        eventId: 'evt-1',
        tenantId: 'tenant-a',
        idempotencyKey: 'key-1',
        requestHash: requestHash(request),
        eventType: 'invoice.paid',
        payload: { invoice: 'INV-42' },
      },
    ]);
  });

  it('returns the original event id for the same key and body, without storing again', async () => {
    const first = await ingest.accept('tenant-a', 'key-1', request);
    const second = await ingest.accept('tenant-a', 'key-1', request);

    expect(second).toEqual({ eventId: first.eventId, created: false });
    expect(store.rows).toHaveLength(1);
  });

  it('treats a body that differs only in key order as the same request', async () => {
    const first = await ingest.accept('tenant-a', 'key-1', {
      type: 'invoice.paid',
      payload: { a: 1, b: 2 },
    });
    const second = await ingest.accept('tenant-a', 'key-1', {
      payload: { b: 2, a: 1 },
      type: 'invoice.paid',
    });

    expect(second).toEqual({ eventId: first.eventId, created: false });
  });

  it('rejects the same key with a different body and stores nothing new', async () => {
    await ingest.accept('tenant-a', 'key-1', request);

    await expect(
      ingest.accept('tenant-a', 'key-1', {
        type: 'invoice.paid',
        payload: { invoice: 'INV-43' },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(store.rows).toHaveLength(1);
  });

  it('keeps keys separate per tenant', async () => {
    const a = await ingest.accept('tenant-a', 'key-1', request);
    const b = await ingest.accept('tenant-b', 'key-1', request);

    expect(b.created).toBe(true);
    expect(b.eventId).not.toBe(a.eventId);
    expect(store.rows).toHaveLength(2);
  });

  it('creates a separate event for every call without a key', async () => {
    const first = await ingest.accept('tenant-a', null, request);
    const second = await ingest.accept('tenant-a', null, request);

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.eventId).not.toBe(first.eventId);
    expect(store.rows).toHaveLength(2);
  });
});
