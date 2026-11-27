import type { EndpointRate } from '../endpoint-limiter.js';

/** What the worker needs to call an endpoint. */
export interface EndpointTarget {
  url: string;
  /**
   * Every secret to sign with: the current one first, then the previous one
   * while its rotation overlap lasts. Opened from their sealed form, in memory
   * only. Never log them.
   */
  signingSecrets: readonly string[];
  status: 'active' | 'disabled';
  /**
   * The endpoint's own rate, for the limiter to merge over its defaults. A
   * part with no override is absent, never `undefined`: the limiter rejects
   * a present `undefined`. Empty when nothing is overridden.
   */
  rate: Partial<EndpointRate>;
}

/**
 * The delivery worker's read path to an endpoint. It is separate from the
 * API's endpoint repository on purpose: that contract never reads the secret.
 */
export abstract class EndpointTargetLookup {
  /**
   * The target of one endpoint, or `null` when it does not exist, was deleted
   * since the job was queued, or belongs to another tenant. A disabled
   * endpoint is returned as such, so the caller decides what to do with it.
   * Rejects when its secret cannot be opened (not sealed yet, a wrong KEK,
   * tampering).
   */
  abstract find(
    tenantId: string,
    endpointId: string,
  ): Promise<EndpointTarget | null>;
}
