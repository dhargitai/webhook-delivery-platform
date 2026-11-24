import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  type AcquireResult,
  EndpointLimiter,
  type Permit,
} from './endpoint-limiter.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('EndpointLimiter (real Redis)', () => {
  let redis: Redis;
  // A second connection so concurrent acquires really race on the server.
  let redisB: Redis;

  beforeAll(() => {
    redis = new Redis(inject('redisUrl'));
    redisB = new Redis(inject('redisUrl'));
  });

  afterAll(async () => {
    await Promise.all([redis.quit(), redisB.quit()]);
  });

  /** An endpoint id nobody else has touched, so tests never share slots. */
  const endpoint = () => randomUUID();

  const permitOf = (result: AcquireResult): Permit => {
    if (result.kind !== 'permit') {
      throw new Error(`expected a permit, got ${JSON.stringify(result)}`);
    }
    return result.permit;
  };

  const acquireMany = async (
    limiter: EndpointLimiter,
    id: string,
    count: number,
  ) => {
    const results: AcquireResult[] = [];
    for (let i = 0; i < count; i++) results.push(await limiter.acquire(id));
    return results;
  };

  it('grants 20 permits to one endpoint and denies the 21st', async () => {
    const limiter = new EndpointLimiter(redis);
    const id = endpoint();

    const granted = await acquireMany(limiter, id, 20);
    expect(granted.every((r) => r.kind === 'permit')).toBe(true);

    expect(await limiter.acquire(id)).toEqual({
      kind: 'denied',
      reason: 'concurrency_cap',
    });
  });

  it('grants exactly the cap when acquires race from two connections', async () => {
    const limiterA = new EndpointLimiter(redis);
    const limiterB = new EndpointLimiter(redisB);
    const id = endpoint();

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        (i % 2 === 0 ? limiterA : limiterB).acquire(id),
      ),
    );

    expect(results.filter((r) => r.kind === 'permit')).toHaveLength(20);
    expect(results.filter((r) => r.kind === 'denied')).toHaveLength(5);
  });

  it('frees a slot when its permit is released', async () => {
    const limiter = new EndpointLimiter(redis);
    const id = endpoint();
    const [first] = await acquireMany(limiter, id, 20);
    expect((await limiter.acquire(id)).kind).toBe('denied');

    await limiter.release(permitOf(first));

    expect((await limiter.acquire(id)).kind).toBe('permit');
  });

  it('keeps each endpoint to its own slots', async () => {
    const limiter = new EndpointLimiter(redis);
    const full = endpoint();
    const other = endpoint();
    await acquireMany(limiter, full, 20);

    expect((await limiter.acquire(other)).kind).toBe('permit');
  });

  describe('leases', () => {
    // Short enough to wait out, long enough that a slow Redis round trip
    // never ends one early.
    const LEASE_MS = 200;
    const outlastLease = () => sleep(LEASE_MS * 2);

    it('frees the slot of a permit that is never released', async () => {
      const limiter = new EndpointLimiter(redis, {
        maxConcurrent: 2,
        leaseMs: LEASE_MS,
      });
      const id = endpoint();
      await acquireMany(limiter, id, 2);
      expect((await limiter.acquire(id)).kind).toBe('denied');

      await outlastLease();

      expect((await limiter.acquire(id)).kind).toBe('permit');
    });

    it('frees an expired permit’s slot while a newer permit keeps the key alive', async () => {
      // The key's TTL follows the newest lease, so here only the per-permit
      // expiry can free the older slot.
      const leaseMs = 300;
      const limiter = new EndpointLimiter(redis, { maxConcurrent: 2, leaseMs });
      const id = endpoint();
      await limiter.acquire(id);
      await sleep(200);
      await limiter.acquire(id);
      // 100 ms after the first lease ended, 100 ms before the second ends.
      await sleep(200);

      expect((await limiter.acquire(id)).kind).toBe('permit');
    });

    it('does not free another holder’s slot when an expired permit is released', async () => {
      const limiter = new EndpointLimiter(redis, {
        maxConcurrent: 1,
        leaseMs: LEASE_MS,
      });
      const id = endpoint();
      const late = permitOf(await limiter.acquire(id));
      await outlastLease();
      // The lease ended, so B legitimately holds the only slot now.
      permitOf(await limiter.acquire(id));

      await limiter.release(late);

      expect((await limiter.acquire(id)).kind).toBe('denied');
    });

    it('leaves no key behind for an endpoint that goes quiet', async () => {
      const limiter = new EndpointLimiter(redis, { leaseMs: LEASE_MS });
      const id = endpoint();

      await limiter.acquire(id);

      // The PRD-style key layout is fixed, which is why the test may read it.
      const ttl = await redis.pttl(`el:{${id}}:slots`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(LEASE_MS);
    });
  });
});
