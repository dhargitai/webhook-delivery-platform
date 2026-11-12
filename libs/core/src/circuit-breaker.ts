import type { Redis } from 'ioredis';
import type { HttpResult } from './safe-http-client.js';

/** How one attempt counts toward an endpoint's circuit. */
export type BreakerOutcome = 'success' | 'failure';

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
  }
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
