import { describe, expect, it } from 'vitest';
import { summarize } from './percentiles.js';

const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

describe('summarize', () => {
  it('gives nearest-rank percentiles', () => {
    expect(summarize(oneToHundred)).toEqual({
      count: 100,
      p50: 50,
      p95: 95,
      p99: 99,
      max: 100,
    });
  });

  it('rounds the rank up on small samples', () => {
    // Nearest rank: ceil(p/100 * n). With 3 values every percentile above
    // 66.7 is the largest one.
    expect(summarize([30, 10, 20])).toEqual({
      count: 3,
      p50: 20,
      p95: 30,
      p99: 30,
      max: 30,
    });
  });

  it('does not depend on the input order, and leaves the input as it was', () => {
    const shuffled = [...oneToHundred].reverse();
    expect(summarize(shuffled)).toEqual(summarize(oneToHundred));
    expect(shuffled[0]).toBe(100);
  });

  it('has no percentiles for an empty sample', () => {
    expect(summarize([])).toEqual({
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      max: null,
    });
  });
});
