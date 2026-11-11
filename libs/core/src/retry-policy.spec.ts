import { describe, expect, it } from 'vitest';
import { RetryPolicy } from './retry-policy.js';

const MIDDLE = () => 0.5;

describe('RetryPolicy.next', () => {
  const policy = new RetryPolicy();

  it.each([
    [1, 0, 5_000],
    [2, 1, 30_000],
    [3, 2, 300_000],
    [4, 3, 1_800_000],
    [5, 4, 7_200_000],
    [6, 5, 18_000_000],
    [7, 6, 36_000_000],
  ])(
    'retries failed attempt %i in tier %i after %i ms',
    (attempt, tier, delay) => {
      expect(policy.next(attempt, MIDDLE)).toEqual({
        action: 'retry',
        delay,
        tier,
        bucket: 1,
      });
    },
  );

  it.each([8, 9, 100])(
    'gives up after the 8th failed attempt (attempt %i)',
    (attempt) => {
      expect(policy.next(attempt, MIDDLE)).toEqual({ action: 'dead' });
    },
  );

  it.each([0, -1, 1.5, Number.NaN])(
    'refuses %s as an attempt number',
    (attempt) => {
      expect(() => policy.next(attempt, MIDDLE)).toThrow(RangeError);
    },
  );
});

describe('RetryPolicy.next jitter', () => {
  const policy = new RetryPolicy();

  it.each([
    [0, 0, 4_000],
    [0.333, 0, 4_000],
    [1 / 3, 1, 5_000],
    [0.5, 1, 5_000],
    [2 / 3, 2, 6_000],
    [0.999999, 2, 6_000],
  ])(
    'rng %d picks bucket %i, so the first tier waits %i ms',
    (r, bucket, delay) => {
      expect(policy.next(1, () => r)).toEqual({
        action: 'retry',
        delay,
        tier: 0,
        bucket,
      });
    },
  );

  it.each([
    [1, [4_000, 5_000, 6_000]],
    [2, [24_000, 30_000, 36_000]],
    [3, [240_000, 300_000, 360_000]],
    [4, [1_440_000, 1_800_000, 2_160_000]],
    [5, [5_760_000, 7_200_000, 8_640_000]],
    [6, [14_400_000, 18_000_000, 21_600_000]],
    [7, [28_800_000, 36_000_000, 43_200_000]],
  ])(
    'spreads the delay of failed attempt %i over 0.8x, 1.0x and 1.2x',
    (attempt, delays) => {
      const seen = [0, 0.5, 0.9].map((r) => {
        const decision = policy.next(attempt, () => r);
        return decision.action === 'retry' ? decision.delay : undefined;
      });

      expect(seen).toEqual(delays);
    },
  );

  it.each([-0.1, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s from the rng, which must be in [0, 1)',
    (r) => {
      expect(() => policy.next(1, () => r)).toThrow(RangeError);
    },
  );

  it('does not consume randomness when the budget is spent', () => {
    const rng = () => {
      throw new Error('rng must not be called');
    };

    expect(policy.next(8, rng)).toEqual({ action: 'dead' });
  });
});

describe('RetryPolicy time scale and floor', () => {
  const MIDDLE = () => 0.5;

  function delays(policy: RetryPolicy, rng: () => number = MIDDLE) {
    return [1, 2, 3, 4, 5, 6, 7].map((attempt) => {
      const decision = policy.next(attempt, rng);
      return decision.action === 'retry' ? decision.delay : undefined;
    });
  }

  it('compresses the schedule for the demo: scale 30, floor 500 ms', () => {
    const policy = new RetryPolicy({ timeScale: 30, minDelayMs: 500 });

    // 0.5 s, 1 s, 10 s, 1 min, 4 min, 10 min, 20 min. The first tier would
    // be 167 ms without the floor.
    expect(delays(policy)).toEqual([
      500, 1_000, 10_000, 60_000, 240_000, 600_000, 1_200_000,
    ]);
  });

  it('compresses the schedule for tests: scale 1000, floor 20 ms', () => {
    const policy = new RetryPolicy({ timeScale: 1000, minDelayMs: 20 });

    expect(delays(policy)).toEqual([20, 30, 300, 1_800, 7_200, 18_000, 36_000]);
  });

  it('floors every jitter bucket of a tier that scales below the floor', () => {
    const policy = new RetryPolicy({ timeScale: 1000, minDelayMs: 20 });

    // 4, 5 and 6 ms scaled, so all three buckets share one effective delay.
    expect([0, 0.5, 0.9].map((r) => policy.next(1, () => r))).toEqual([
      { action: 'retry', delay: 20, tier: 0, bucket: 0 },
      { action: 'retry', delay: 20, tier: 0, bucket: 1 },
      { action: 'retry', delay: 20, tier: 0, bucket: 2 },
    ]);
  });

  it.each([
    [3, 1_667], // 1666.67 rounds up
    [7, 714], // 714.29 rounds down
  ])('rounds a scaled delay to whole ms (scale %i)', (timeScale, delay) => {
    const policy = new RetryPolicy({ timeScale });

    expect(policy.next(1, MIDDLE)).toEqual({
      action: 'retry',
      delay,
      tier: 0,
      bucket: 1,
    });
  });

  it('scales the jittered delay, not the base', () => {
    const policy = new RetryPolicy({ timeScale: 10 });

    expect(policy.next(1, () => 0.9)).toMatchObject({ delay: 600 });
  });

  it('lets a floor above the delay win', () => {
    const policy = new RetryPolicy({ minDelayMs: 10_000 });

    expect(policy.next(1, MIDDLE)).toMatchObject({ delay: 10_000 });
    expect(policy.next(3, MIDDLE)).toMatchObject({ delay: 300_000 });
  });

  it('leaves the schedule alone by default', () => {
    expect(delays(new RetryPolicy({}))).toEqual(delays(new RetryPolicy()));
    expect(delays(new RetryPolicy())).toEqual([
      5_000, 30_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000,
    ]);
  });

  it('keeps tier, bucket and the budget when scaled', () => {
    const policy = new RetryPolicy({ timeScale: 1000, minDelayMs: 20 });

    expect(policy.next(7, () => 0.9)).toEqual({
      action: 'retry',
      delay: 43_200,
      tier: 6,
      bucket: 2,
    });
    expect(policy.next(8, MIDDLE)).toEqual({ action: 'dead' });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a time scale of %s',
    (timeScale) => {
      expect(() => new RetryPolicy({ timeScale })).toThrow(RangeError);
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a minimum delay of %s',
    (minDelayMs) => {
      expect(() => new RetryPolicy({ minDelayMs })).toThrow(RangeError);
    },
  );
});
