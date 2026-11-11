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

/** PRD: the short delay tier a parked job waits in, 5 s before scaling. */
const PARK_DELAY_MS = 5_000;

/** PRD: 7 retries after the first try, so 8 attempts in all. */
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;

/**
 * PRD: fixed-TTL tier queues give every message in a queue the same delay, so
 * jitter cannot be per message. Each tier has three queues instead, at 0.8x,
 * 1.0x and 1.2x its base delay, and the policy picks one at random. Integer
 * percents keep the arithmetic free of float noise.
 */
const JITTER_PERCENT: readonly number[] = [80, 100, 120];

export type RetryDecision =
  | { action: 'retry'; delay: number; tier: number; bucket: number }
  | { action: 'dead' };

export interface RetryPolicyOptions {
  /**
   * Divides every delay, to compress the schedule for demos and tests
   * (`TIME_SCALE`: 1 in production, 30 for the demo, 1000 in tests).
   */
  timeScale?: number;
  /**
   * No delay is shorter than this many ms, however large the scale: the PRD
   * uses 500 ms for the demo and 20 ms for the tests. Applied after scaling.
   */
  minDelayMs?: number;
}

/**
 * Decides what happens to a delivery after a failed attempt: which retry tier
 * it waits in, or that its attempt budget is spent. Pure: no clock, no I/O.
 */
export class RetryPolicy {
  private readonly timeScale: number;
  private readonly minDelayMs: number;

  constructor({ timeScale = 1, minDelayMs = 0 }: RetryPolicyOptions = {}) {
    if (!Number.isFinite(timeScale) || timeScale <= 0) {
      throw new RangeError(
        `timeScale must be a positive finite number, got ${timeScale}`,
      );
    }
    if (!Number.isInteger(minDelayMs) || minDelayMs < 0) {
      throw new RangeError(
        `minDelayMs must be a non-negative integer, got ${minDelayMs}`,
      );
    }
    this.timeScale = timeScale;
    this.minDelayMs = minDelayMs;
  }

  /**
   * Every delay `next()` can return, each once, shortest first: the TTLs of the
   * retry tier queues. A floor can give several buckets, even tiers, one
   * delay, so the list can be shorter than 21. Taken from the same formula as
   * `next()`, so a decision always has a queue to go to.
   */
  delays(): number[] {
    const all = RETRY_SCHEDULE_MS.flatMap((base) =>
      JITTER_PERCENT.map((percent) => this.scaledDelay(base, percent)),
    );
    // Tiers and buckets both run from short to long, and a Set keeps insertion
    // order, so the result is ascending without a sort.
    return [...new Set(all)];
  }

  /**
   * How long a job parked without using up an attempt (open circuit, endpoint
   * over its cap) waits: the PRD's short delay tier, 5 s scaled like the rest.
   */
  get parkDelayMs(): number {
    return this.scaledDelay(PARK_DELAY_MS, 100);
  }

  /**
   * `attempt` is the 1-based number of the attempt that just failed. `delay`
   * is in ms. `rng` returns a number in [0, 1) and picks the jitter bucket; it
   * is injected so the choice is reproducible, and only called for a retry.
   */
  next(attempt: number, rng: () => number): RetryDecision {
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
    const { bucket, percent } = pickBucket(rng);
    return {
      action: 'retry',
      delay: this.scaledDelay(delay, percent),
      tier,
      bucket,
    };
  }

  /**
   * One rounding at the end: the scaled delay is a whole number of ms, as queue
   * names and TTLs need. The floor applies after scaling. Shared by `next()`
   * and `delays()`, so the two cannot drift apart.
   */
  private scaledDelay(baseMs: number, percent: number): number {
    return Math.max(
      this.minDelayMs,
      Math.round((baseMs * percent) / 100 / this.timeScale),
    );
  }
}

function pickBucket(rng: () => number): { bucket: number; percent: number } {
  const value = rng();
  const bucket = Math.floor(value * JITTER_PERCENT.length);
  // Anything outside [0, 1), a NaN included, lands outside the buckets, so
  // the lookup is also the range check.
  const percent = JITTER_PERCENT[bucket];
  if (percent === undefined) {
    throw new RangeError(`rng must return a number in [0, 1), got ${value}`);
  }
  return { bucket, percent };
}
