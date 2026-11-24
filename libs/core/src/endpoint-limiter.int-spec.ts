import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  type AcquireResult,
  EndpointLimiter,
  type Permit,
} from './endpoint-limiter.js';

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
});
