import { IdempotencyConflictError } from '@wdp/domain';
import { EventIdGenerator, EventStore } from './event-store.js';
import { requestHash } from './request-hash.js';

export interface IngestRequest {
  type: string;
  payload: unknown;
}

export interface IngestResult {
  eventId: string;
  /** false when an earlier request with the same key and body already created it. */
  created: boolean;
}

/**
 * The idempotency decision table for `POST /v1/events`:
 *
 * - no key, or an unseen key: a new event is stored
 * - same key, same request hash: the original event id is returned
 * - same key, different request hash: IdempotencyConflictError
 *
 * Concurrent duplicates are serialised by the store's unique constraint,
 * never by locking here.
 */
export class IdempotentIngest {
  constructor(
    private readonly store: EventStore,
    private readonly ids: EventIdGenerator,
  ) {}

  async accept(
    tenantId: string,
    idempotencyKey: string | null,
    request: IngestRequest,
  ): Promise<IngestResult> {
    const hash = requestHash(request);

    const stored = await this.store.insertIfAbsent({
      eventId: this.ids.next(),
      tenantId,
      idempotencyKey,
      requestHash: hash,
      eventType: request.type,
      payload: request.payload,
    });

    if (stored.inserted) {
      return { eventId: stored.eventId, created: true };
    }
    if (stored.requestHash !== hash) {
      throw new IdempotencyConflictError(
        `Idempotency-Key "${idempotencyKey}" was already used with a different request body`,
      );
    }
    return { eventId: stored.eventId, created: false };
  }
}
