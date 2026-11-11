import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { IngestRateLimiter } from './ingest-rate-limiter.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('IngestRateLimiter (real Redis)', () => {
  let redis: Redis;
  // A second connection so concurrent calls really race on the server.
  let redisB: Redis;

  beforeAll(() => {
    redis = new Redis(inject('redisUrl'));
    redisB = new Redis(inject('redisUrl'));
  });

  afterAll(async () => {
    await Promise.all([redis.quit(), redisB.quit()]);
  });

  /** A tenant id nobody else has touched, so specs never share a bucket. */
  const tenant = () => randomUUID();

  it('admits exactly the burst and then rejects', async () => {
    // A slow refill so no token sneaks back in while the calls run.
    const limiter = new IngestRateLimiter(redis, {
      ratePerSecond: 1,
      burst: 200,
    });
    const id = tenant();

    const results = [];
    for (let i = 0; i < 201; i++) {
      results.push(await limiter.tryAcquire(id));
    }

    expect(results.slice(0, 200).every((r) => r.allowed)).toBe(true);
    expect(results[200]?.allowed).toBe(false);
  });

  it('defaults to 100 events/s sustained with a burst of 200', async () => {
    const limiter = new IngestRateLimiter(redis);
    const id = tenant();

    const results = await Promise.all(
      Array.from({ length: 400 }, () => limiter.tryAcquire(id)),
    );
    const admitted = results.filter((r) => r.allowed).length;

    // Burst 200, plus whatever 100/s refilled while the 400 calls ran.
    expect(admitted).toBeGreaterThanOrEqual(200);
    expect(admitted).toBeLessThanOrEqual(230);
  });

  it('tells a rejected caller how many seconds to wait', async () => {
    const limiter = new IngestRateLimiter(redis, {
      ratePerSecond: 0.1,
      burst: 1,
    });
    const id = tenant();

    await limiter.tryAcquire(id);
    const rejected = await limiter.tryAcquire(id);

    // One token at 0.1 tokens/s takes 10 s to come back.
    expect(rejected).toEqual({ allowed: false, retryAfterSeconds: 10 });
  });

  it('admits again once tokens have refilled', async () => {
    const limiter = new IngestRateLimiter(redis, {
      ratePerSecond: 10,
      burst: 2,
    });
    const id = tenant();

    expect((await limiter.tryAcquire(id)).allowed).toBe(true);
    expect((await limiter.tryAcquire(id)).allowed).toBe(true);
    expect((await limiter.tryAcquire(id)).allowed).toBe(false);

    await sleep(250);

    expect((await limiter.tryAcquire(id)).allowed).toBe(true);
  });

  it('never refills above the burst', async () => {
    // A slow rate: the four calls below may take a while on a busy machine,
    // and at 10 tokens/s even 100 ms of delay refills less than one token.
    const limiter = new IngestRateLimiter(redis, {
      ratePerSecond: 10,
      burst: 3,
    });
    const id = tenant();

    await limiter.tryAcquire(id);
    await sleep(500); // would refill 5 tokens if uncapped

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push((await limiter.tryAcquire(id)).allowed);
    }
    expect(results).toEqual([true, true, true, false]);
  });

  it('keeps tenants independent', async () => {
    const limiter = new IngestRateLimiter(redis, {
      ratePerSecond: 1,
      burst: 1,
    });
    const noisy = tenant();
    const quiet = tenant();

    await limiter.tryAcquire(noisy);
    expect((await limiter.tryAcquire(noisy)).allowed).toBe(false);

    expect((await limiter.tryAcquire(quiet)).allowed).toBe(true);
  });

  it('admits exactly the burst when many callers race on separate connections', async () => {
    const options = { ratePerSecond: 1, burst: 50 };
    const a = new IngestRateLimiter(redis, options);
    const b = new IngestRateLimiter(redisB, options);
    const id = tenant();

    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        (i % 2 === 0 ? a : b).tryAcquire(id),
      ),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(50);
  });

  it('expires the bucket of an idle tenant', async () => {
    const limiter = new IngestRateLimiter(redis, {
      ratePerSecond: 100,
      burst: 200,
    });
    const id = tenant();

    await limiter.tryAcquire(id);

    const ttlMs = await redis.pttl(`rl:{${id}}`);
    // Refill time is 2 s for this bucket; the key must outlive it but not linger.
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(3_000);
  });
});
