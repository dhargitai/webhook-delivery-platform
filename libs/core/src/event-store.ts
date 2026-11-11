export interface NewEventRow {
  eventId: string;
  tenantId: string;
  /** null when the client sent no Idempotency-Key. */
  idempotencyKey: string | null;
  requestHash: string;
  eventType: string;
  payload: unknown;
}

export interface InsertResult {
  /** The id of the stored row: the new one, or the one that already held the key. */
  eventId: string;
  /** The request hash of the stored row. */
  requestHash: string;
  /** false when the (tenantId, idempotencyKey) pair already existed. */
  inserted: boolean;
}

/**
 * Persistence port for accepted events. Implementations must make
 * `insertIfAbsent` atomic per (tenantId, idempotencyKey): concurrent calls
 * with the same pair insert exactly one row and all see that row.
 */
export abstract class EventStore {
  abstract insertIfAbsent(row: NewEventRow): Promise<InsertResult>;
}

/** Source of new event ids (UUIDv7 in production). */
export abstract class EventIdGenerator {
  abstract next(): string;
}
