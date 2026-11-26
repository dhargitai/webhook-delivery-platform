import { type Kysely, sql } from 'kysely';
import type { Database } from '../db/schema.js';
import { EventPurger } from './event-purger.js';

export interface EventPurgerOptions {
  /** How long a published event is kept, from its creation (PRD: 30 days). */
  retentionMs: number;
  /** Most events removed per call. */
  batchSize: number;
}

export class KyselyEventPurger extends EventPurger {
  private readonly retentionMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly db: Kysely<Database>,
    options: EventPurgerOptions,
  ) {
    super();
    assertPositiveInteger('retentionMs', options.retentionMs);
    assertPositiveInteger('batchSize', options.batchSize);
    this.retentionMs = options.retentionMs;
    this.batchSize = options.batchSize;
  }

  async purgeBatch(): Promise<number> {
    // The cutoff comes from the database clock, the same clock that stamped
    // created_at, so an app host's skewed clock cannot move it.
    const cutoff = sql<Date>`now() - make_interval(secs => ${this.retentionMs / 1000})`;
    const result = await this.db
      .deleteFrom('events')
      .where('event_id', 'in', (qb) =>
        qb
          .selectFrom('events')
          .select('event_id')
          .where('published_at', 'is not', null)
          .where('created_at', '<', cutoff)
          // The order matches the partial index on published events.
          .orderBy('created_at')
          .limit(this.batchSize)
          // Another purger's rows are skipped, not waited for, so two relays
          // purging at once neither block each other nor count the same rows.
          .forUpdate()
          .skipLocked(),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}
