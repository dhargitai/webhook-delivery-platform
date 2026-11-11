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
