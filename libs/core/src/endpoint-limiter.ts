import { randomUUID } from 'node:crypto';
import type { Callback, Redis, Result } from 'ioredis';

export interface EndpointLimiterOptions {
  /** How many deliveries to one endpoint may be in flight at once. */
  maxConcurrent: number;
  /** How long a permit holds its slot unless released first. */
  leaseMs: number;
  /** Sustained calls per second to one endpoint, the bucket's refill rate. */
  ratePerSecond: number;
  /** Bucket capacity: how many calls may start at once after a quiet spell. */
  burst: number;
}

/** The part of the limits one endpoint may override: its rate. */
export type EndpointRate = Pick<
  EndpointLimiterOptions,
  'ratePerSecond' | 'burst'
>;

// PRD locked parameters (section 6, "Fairness and limits").
export const DEFAULT_ENDPOINT_LIMITER: EndpointLimiterOptions = {
  maxConcurrent: 20,
  leaseMs: 30_000,
  ratePerSecond: 20,
  burst: 40,
};

/** One held slot. Pass it back to `release` once the call is over. */
export interface Permit {
  endpointId: string;
  token: string;
}

export type AcquireResult =
  | { kind: 'permit'; permit: Permit }
  | { kind: 'denied'; reason: 'concurrency_cap' | 'rate_limited' };

/**
 * Both limits as one atomic step: run as separate commands, two workers
 * could both see 19 holders, or one token left, and both go ahead.
 *
 * The slots are a sorted set, one member per permit token, scored by the
 * time its lease ends. A token per permit, not a counter, lets each permit
 * expire on its own, and lets a release free its own slot and no other: a
 * worker whose lease ran out must not free the slot someone else took.
 *
 * The rate is a token bucket, the same refill as the ingest limiter's. A
 * denial by one limit leaves the other untouched: a call that never starts
 * must neither hold a slot nor spend a token.
 *
 * Time comes from Redis (`TIME`), so workers with skewed clocks agree on
 * when a lease ends and how far the bucket has refilled.
 *
 * KEYS: slots (sorted set), bucket (hash).
 * ARGV: token, maxConcurrent, leaseMs, ratePerSecond, burst.
 * Returns 1 when the call may start, 0 at the concurrency cap, -1 when the
 * rate is spent.
 */
const ACQUIRE_LUA = `
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local maxConcurrent = tonumber(ARGV[2])
local leaseMs = tonumber(ARGV[3])
local rate = tonumber(ARGV[4])
local burst = tonumber(ARGV[5])

-- A permit whose lease ended was leaked (its worker died or never
-- released it): it stops holding a slot here, lazily, with no timer.
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', nowMs)
if redis.call('ZCARD', KEYS[1]) >= maxConcurrent then
  return 0
end

local state = redis.call('HMGET', KEYS[2], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = nowMs
end
tokens = math.min(burst, tokens + math.max(0, nowMs - ts) * rate / 1000)

-- Keep the bucket until a full one would have refilled, so an endpoint
-- that goes quiet leaves nothing behind.
local bucketTtlMs = math.ceil(burst / rate * 1000) + 1000
if tokens < 1 then
  -- Saved even on a denial, so the refill is never counted twice.
  redis.call('HSET', KEYS[2], 'tokens', tostring(tokens), 'ts', nowMs)
  redis.call('PEXPIRE', KEYS[2], bucketTtlMs)
  return -1
end
redis.call('HSET', KEYS[2], 'tokens', tostring(tokens - 1), 'ts', nowMs)
redis.call('PEXPIRE', KEYS[2], bucketTtlMs)

redis.call('ZADD', KEYS[1], nowMs + leaseMs, ARGV[1])
-- The newest lease ends last, so the key outlives every member.
redis.call('PEXPIRE', KEYS[1], leaseMs)
return 1
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    endpointAcquire(
      slotsKey: string,
      bucketKey: string,
      token: string,
      maxConcurrent: number,
      leaseMs: number,
      ratePerSecond: number,
      burst: number,
      callback?: Callback<number>,
    ): Result<number, Context>;
  }
}

/** What a delivery needs from the limiter: take a slot, give it back. */
export type EndpointSlots = Pick<EndpointLimiter, 'acquire' | 'release'>;

/**
 * Per-endpoint limits, shared by every worker through Redis: at most
 * `maxConcurrent` deliveries to one endpoint at a time, so one slow endpoint
 * cannot hold every worker slot, and at most `ratePerSecond` calls a second
 * (with bursts up to `burst`), so a recovered endpoint is not flooded.
 */
export class EndpointLimiter {
  private readonly options: EndpointLimiterOptions;

  constructor(
    private readonly redis: Redis,
    options: Partial<EndpointLimiterOptions> = {},
  ) {
    this.options = { ...DEFAULT_ENDPOINT_LIMITER, ...options };
    validate(this.options);
    // Registered once per client; ioredis then calls it with EVALSHA.
    // Defining it twice with identical source is harmless.
    this.redis.defineCommand('endpointAcquire', {
      numberOfKeys: 2,
      lua: ACQUIRE_LUA,
    });
  }

  /**
   * `rate` overrides the limiter's rate for this endpoint. The bucket is the
   * endpoint's whatever the override, so a lower burst than before only
   * clamps the tokens it holds.
   */
  async acquire(
    endpointId: string,
    rate: Partial<EndpointRate> = {},
  ): Promise<AcquireResult> {
    const { maxConcurrent, leaseMs } = this.options;
    const { ratePerSecond, burst } = { ...this.options, ...rate };
    // Checked before Redis: a bad stored override must fail loudly, not
    // reach the script as a NaN or a zero rate.
    validateRate({ ratePerSecond, burst });
    const token = randomUUID();
    const taken = await this.redis.endpointAcquire(
      slotsKey(endpointId),
      bucketKey(endpointId),
      token,
      maxConcurrent,
      leaseMs,
      ratePerSecond,
      burst,
    );
    if (taken === 1) return { kind: 'permit', permit: { endpointId, token } };
    return {
      kind: 'denied',
      reason: taken === 0 ? 'concurrency_cap' : 'rate_limited',
    };
  }

  /** Removes only this permit's token, so a second release is a no-op. */
  async release(permit: Permit): Promise<void> {
    await this.redis.zrem(slotsKey(permit.endpointId), permit.token);
  }
}

/**
 * The braces make the endpoint id a hash tag, so the limiter's keys share
 * one cluster slot with each other (one script touches both) and with the
 * circuit breaker's.
 */
function slotsKey(endpointId: string): string {
  return `el:{${endpointId}}:slots`;
}

function bucketKey(endpointId: string): string {
  return `el:{${endpointId}}:bucket`;
}

function validate(options: EndpointLimiterOptions): void {
  const { maxConcurrent, leaseMs } = options;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError(
      `maxConcurrent must be a positive integer, got ${maxConcurrent}`,
    );
  }
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new RangeError(`leaseMs must be a positive number, got ${leaseMs}`);
  }
  validateRate(options);
}

function validateRate({ ratePerSecond, burst }: EndpointRate): void {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    throw new RangeError(
      `ratePerSecond must be a positive number, got ${ratePerSecond}`,
    );
  }
  if (!Number.isInteger(burst) || burst < 1) {
    throw new RangeError(`burst must be a positive integer, got ${burst}`);
  }
}
