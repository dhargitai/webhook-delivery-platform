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
