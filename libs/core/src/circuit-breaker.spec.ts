import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  breakerOutcome,
  CircuitBreaker,
  type CircuitBreakerOptions,
  DEFAULT_CIRCUIT_BREAKER,
} from './circuit-breaker.js';
import type { HttpFailureKind, HttpResult } from './safe-http-client.js';

describe('DEFAULT_CIRCUIT_BREAKER', () => {
  // Locked by the PRD: changing any number is a deliberate decision.
  it('holds the PRD breaker parameters', () => {
    expect(DEFAULT_CIRCUIT_BREAKER).toEqual({
      windowMs: 60_000,
      minSamples: 20,
      failureRate: 0.5,
      maxWindowSamples: 1_000,
      baseCooldownMs: 30_000,
      maxLevel: 5,
      maxCooldownMs: 600_000,
      jitter: 0.2,
      probeLeaseMs: 15_000,
    });
  });
});

describe('CircuitBreaker options', () => {
  // Never connects: a lazy client opens its socket on the first command only.
  const redis = new Redis({ lazyConnect: true });
  afterAll(() => redis.disconnect());

  it.each<[string, Partial<CircuitBreakerOptions>]>([
    ['a zero window', { windowMs: 0 }],
    ['a negative window', { windowMs: -1 }],
    ['an infinite window', { windowMs: Number.POSITIVE_INFINITY }],
    ['zero minimum samples', { minSamples: 0 }],
    ['fractional minimum samples', { minSamples: 2.5 }],
    ['a zero failure rate', { failureRate: 0 }],
    ['a failure rate above 1', { failureRate: 1.1 }],
    ['a window cap of zero samples', { maxWindowSamples: 0 }],
    ['a zero base cooldown', { baseCooldownMs: 0 }],
    ['a negative maximum level', { maxLevel: -1 }],
    ['a fractional maximum level', { maxLevel: 1.5 }],
    ['a zero cooldown cap', { maxCooldownMs: 0 }],
    ['a negative jitter', { jitter: -0.1 }],
    ['a jitter of 1', { jitter: 1 }],
    ['a zero probe lease', { probeLeaseMs: 0 }],
    ['a NaN probe lease', { probeLeaseMs: Number.NaN }],
  ])('refuses %s', (_, options) => {
    expect(() => new CircuitBreaker(redis, options)).toThrow(RangeError);
  });

  it('accepts a partial override and the edges of the valid ranges', () => {
    expect(
      () =>
        new CircuitBreaker(redis, {
          windowMs: 300,
          failureRate: 1,
          maxLevel: 0,
          jitter: 0,
        }),
    ).not.toThrow();
  });
});

describe('breakerOutcome', () => {
  const failed = (kind: HttpFailureKind, status?: number): HttpResult => ({
    outcome: 'failed',
    kind,
    ...(status === undefined ? {} : { status }),
    latencyMs: 5,
  });

  // PRD: timeout, connection or SSRF-block error, 5xx, 408 and 429 count as
  // breaker failures: the endpoint is down or asking to be left alone.
  it.each<[string, HttpResult]>([
    ['a total timeout', failed('timeout')],
    ['a connect timeout', failed('connect_timeout')],
    ['a network error', failed('network_error')],
    ['an SSRF block', failed('ssrf_blocked')],
    ['HTTP 500', failed('http_error', 500)],
    ['HTTP 503', failed('http_error', 503)],
    ['HTTP 599', failed('http_error', 599)],
    ['HTTP 408', failed('http_error', 408)],
    ['HTTP 429', failed('http_error', 429)],
  ])('counts %s as a failure', (_, result) => {
    expect(breakerOutcome(result)).toBe('failure');
  });

  // The endpoint answered, so it is reachable. The delivery itself still
  // fails and is retried; only the circuit is unaffected.
  it.each<[string, HttpResult]>([
    ['a 2xx', { outcome: 'success', status: 204, latencyMs: 5, snippet: '' }],
    ['HTTP 400', failed('http_error', 400)],
    ['HTTP 404', failed('http_error', 404)],
    ['HTTP 410', failed('http_error', 410)],
    ['HTTP 499', failed('http_error', 499)],
    ['a redirect', failed('redirect', 302)],
    ['an oversized response', failed('response_too_large', 200)],
    ['an invalid URL', failed('invalid_url')],
  ])('counts %s as a success', (_, result) => {
    expect(breakerOutcome(result)).toBe('success');
  });
});
