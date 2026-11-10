import {
  EventIdGenerator,
  EventStore,
  type InsertResult,
  type NewEventRow,
} from '../event-store.js';

/** In-memory store honouring the (tenantId, idempotencyKey) uniqueness rule. */
export class FakeEventStore extends EventStore {
  readonly rows: NewEventRow[] = [];

  async insertIfAbsent(row: NewEventRow): Promise<InsertResult> {
    if (row.idempotencyKey !== null) {
      const existing = this.rows.find(
        (r) =>
          r.tenantId === row.tenantId &&
          r.idempotencyKey === row.idempotencyKey,
      );
      if (existing) {
        return {
          eventId: existing.eventId,
          requestHash: existing.requestHash,
          inserted: false,
        };
      }
    }
    this.rows.push(row);
    return {
      eventId: row.eventId,
      requestHash: row.requestHash,
      inserted: true,
    };
  }
}

/** Yields evt-1, evt-2, ... so tests can predict ids. */
export class SequentialEventIdGenerator extends EventIdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `evt-${this.counter}`;
  }
}
