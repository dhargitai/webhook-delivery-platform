import type {
  BreakerDecision,
  BreakerOutcome,
  EndpointCircuit,
} from './circuit-breaker.js';

/** Where a breaker error is reported, with what it was doing and for whom. */
export type CircuitErrorReporter = (
  error: unknown,
  context: { operation: 'allow' | 'record'; endpointId: string },
) => void;

/**
 * A circuit breaker that never stands in the way of a delivery because of
 * its own failure, a Redis outage typically.
 *
 * The breaker only protects capacity and receivers; delivery is what must not
 * fail. So a breaker that cannot decide allows the call, as a closed circuit
 * would, and a result that cannot be recorded is dropped: the call it
 * describes has already been made, and failing now would only turn a
 * delivered job into a lost or repeated one. Each error is reported instead.
 */
export class FailOpenCircuitBreaker implements EndpointCircuit {
  constructor(
    private readonly inner: EndpointCircuit,
    private readonly onError: CircuitErrorReporter,
  ) {}

  async allow(endpointId: string): Promise<BreakerDecision> {
    try {
      return await this.inner.allow(endpointId);
    } catch (error) {
      this.onError(error, { operation: 'allow', endpointId });
      // Never a probe: none was elected, so its result would be ignored.
      return { kind: 'allow' };
    }
  }

  async record(
    endpointId: string,
    outcome: BreakerOutcome,
    probeToken?: string,
  ): Promise<void> {
    try {
      await this.inner.record(endpointId, outcome, probeToken);
    } catch (error) {
      this.onError(error, { operation: 'record', endpointId });
    }
  }
}
