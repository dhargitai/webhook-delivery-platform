import type { DeliveryJob } from '@wdp/core';
import {
  type ConfirmPublisher,
  encodeMessage,
  type TopologyNames,
} from '@wdp/messaging';
import { RetryPublisher } from './retry-publisher.js';

const DELIVERY_REQUESTED_TYPE = 'delivery.requested';

/**
 * Puts a job in the retry tier queue of its delay. The queue is reached through
 * the default exchange, which routes by queue name; when its TTL runs out the
 * broker dead-letters the job into `retry.ready`.
 */
export class BrokerRetryPublisher extends RetryPublisher {
  constructor(
    private readonly publisher: ConfirmPublisher,
    private readonly names: TopologyNames,
  ) {
    super();
  }

  retry(job: DeliveryJob, delayMs: number): Promise<void> {
    // Shaped like the DeliveryRequested contract, which the consumer decodes.
    const body = encodeMessage({
      deliveryId: job.deliveryId,
      eventId: job.eventId,
      tenantId: job.tenantId,
      endpointId: job.endpointId,
      eventType: job.eventType,
      payload: job.payload,
      attemptNo: job.attemptNo,
    });
    return this.publisher.publish(
      '',
      this.names.retryTierQueue(delayMs),
      body,
      {
        // The same id on every try, as on the first publish.
        messageId: job.deliveryId,
        correlationId: job.eventId,
        type: DELIVERY_REQUESTED_TYPE,
      },
    );
  }
}
