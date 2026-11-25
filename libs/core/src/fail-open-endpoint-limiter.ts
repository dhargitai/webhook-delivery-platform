import { randomUUID } from 'node:crypto';
import type {
  AcquireResult,
  EndpointRate,
  EndpointSlots,
  Permit,
} from './endpoint-limiter.js';

/** Where a limiter error is reported, with what it was doing and for whom. */
export type LimiterErrorReporter = (
  error: unknown,
  context: { operation: 'acquire' | 'release'; endpointId: string },
) => void;

/**
 * An endpoint limiter that never stands in the way of a delivery because of
 * its own failure, a Redis outage typically.
 *
 * The limits only protect capacity and receivers; delivery is what must not
 * fail. So a limiter that cannot decide lets the call start, as if a slot
 * were free, and a permit that cannot be released is left to its lease: the
 * call it covered is already over. Each error is reported instead.
 */
export class FailOpenEndpointLimiter implements EndpointSlots {
  constructor(
    private readonly inner: EndpointSlots,
    private readonly onError: LimiterErrorReporter,
  ) {}

  async acquire(
    endpointId: string,
    rate?: Partial<EndpointRate>,
  ): Promise<AcquireResult> {
    try {
      return await this.inner.acquire(endpointId, rate);
    } catch (error) {
      this.onError(error, { operation: 'acquire', endpointId });
      // A token no slot was ever taken with: its release removes nothing,
      // and being unique, it can never free another worker's slot.
      return { kind: 'permit', permit: { endpointId, token: randomUUID() } };
    }
  }

  async release(permit: Permit): Promise<void> {
    try {
      await this.inner.release(permit);
    } catch (error) {
      this.onError(error, {
        operation: 'release',
        endpointId: permit.endpointId,
      });
    }
  }
}
