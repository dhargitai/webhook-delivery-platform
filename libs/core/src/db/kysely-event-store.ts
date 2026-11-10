import type { Kysely } from 'kysely';
import {
  EventStore,
  type InsertResult,
  type NewEventRow,
} from '../event-store.js';
import type { Database } from './schema.js';

export class KyselyEventStore extends EventStore {
  constructor(private readonly db: Kysely<Database>) {
    super();
  }

  /**
   * Atomic through the (tenant_id, idempotency_key) unique index: of any
   * number of concurrent inserts with the same pair, one inserts and the rest
   * wait for it to commit, do nothing, and then read the winner's row.
   */
  async insertIfAbsent(row: NewEventRow): Promise<InsertResult> {
    const inserted = await this.db
      .insertInto('events')
      .values({
        event_id: row.eventId,
        tenant_id: row.tenantId,
        idempotency_key: row.idempotencyKey,
        request_hash: row.requestHash,
        event_type: row.eventType,
        payload: JSON.stringify(row.payload),
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'idempotency_key']).doNothing(),
      )
      .returning(['event_id', 'request_hash'])
      .executeTakeFirst();

    if (inserted) {
      return {
        eventId: inserted.event_id,
        requestHash: inserted.request_hash,
        inserted: true,
      };
    }

    // Nothing inserted means the key exists. A null key can never conflict, so
    // idempotencyKey is a string here.
    const existing = await this.db
      .selectFrom('events')
      .select(['event_id', 'request_hash'])
      .where('tenant_id', '=', row.tenantId)
      .where('idempotency_key', '=', row.idempotencyKey)
      .executeTakeFirstOrThrow();

    return {
      eventId: existing.event_id,
      requestHash: existing.request_hash,
      inserted: false,
    };
  }
}
