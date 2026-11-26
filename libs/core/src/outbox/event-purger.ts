/**
 * Removes accepted events once they are past retention. Only published events
 * go: one still in the outbox has not reached the broker, so removing it would
 * lose it.
 */
export abstract class EventPurger {
  /**
   * Removes up to one batch of published events older than the retention,
   * oldest first, and returns how many it removed. Fewer than a batch means
   * nothing more is due.
   */
  abstract purgeBatch(): Promise<number>;
}
