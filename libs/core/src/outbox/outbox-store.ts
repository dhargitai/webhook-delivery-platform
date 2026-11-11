/** An accepted event waiting in the outbox to be handed to the broker. */
export interface OutboxEvent {
  eventId: string;
  tenantId: string;
  eventType: string;
  payload: unknown;
  createdAt: Date;
}

export interface OutboxBatch {
  /** Oldest first. These events are locked: no other batch can take them. */
  events: OutboxEvent[];
  /** Records the events as published. Takes effect only if the batch's work finishes. */
  markPublished(eventIds: string[]): Promise<void>;
}

export abstract class OutboxStore {
  /**
   * Locks up to `limit` unpublished events, runs `work` on them, and commits
   * what `work` recorded once it resolves. If `work` throws, everything it
   * recorded is rolled back and the events stay unpublished.
   *
   * Concurrent calls never receive the same event, and a call never waits for
   * events another call holds.
   */
  abstract processBatch<T>(
    limit: number,
    work: (batch: OutboxBatch) => Promise<T>,
  ): Promise<T>;
}
