import type { Callback, Redis, Result } from 'ioredis';

export interface IngestRateLimitOptions {
  /** Sustained admission rate, tokens refilled per second. */
  ratePerSecond: number;
  /** Bucket capacity: how many calls may arrive at once. */
  burst: number;
}

export type RateLimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

// PRD locked parameters: 100 events/s sustained, burst 200 per tenant.
export const DEFAULT_INGEST_RATE_LIMIT: IngestRateLimitOptions = {
  ratePerSecond: 100,
  burst: 200,
};

/**
 * Token bucket as one Lua script, so the refill, the check and the decrement
 * are a single atomic step. Two round trips would let concurrent callers all
 * read the same token count and overshoot the burst.
 *
 * Time comes from Redis (`TIME`), not from the callers, so application
 * instances with skewed clocks cannot disagree about refills.
 *
 * KEYS[1] bucket key; ARGV[1] tokens per second; ARGV[2] burst.
 * Returns { allowed (1|0), retryAfterSeconds }.
 */
const TOKEN_BUCKET_LUA = `
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = nowMs
end

local elapsedMs = math.max(0, nowMs - ts)
tokens = math.min(burst, tokens + elapsedMs * rate / 1000)

local allowed = 0
local retryAfter = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retryAfter = math.max(1, math.ceil((1 - tokens) / rate))
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', nowMs)
-- Keep the key until a full bucket would have refilled, then let it go so
-- idle tenants do not leave state behind.
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000) + 1000)

return { allowed, retryAfter }
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    tokenBucket(
      key: string,
      ratePerSecond: number,
      burst: number,
      callback?: Callback<[number, number]>,
    ): Result<[number, number], Context>;
  }
}

/** Per-tenant ingest limit for `POST /v1/events`. */
export class IngestRateLimiter {
  private readonly options: IngestRateLimitOptions;

  constructor(
    private readonly redis: Redis,
    options: Partial<IngestRateLimitOptions> = {},
  ) {
    this.options = { ...DEFAULT_INGEST_RATE_LIMIT, ...options };
    // Registers the script once per client; ioredis then calls it with EVALSHA.
    // Defining it twice with identical source is harmless.
    this.redis.defineCommand('tokenBucket', {
      numberOfKeys: 1,
      lua: TOKEN_BUCKET_LUA,
    });
  }

  async tryAcquire(tenantId: string): Promise<RateLimitResult> {
    // The braces make the tenant id a hash tag, keeping the key on a single
    // cluster slot should Redis ever run clustered.
    const [allowed, retryAfterSeconds] = await this.redis.tokenBucket(
      `rl:{${tenantId}}`,
      this.options.ratePerSecond,
      this.options.burst,
    );
    return allowed === 1
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds };
  }
}
