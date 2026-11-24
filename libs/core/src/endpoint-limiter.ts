import { randomUUID } from 'node:crypto';
import type { Callback, Redis, Result } from 'ioredis';

export interface EndpointLimiterOptions {
  /** How many deliveries to one endpoint may be in flight at once. */
  maxConcurrent: number;
  /** How long a permit holds its slot unless released first. */
  leaseMs: number;
}

// PRD locked parameters (section 6, "Fairness and limits").
export const DEFAULT_ENDPOINT_LIMITER: EndpointLimiterOptions = {
  maxConcurrent: 20,
  leaseMs: 30_000,
};

/** One held slot. Pass it back to `release` once the call is over. */
export interface Permit {
  endpointId: string;
  token: string;
}

export type AcquireResult =
  | { kind: 'permit'; permit: Permit }
  | { kind: 'denied'; reason: 'concurrency_cap' };

/**
 * Counts and takes a slot as one atomic step: run as two commands, two
 * workers could both see 19 holders and both take the 20th slot.
 *
 * The slots are a sorted set, one member per permit token, scored by the
 * time its lease ends. A token per permit, not a counter, lets a release
 * free its own slot and no other.
 *
 * Time comes from Redis (`TIME`), so workers with skewed clocks agree on
 * when a lease ends.
 *
 * KEYS: slots (sorted set). ARGV: token, maxConcurrent, leaseMs.
 * Returns 1 when the slot was taken, 0 when the endpoint is at its cap.
 */
const ACQUIRE_LUA = `
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local maxConcurrent = tonumber(ARGV[2])
local leaseMs = tonumber(ARGV[3])

if redis.call('ZCARD', KEYS[1]) >= maxConcurrent then
  return 0
end
redis.call('ZADD', KEYS[1], nowMs + leaseMs, ARGV[1])
return 1
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    endpointAcquire(
      slotsKey: string,
      token: string,
      maxConcurrent: number,
      leaseMs: number,
      callback?: Callback<number>,
    ): Result<number, Context>;
  }
}

/**
 * Per-endpoint concurrency cap, shared by every worker through Redis: at
 * most `maxConcurrent` deliveries to one endpoint at a time, so one slow
 * endpoint cannot hold every worker slot.
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
      numberOfKeys: 1,
      lua: ACQUIRE_LUA,
    });
  }

  async acquire(endpointId: string): Promise<AcquireResult> {
    const token = randomUUID();
    const taken = await this.redis.endpointAcquire(
      slotsKey(endpointId),
      token,
      this.options.maxConcurrent,
      this.options.leaseMs,
    );
    return taken === 1
      ? { kind: 'permit', permit: { endpointId, token } }
      : { kind: 'denied', reason: 'concurrency_cap' };
  }

  /** Removes only this permit's token, so a second release is a no-op. */
  async release(permit: Permit): Promise<void> {
    await this.redis.zrem(slotsKey(permit.endpointId), permit.token);
  }
}

/**
 * The braces make the endpoint id a hash tag, so the limiter's keys share
 * one cluster slot with each other and with the circuit breaker's.
 */
function slotsKey(endpointId: string): string {
  return `el:{${endpointId}}:slots`;
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
}
