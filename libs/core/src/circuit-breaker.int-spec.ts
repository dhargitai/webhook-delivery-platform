import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  type BreakerOutcome,
  CircuitBreaker,
  type CircuitBreakerOptions,
} from './circuit-breaker.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The jitter factor is 0.8 + 0.4 × rng, so 0.5 gives exactly 1. */
const NO_JITTER = () => 0.5;

describe('CircuitBreaker (real Redis)', () => {
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

  /** An endpoint id nobody else has touched, so tests never share a circuit. */
  const endpoint = () => randomUUID();

  const breaker = (
    options: Partial<CircuitBreakerOptions> = {},
    rng: () => number = NO_JITTER,
    client: Redis = redis,
  ) => new CircuitBreaker(client, options, rng);

  // The PRD fixes the key layout (hash-tagged, so one endpoint stays on one
  // cluster slot), which is why the tests may read it directly.
  const stateKey = (id: string) => `cb:{${id}}:state`;
  const windowKey = (id: string) => `cb:{${id}}:win`;

  const recordMany = async (
    cb: CircuitBreaker,
    id: string,
    outcome: BreakerOutcome,
    count: number,
  ) => {
    for (let i = 0; i < count; i++) await cb.record(id, outcome);
  };

  const redisNowMs = async () => {
    const [seconds, micros] = await redis.time();
    return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  };

  /** How far in the future the circuit's `openUntil` lies, in ms. */
  const remainingCooldownMs = async (id: string) =>
    Number(await redis.hget(stateKey(id), 'openUntil')) - (await redisNowMs());

  it('stays closed below the minimum samples, then trips on the 20th failure', async () => {
    const cb = breaker();
    const id = endpoint();

    await recordMany(cb, id, 'failure', 19);
    expect(await cb.allow(id)).toEqual({ kind: 'allow' });

    await cb.record(id, 'failure');
    expect(await cb.allow(id)).toEqual({ kind: 'deny' });
  });

  it('trips at exactly the failure rate and not below it', async () => {
    const cb = breaker();
    const atRate = endpoint();
    const belowRate = endpoint();

    // The last sample decides, so the minimum is only reached with it.
    await recordMany(cb, atRate, 'success', 10);
    await recordMany(cb, atRate, 'failure', 10);
    await recordMany(cb, belowRate, 'success', 11);
    await recordMany(cb, belowRate, 'failure', 9);

    expect(await cb.allow(atRate)).toEqual({ kind: 'deny' });
    expect(await cb.allow(belowRate)).toEqual({ kind: 'allow' });
  });

  it('forgets samples older than the window', async () => {
    const cb = breaker({ windowMs: 500 });
    const id = endpoint();

    // Each write renews the window key's expiry, so the old samples can only
    // leave through the trim by age, not by the whole key expiring.
    await recordMany(cb, id, 'failure', 15);
    await sleep(300);
    await recordMany(cb, id, 'failure', 4);
    await sleep(300);
    // The first 15 are now 600 ms old, the last 4 300 ms: 5 of 20 are kept.
    await cb.record(id, 'failure');

    expect(await cb.allow(id)).toEqual({ kind: 'allow' });
    expect(await redis.zcard(windowKey(id))).toBe(5);
  });

  it('keeps at most the newest samples, in a window that expires', async () => {
    const cb = breaker({ maxWindowSamples: 10, windowMs: 5_000 });
    const id = endpoint();

    await recordMany(cb, id, 'success', 15);

    expect(await redis.zcard(windowKey(id))).toBe(10);
    const ttlMs = await redis.pttl(windowKey(id));
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(5_000);
  });

  it('only counts the samples it keeps, dropping the oldest', async () => {
    const cb = breaker({ maxWindowSamples: 20 });
    const id = endpoint();

    // 9 of 20 failed. Each new failure then pushes out one of the old ones,
    // so the window stays at 9 of 20; uncapped, 11 of 22 would trip it.
    await recordMany(cb, id, 'failure', 9);
    await recordMany(cb, id, 'success', 11);
    await recordMany(cb, id, 'failure', 9);
    expect(await cb.allow(id)).toEqual({ kind: 'allow' });

    // The old failures are gone, so the next one pushes out a success: 10 of 20.
    await cb.record(id, 'failure');
    expect(await cb.allow(id)).toEqual({ kind: 'deny' });
  });

  it('opens at level 0 for the base cooldown and clears the window', async () => {
    const cb = breaker();
    const id = endpoint();

    await recordMany(cb, id, 'failure', 20);

    const state = await redis.hgetall(stateKey(id));
    expect(state).toMatchObject({ state: 'open', level: '0' });
    // A few ms pass between the trip and reading Redis's clock.
    const remaining = await remainingCooldownMs(id);
    expect(remaining).toBeGreaterThan(30_000 - 1_000);
    expect(remaining).toBeLessThanOrEqual(30_000);
    expect(await redis.exists(windowKey(id))).toBe(0);
    // The state outlives the cooldown, so a probe can still find it.
    expect(await redis.pttl(stateKey(id))).toBeGreaterThan(30_000);
  });

  it.each([
    ['0.8x', () => 0, 24_000],
    ['1.2x', () => 0.999_999, 36_000],
  ])('spreads the cooldown by the jitter (%s)', async (_, rng, expected) => {
    const cb = breaker({}, rng);
    const id = endpoint();

    await recordMany(cb, id, 'failure', 20);

    const remaining = await remainingCooldownMs(id);
    expect(remaining).toBeGreaterThan(expected - 1_000);
    expect(remaining).toBeLessThanOrEqual(expected);
  });

  it('trips once when many failures race on separate connections', async () => {
    const a = breaker();
    const b = breaker({}, NO_JITTER, redisB);
    const id = endpoint();

    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (i % 2 === 0 ? a : b).record(id, 'failure'),
      ),
    );

    expect(await redis.hgetall(stateKey(id))).toMatchObject({
      state: 'open',
      level: '0',
    });
    // Failures after the trip are not collected for a second one.
    expect(await redis.exists(windowKey(id))).toBe(0);
  });

  it('ignores results recorded while the circuit is open', async () => {
    const cb = breaker();
    const id = endpoint();
    await recordMany(cb, id, 'failure', 20);
    const opened = await redis.hgetall(stateKey(id));

    await cb.record(id, 'failure');
    await cb.record(id, 'success');

    expect(await redis.hgetall(stateKey(id))).toEqual(opened);
    expect(await redis.exists(windowKey(id))).toBe(0);
  });

  it('keeps endpoints independent', async () => {
    const cb = breaker();
    const dead = endpoint();
    const healthy = endpoint();

    await recordMany(cb, dead, 'failure', 20);

    expect(await cb.allow(dead)).toEqual({ kind: 'deny' });
    expect(await cb.allow(healthy)).toEqual({ kind: 'allow' });
  });

  describe('half-open', () => {
    // Short enough to wait out in a test; the lease is longer than the
    // cooldown, as the PRD's 15 s lease is longer than the 10 s HTTP timeout.
    const fast: Partial<CircuitBreakerOptions> = {
      baseCooldownMs: 200,
      probeLeaseMs: 300,
    };

    const trip = (cb: CircuitBreaker, id: string) =>
      recordMany(cb, id, 'failure', 20);

    /** Asks once and expects to be elected the probe. */
    const probeToken = async (cb: CircuitBreaker, id: string) => {
      const decision = await cb.allow(id);
      if (decision.kind !== 'probe') {
        throw new Error(`expected a probe, got ${decision.kind}`);
      }
      return decision.token;
    };

    it('elects exactly one probe once the cooldown has passed', async () => {
      const a = breaker(fast);
      const b = breaker(fast, NO_JITTER, redisB);
      const id = endpoint();
      await trip(a, id);

      expect(await a.allow(id)).toEqual({ kind: 'deny' });
      await sleep(250);

      const decisions = await Promise.all(
        Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b).allow(id)),
      );

      expect(decisions.filter((d) => d.kind === 'probe')).toHaveLength(1);
      expect(decisions.filter((d) => d.kind === 'deny')).toHaveLength(19);
      expect(await redis.hget(stateKey(id), 'state')).toBe('half_open');
    });

    it('closes on a successful probe and starts again from level 0', async () => {
      const cb = breaker(fast);
      const id = endpoint();
      await trip(cb, id);
      await sleep(250);

      await cb.record(id, 'success', await probeToken(cb, id));

      expect(await cb.allow(id)).toEqual({ kind: 'allow' });
      expect(await redis.exists(stateKey(id))).toBe(0);

      // A new trip is a first trip again: the base cooldown, not a doubled one.
      await trip(cb, id);
      expect(await redis.hget(stateKey(id), 'level')).toBe('0');
      expect(await remainingCooldownMs(id)).toBeLessThanOrEqual(200);
    });

    it('reopens on a failed probe with twice the cooldown', async () => {
      const cb = breaker(fast);
      const id = endpoint();
      await trip(cb, id);
      await sleep(250);

      await cb.record(id, 'failure', await probeToken(cb, id));

      expect(await cb.allow(id)).toEqual({ kind: 'deny' });
      expect(await redis.hgetall(stateKey(id))).toMatchObject({
        state: 'open',
        level: '1',
      });
      const remaining = await remainingCooldownMs(id);
      expect(remaining).toBeGreaterThan(400 - 100);
      expect(remaining).toBeLessThanOrEqual(400);
    });

    it('caps the cooldown, then jitters it, and stops raising the level at the maximum', async () => {
      // Jitter at its top (1.2x). Applied before the cap, a doubled cooldown
      // would come out at exactly the 150 ms cap; applied after, at 180 ms.
      const cb = breaker(
        { baseCooldownMs: 100, maxCooldownMs: 150, maxLevel: 1 },
        () => 0.999_999,
      );
      const id = endpoint();

      await trip(cb, id);
      const first = await remainingCooldownMs(id);
      expect(first).toBeGreaterThan(120 - 50);
      expect(first).toBeLessThanOrEqual(120);

      for (let failedProbes = 1; failedProbes <= 2; failedProbes++) {
        await sleep(200);
        await cb.record(id, 'failure', await probeToken(cb, id));

        expect(await redis.hget(stateKey(id), 'level')).toBe('1');
        const remaining = await remainingCooldownMs(id);
        expect(remaining).toBeGreaterThan(160);
        expect(remaining).toBeLessThanOrEqual(180);
      }
    });

    it('ignores results that do not carry the probe token', async () => {
      const cb = breaker(fast);
      const id = endpoint();
      await trip(cb, id);
      await sleep(250);
      await probeToken(cb, id);

      // Late results of calls that started before the trip.
      await cb.record(id, 'success');
      await cb.record(id, 'failure');
      await cb.record(id, 'success', randomUUID());

      expect(await redis.hget(stateKey(id), 'state')).toBe('half_open');
      expect(await cb.allow(id)).toEqual({ kind: 'deny' });
    });

    it('elects a new probe once a dead probe lease has run out', async () => {
      const cb = breaker(fast);
      const id = endpoint();
      await trip(cb, id);
      await sleep(250);

      // The winner's worker dies: it never records.
      const dead = await probeToken(cb, id);
      expect(await cb.allow(id)).toEqual({ kind: 'deny' });

      await sleep(350);
      const next = await probeToken(cb, id);
      expect(next).not.toBe(dead);

      // The dead probe's result, should it still arrive, no longer counts.
      await cb.record(id, 'success', dead);
      expect(await redis.hget(stateKey(id), 'state')).toBe('half_open');

      await cb.record(id, 'success', next);
      expect(await cb.allow(id)).toEqual({ kind: 'allow' });
    });
  });
});
