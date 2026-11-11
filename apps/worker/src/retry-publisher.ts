import type { DeliveryJob } from '@wdp/core';

/**
 * Where a failed attempt goes next. Resolves only once the broker has the
 * copy, so the caller can ack the original afterwards.
 */
export abstract class RetryPublisher {
  /**
   * Parks `job` for `delayMs` before it is delivered again. The job already
   * carries the number of the attempt it will be.
   */
  abstract retry(job: DeliveryJob, delayMs: number): Promise<void>;
}
