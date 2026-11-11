import { type Kysely, sql } from 'kysely';
import type { Database } from '../db/schema.js';
import { type OutboxBatch, OutboxStore } from './outbox-store.js';

export class KyselyOutboxStore extends OutboxStore {
  constructor(private readonly db: Kysely<Database>) {
    super();
  }

  processBatch<T>(
    limit: number,
    work: (batch: OutboxBatch) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      // FOR UPDATE keeps other relays off these rows until the commit, and
      // SKIP LOCKED makes them take other rows instead of queueing behind us.
      // The order matches the partial index on unpublished events.
      const rows = await trx
        .selectFrom('events')
        .select([
          'event_id',
          'tenant_id',
          'event_type',
          'payload',
          'created_at',
        ])
        .where('published_at', 'is', null)
        .orderBy('created_at')
        .orderBy('event_id')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();

      return work({
        events: rows.map((row) => ({
          eventId: row.event_id,
          tenantId: row.tenant_id,
          eventType: row.event_type,
          payload: row.payload,
          createdAt: row.created_at,
        })),
        markPublished: async (eventIds) => {
          if (eventIds.length === 0) {
            return;
          }
          await trx
            .updateTable('events')
            .set({ published_at: sql<Date>`now()` })
            .where('event_id', 'in', eventIds)
            .execute();
        },
      });
    });
  }
}
