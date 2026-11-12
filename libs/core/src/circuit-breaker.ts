import { randomUUID } from 'node:crypto';
import type { Callback, Redis, Result } from 'ioredis';
import type { HttpResult } from './safe-http-client.js';

/** How one attempt counts toward an endpoint's circuit. */
export type BreakerOutcome = 'success' | 'failure';

/** Whether a worker may call the endpoint now. */
export type BreakerDecision = { kind: 'allow' } | { kind: 'deny' };

export interface CircuitBreakerOptions {
  /** The sliding window the failure rate is measured over. */
  windowMs: number;
  /** No trip below this many samples in the window, however many fail. */
  minSamples: number;
  /** The circuit opens once this share of the window's samples failed. */
  failureRate: number;
  /** The window keeps at most this many samples, the newest. */
  maxWindowSamples: number;
  /** The cooldown of a first trip; it doubles with each failed probe. */
  baseCooldownMs: number;
  /** How many times the cooldown may double. */
  maxLevel: number;
  /** No cooldown is longer than this, before jitter. */
  maxCooldownMs: number;
  /** Each cooldown is spread by up to this share either way. */
  jitter: number;
  /**
   * How long a probe holds its election. Above the HTTP timeout, so a probe
   * that is still running is never replaced, while one whose worker died
   * cannot keep the circuit half-open for ever.
   */
  probeLeaseMs: number;
}

// PRD locked parameters (section 6, "Circuit breaker").
export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerOptions = {
  windowMs: 60_000,
  minSamples: 20,
  failureRate: 0.5,
  maxWindowSamples: 1_000,
  baseCooldownMs: 30_000,
  maxLevel: 5,
  maxCooldownMs: 600_000,
  jitter: 0.2,
  probeLeaseMs: 15_000,
};

/**
 * PRD: a timeout, a connection or SSRF-block error, a 5xx, 408 and 429 mean
 * the endpoint is down or asking to be left alone. Anything else, a 3xx or an
 * oversized reply included, means it answered: the circuit stays as it is,
 * while the delivery itself still fails and is retried.
 */
export function breakerOutcome(result: HttpResult): BreakerOutcome {
  if (result.outcome === 'success') return 'success';
  switch (result.kind) {
    case 'timeout':
    case 'connect_timeout':
    case 'network_error':
    case 'ssrf_blocked':
      return 'failure';
    case 'http_error':
      return isUnavailableStatus(result.status) ? 'failure' : 'success';
    case 'redirect':
    case 'response_too_large':
    case 'invalid_url':
      return 'success';
  }
}

function isUnavailableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Records one sample and decides whether the circuit trips, as one atomic
 * step: run as separate commands, two workers could each count 19 samples and
 * neither would trip, or both would and one would overwrite the other's state.
 *
 * Time comes from Redis (`TIME`), so workers with skewed clocks agree on the
 * window and the cooldown. The jitter factor comes from the caller, which
 * keeps the script deterministic.
 *
 * KEYS: window (sorted set), state (hash).
 * ARGV: outcome ('s'|'f'), unique sample id, windowMs, minSamples,
 *       failureRate, maxWindowSamples, baseCooldownMs, maxCooldownMs,
 *       jitterFactor, probeLeaseMs.
 */
const RECORD_LUA = `
local time = redis.call('TIME')
local nowUs = tonumber(time[1]) * 1000000 + tonumber(time[2])
local nowMs = math.floor(nowUs / 1000)
local windowMs = tonumber(ARGV[3])
local minSamples = tonumber(ARGV[4])
local failureRate = tonumber(ARGV[5])
local maxSamples = tonumber(ARGV[6])
local baseCooldownMs = tonumber(ARGV[7])
local maxCooldownMs = tonumber(ARGV[8])
local jitterFactor = tonumber(ARGV[9])
local probeLeaseMs = tonumber(ARGV[10])

-- An open circuit takes no samples: a result arriving now belongs to a call
-- that started before the trip, and must not count toward the next one.
local state = redis.call('HGET', KEYS[2], 'state')
if state == 'open' then
  return 0
end

-- Scored in microseconds, so samples rarely tie: Redis orders tied members by
-- name, and trimming by rank would then drop by name, not by age. The member
-- starts with the random id and ends with the outcome, so the rare tie is
-- broken at random, never by outcome.
redis.call('ZADD', KEYS[1], nowUs, ARGV[2] .. ':' .. ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', nowUs - windowMs * 1000)
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -(maxSamples + 1))

local members = redis.call('ZRANGE', KEYS[1], 0, -1)
local total = #members
local failures = 0
for _, member in ipairs(members) do
  if string.sub(member, -1) == 'f' then
    failures = failures + 1
  end
end

if total < minSamples or failures < failureRate * total then
  -- An endpoint that goes quiet leaves nothing behind.
  redis.call('PEXPIRE', KEYS[1], windowMs)
  return 0
end

-- Trip. The cap applies first, then the jitter, so cooldowns at the top
-- level still spread out instead of all ending together.
local level = tonumber(redis.call('HGET', KEYS[2], 'level')) or 0
local cooldownMs = math.floor(
  math.min(baseCooldownMs * 2 ^ level, maxCooldownMs) * jitterFactor)
redis.call('HSET', KEYS[2], 'state', 'open', 'openUntil', nowMs + cooldownMs,
  'level', level)
-- The next closed period starts from an empty window.
redis.call('DEL', KEYS[1])
-- Long enough for a probe to be elected and to report after the cooldown.
redis.call('PEXPIRE', KEYS[2], cooldownMs + windowMs + probeLeaseMs)
return 1
`;

