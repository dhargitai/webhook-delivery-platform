import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ENDPOINT_LIMITER,
  EndpointLimiter,
  type EndpointLimiterOptions,
  type EndpointRate,
} from './endpoint-limiter.js';

describe('DEFAULT_ENDPOINT_LIMITER', () => {
  // Locked by the PRD: changing any of these numbers is a deliberate decision.
  it('holds the PRD concurrency cap, lease and rate', () => {
    expect(DEFAULT_ENDPOINT_LIMITER).toEqual({
      maxConcurrent: 20,
      leaseMs: 30_000,
      ratePerSecond: 20,
      burst: 40,
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
    ['a zero rate', { ratePerSecond: 0 }],
    ['a negative rate', { ratePerSecond: -1 }],
    ['a NaN rate', { ratePerSecond: Number.NaN }],
    ['an infinite rate', { ratePerSecond: Number.POSITIVE_INFINITY }],
    ['a zero burst', { burst: 0 }],
    ['a fractional burst', { burst: 1.5 }],
  ])('refuses %s', (_, options) => {
    expect(() => new EndpointLimiter(redis, options)).toThrow(RangeError);
  });

  it('accepts a partial override and the edges of the valid ranges', () => {
    expect(
      () =>
        new EndpointLimiter(redis, {
          maxConcurrent: 1,
          leaseMs: 1,
          ratePerSecond: 0.001,
          burst: 1,
        }),
    ).not.toThrow();
  });

  // The client never connects, so an override that reached Redis would fail
  // with a connection error instead.
  it.each<[string, Partial<EndpointRate>]>([
    ['a zero burst', { burst: 0 }],
    ['a negative rate', { ratePerSecond: -1 }],
  ])('rejects an acquire with %s as its override', async (_, rate) => {
    const limiter = new EndpointLimiter(redis);

    await expect(limiter.acquire('endpoint', rate)).rejects.toThrow(RangeError);
  });
});
