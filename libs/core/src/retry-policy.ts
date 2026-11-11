/** PRD: the base delay of each retry tier, in ms (about 17.6 h in total). */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  5_000, // 5 s
  30_000, // 30 s
  300_000, // 5 min
  1_800_000, // 30 min
  7_200_000, // 2 h
  18_000_000, // 5 h
  36_000_000, // 10 h
];

/** PRD: 7 retries after the first try, so 8 attempts in all. */
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;

/** The jitter bucket every retry uses until jitter is applied. */
const MIDDLE_BUCKET = 1;

export type RetryDecision =
  | { action: 'retry'; delay: number; tier: number; bucket: number }
  | { action: 'dead' };

/**
 * Decides what happens to a delivery after a failed attempt: which retry tier
 * it waits in, or that its attempt budget is spent. Pure: no clock, no I/O.
 */
export class RetryPolicy {
  /**
   * `attempt` is the 1-based number of the attempt that just failed. `delay`
   * is in ms.
   */
  next(attempt: number, _rng: () => number): RetryDecision {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new RangeError(
        `attempt must be a positive integer, got ${attempt}`,
      );
    }
    const tier = attempt - 1;
    const delay = RETRY_SCHEDULE_MS[tier];
    // Past the last tier the attempt budget is spent.
    if (delay === undefined) {
      return { action: 'dead' };
    }
    return {
      action: 'retry',
      delay,
      tier,
      bucket: MIDDLE_BUCKET,
    };
  }
}