/**
 * KEYS: state (hash). Returns 'allow' or 'deny'.
 */
const ALLOW_LUA = `
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'open' then
  return 'deny'
end
return 'allow'
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    circuitRecord(
      windowKey: string,
      stateKey: string,
      outcome: string,
      sampleId: string,
      windowMs: number,
      minSamples: number,
      failureRate: number,
      maxWindowSamples: number,
      baseCooldownMs: number,
      maxCooldownMs: number,
      jitterFactor: number,
      probeLeaseMs: number,
      callback?: Callback<number>,
    ): Result<number, Context>;
    circuitAllow(
      stateKey: string,
      callback?: Callback<string>,
    ): Result<string, Context>;
  }
}

/**
 * Per-endpoint circuit breaker, its state shared by every worker through
 * Redis: closed, open, then half-open with a single probe.
 */
export class CircuitBreaker {
  private readonly options: CircuitBreakerOptions;

  constructor(
    private readonly redis: Redis,
    options: Partial<CircuitBreakerOptions> = {},
    /** In [0, 1): spreads each cooldown within the jitter. */
    private readonly rng: () => number = Math.random,
  ) {
    this.options = { ...DEFAULT_CIRCUIT_BREAKER, ...options };
    validate(this.options);
    // Registered once per client; ioredis then calls them with EVALSHA.
    // Defining them twice with identical source is harmless.
    this.redis.defineCommand('circuitRecord', {
      numberOfKeys: 2,
      lua: RECORD_LUA,
    });
    this.redis.defineCommand('circuitAllow', {
      numberOfKeys: 1,
      lua: ALLOW_LUA,
    });
  }

  async allow(endpointId: string): Promise<BreakerDecision> {
    const decision = await this.redis.circuitAllow(keys(endpointId).state);
    return decision === 'allow' ? { kind: 'allow' } : { kind: 'deny' };
  }

  async record(endpointId: string, outcome: BreakerOutcome): Promise<void> {
    const { window, state } = keys(endpointId);
    const o = this.options;
    await this.redis.circuitRecord(
      window,
      state,
      outcome === 'failure' ? 'f' : 's',
      randomUUID(),
      o.windowMs,
      o.minSamples,
      o.failureRate,
      o.maxWindowSamples,
      o.baseCooldownMs,
      o.maxCooldownMs,
      1 - o.jitter + 2 * o.jitter * this.rng(),
      o.probeLeaseMs,
    );
  }
}

/**
 * PRD key layout. The braces make the endpoint id a hash tag, so all of an
 * endpoint's keys share one cluster slot, as a multi-key script requires.
 */
function keys(endpointId: string) {
  return {
    window: `cb:{${endpointId}}:win`,
    state: `cb:{${endpointId}}:state`,
    probe: `cb:{${endpointId}}:probe`,
  };
}

function validate(options: CircuitBreakerOptions): void {
  const {
    windowMs,
    minSamples,
    failureRate,
    maxWindowSamples,
    baseCooldownMs,
    maxLevel,
    maxCooldownMs,
    jitter,
    probeLeaseMs,
  } = options;
  const durations = { windowMs, baseCooldownMs, maxCooldownMs, probeLeaseMs };
  for (const [name, value] of Object.entries(durations)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive number, got ${value}`);
    }
  }
  const counts = { minSamples, maxWindowSamples };
  for (const [name, value] of Object.entries(counts)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer, got ${value}`);
    }
  }
  if (!Number.isInteger(maxLevel) || maxLevel < 0) {
    throw new RangeError(
      `maxLevel must be a non-negative integer, got ${maxLevel}`,
    );
  }
  if (!(failureRate > 0 && failureRate <= 1)) {
    throw new RangeError(`failureRate must be in (0, 1], got ${failureRate}`);
  }
  if (!(jitter >= 0 && jitter < 1)) {
    throw new RangeError(`jitter must be in [0, 1), got ${jitter}`);
  }
}
