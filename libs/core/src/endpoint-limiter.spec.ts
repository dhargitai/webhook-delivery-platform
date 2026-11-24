import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ENDPOINT_LIMITER,
  EndpointLimiter,
  type EndpointLimiterOptions,
} from './endpoint-limiter.js';

describe('DEFAULT_ENDPOINT_LIMITER', () => {
  // Locked by the PRD: changing either number is a deliberate decision.
  it('holds the PRD concurrency cap and lease', () => {
    expect(DEFAULT_ENDPOINT_LIMITER).toEqual({
      maxConcurrent: 20,
      leaseMs: 30_000,
    });
  });
});

describe('EndpointLimiter options', () => {
  // Never connects: a lazy client opens its socket on the first command only.
  const redis = new Redis({ lazyConnect: true });
  afterAll(() => redis.disconnect());

  it.each<[string, Partial<EndpointLimiterOptions>]>([
    ['a zero cap', { maxConcurrent: 0 }],
    ['a negative cap', { maxConcurrent: -1 }],
    ['a fractional cap', { maxConcurrent: 2.5 }],
    ['a zero lease', { leaseMs: 0 }],
    ['a negative lease', { leaseMs: -1 }],
    ['a NaN lease', { leaseMs: Number.NaN }],
    ['an infinite lease', { leaseMs: Number.POSITIVE_INFINITY }],
  ])('refuses %s', (_, options) => {
    expect(() => new EndpointLimiter(redis, options)).toThrow(RangeError);
  });

  it('accepts a partial override and the edges of the valid ranges', () => {
    expect(
      () => new EndpointLimiter(redis, { maxConcurrent: 1, leaseMs: 1 }),
    ).not.toThrow();
  });
});
