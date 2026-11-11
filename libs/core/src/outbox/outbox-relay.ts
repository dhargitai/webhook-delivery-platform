import type { EventPublisher } from './event-publisher.js';
import type { OutboxStore } from './outbox-store.js';

export interface PublishFailure {
  eventId: string;
  error: unknown;
}

/**
 * Some events in a batch could not be published. The ones that could were
 * published and recorded; the failed ones stay in the outbox for the next run.
 */
export class PartialPublishError extends Error {
  constructor(
    /** How many events of the batch did go out. */
    readonly published: number,
    readonly failures: PublishFailure[],
  ) {
    super(
      `${failures.length} of ${published + failures.length} events could not be published`,
      { cause: failures[0]?.error },
    );
    this.name = new.target.name;
  }
}

export interface OutboxRelayOptions {
  /** Most events taken per run (PRD: 200). */
  batchSize: number;
}

/**
 * Moves accepted events from the outbox to the broker.
 *
 * The order is what makes it safe: publish, wait for the broker's confirm,
 * and only then record "published" in the same transaction that holds the
 * events locked. A crash anywhere in between leaves the events unpublished,
 * so they go out again: duplicates are possible, losses are not. Consumers
 * deduplicate on the event id.
 */
export class OutboxRelay {
  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly options: OutboxRelayOptions,
  ) {}

  /**
   * Publishes one batch and returns how many events went out. Throws
   * PartialPublishError, after recording the successes, if any failed.
   */
  async runOnce(): Promise<number> {
    const { published, failures } = await this.store.processBatch(
      this.options.batchSize,
      async (batch) => {
        // Publishing starts in creation order, so the broker receives them in it.
        const outcomes = await Promise.all(
          batch.events.map(async (event) => {
            try {
              await this.publisher.publish(event);
              return { event, failure: undefined };
            } catch (error) {
              return { event, failure: { error } };
            }
          }),
        );

        const confirmed = outcomes
          .filter((outcome) => outcome.failure === undefined)
          .map((outcome) => outcome.event.eventId);
        await batch.markPublished(confirmed);

        const failed: PublishFailure[] = [];
        for (const { event, failure } of outcomes) {
          if (failure) {
            failed.push({ eventId: event.eventId, error: failure.error });
          }
        }
        return { published: confirmed.length, failures: failed };
      },
    );

    // Reported after the commit: throwing inside would roll the successes back
    // and have them published again on every run.
    if (failures.length > 0) {
      throw new PartialPublishError(published, failures);
    }
    return published;
  }
}
