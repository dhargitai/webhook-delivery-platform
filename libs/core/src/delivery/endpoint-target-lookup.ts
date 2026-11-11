/** What the worker needs to call an endpoint. */
export interface EndpointTarget {
  url: string;
  /** Plaintext until Task 22 encrypts it at rest. Never log it. */
  signingSecret: string;
  status: 'active' | 'disabled';
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
   */
  abstract find(
    tenantId: string,
    endpointId: string,
  ): Promise<EndpointTarget | null>;
}
