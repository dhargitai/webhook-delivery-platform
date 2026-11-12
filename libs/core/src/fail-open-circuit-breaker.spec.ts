import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BreakerDecision,
  BreakerOutcome,
  EndpointCircuit,
} from './circuit-breaker.js';
import { FailOpenCircuitBreaker } from './fail-open-circuit-breaker.js';

class FakeCircuit implements EndpointCircuit {
  decision: BreakerDecision = { kind: 'allow' };
  failWith?: Error;
  readonly recorded: {
    endpointId: string;
    outcome: BreakerOutcome;
    probeToken?: string;
  }[] = [];

  async allow(_endpointId: string): Promise<BreakerDecision> {
    if (this.failWith) throw this.failWith;
    return this.decision;
  }

  async record(
    endpointId: string,
    outcome: BreakerOutcome,
    probeToken?: string,
  ): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.recorded.push({ endpointId, outcome, probeToken });
  }
}

interface Reported {
  error: unknown;
  context: { operation: 'allow' | 'record'; endpointId: string };
}

describe('FailOpenCircuitBreaker', () => {
  let inner: FakeCircuit;
  let reported: Reported[];
  let breaker: FailOpenCircuitBreaker;

  beforeEach(() => {
    inner = new FakeCircuit();
    reported = [];
    breaker = new FailOpenCircuitBreaker(inner, (error, context) =>
      reported.push({ error, context }),
    );
  });

  it.each<BreakerDecision>([
    { kind: 'allow' },
    { kind: 'deny' },
    { kind: 'probe', token: 'token-1' },
  ])('passes a $kind decision through', async (decision) => {
    inner.decision = decision;

    expect(await breaker.allow('endpoint-1')).toEqual(decision);
  });

  it('passes the endpoint, the outcome and the probe token to record', async () => {
    await breaker.record('endpoint-1', 'failure', 'token-1');
    await breaker.record('endpoint-2', 'success');

    expect(inner.recorded).toEqual([
      { endpointId: 'endpoint-1', outcome: 'failure', probeToken: 'token-1' },
      { endpointId: 'endpoint-2', outcome: 'success', probeToken: undefined },
    ]);
  });

  it('allows the call when the breaker cannot decide, and reports why', async () => {
    inner.failWith = new Error('redis down');

    expect(await breaker.allow('endpoint-1')).toEqual({ kind: 'allow' });
    expect(reported).toEqual([
      {
        error: inner.failWith,
        context: { operation: 'allow', endpointId: 'endpoint-1' },
      },
    ]);
  });

  it('carries on when a result cannot be recorded, and reports why', async () => {
    inner.failWith = new Error('redis down');

    await expect(
      breaker.record('endpoint-1', 'failure', 'token-1'),
    ).resolves.toBeUndefined();
    expect(reported).toEqual([
      {
        error: inner.failWith,
        context: { operation: 'record', endpointId: 'endpoint-1' },
      },
    ]);
  });

  it('reports nothing while the breaker works', async () => {
    inner.decision = { kind: 'deny' };

    await breaker.allow('endpoint-1');
    await breaker.record('endpoint-1', 'success');

    expect(reported).toEqual([]);
  });
});
