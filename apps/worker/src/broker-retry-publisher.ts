import type { DeliveryJob, LaneRouter } from '@wdp/core';
import {
  type ConfirmPublisher,
  DELIVERY_EXHAUSTED,
  encodeMessage,
  FAILURE_KIND_HEADER,
  FAILURE_REASON_HEADER,
  type PublishProperties,
  type TopologyNames,
} from '@wdp/messaging';
import { RetryPublisher } from './retry-publisher.js';

const DELIVERY_REQUESTED_TYPE = 'delivery.requested';

/**
 * Puts a failed job where it goes next.
 *
 * - A retry goes to the tier queue of its delay. The queue is reached through
 *   the default exchange, which routes by queue name; when its TTL runs out the
 *   broker dead-letters the job into `retry.ready`.
 * - A parked first attempt goes to the delay queue of its endpoint's lane,
 *   which dead-letters it back onto that lane when its TTL runs out. A parked
 *   retry goes to the retry delay queue, which dead-letters it back into
 *   `retry.ready`.
 * - An exhausted job goes to the dead-letter exchange, marked with
 *   `DELIVERY_EXHAUSTED`, so it can be told apart from a dead-lettered event
 *   in the shared DLQ, and with the reason. The body is the job as it was, so
 *   it can be replayed.
 */
export class BrokerRetryPublisher extends RetryPublisher {
  constructor(
    private readonly publisher: ConfirmPublisher,
    private readonly names: TopologyNames,
    private readonly lanes: LaneRouter,
  ) {
    super();
  }

  retry(job: DeliveryJob, delayMs: number): Promise<void> {
    return this.publisher.publish(
      '',
      this.names.retryTierQueue(delayMs),
      encodeJob(job),
      propertiesOf(job),
    );
  }

  park(job: DeliveryJob, delayMs: number): Promise<void> {
    // A deferral never changes the attempt number, so it alone says which
    // traffic the job is. A retry goes back through `retry.ready`: on a fresh
    // lane it would take the slots kept for first attempts. A first attempt's
    // lane comes from the endpoint, as the dispatcher's does, so it goes back
    // to the lane it was dispatched to.
    const queue =
      (job.attemptNo ?? 1) > 1
        ? this.names.retryParkQueue(delayMs)
        : this.names.parkQueue(delayMs, this.lanes.lane(job.endpointId));
    return this.publisher.publish('', queue, encodeJob(job), propertiesOf(job));
  }

  deadLetter(job: DeliveryJob, reason: string): Promise<void> {
    // The dead-letter exchange is a fanout: the routing key is ignored.
    return this.publisher.publish(
      this.names.deadLetterExchange,
      '',
      encodeJob(job),
      {
        ...propertiesOf(job),
        headers: {
          [FAILURE_KIND_HEADER]: DELIVERY_EXHAUSTED,
          [FAILURE_REASON_HEADER]: reason,
        },
      },
    );
  }
}

/** Shaped like the DeliveryRequested contract, which the consumer decodes. */
function encodeJob(job: DeliveryJob): Buffer {
  return encodeMessage({
    deliveryId: job.deliveryId,
    eventId: job.eventId,
    tenantId: job.tenantId,
    endpointId: job.endpointId,
    eventType: job.eventType,
    payload: job.payload,
    attemptNo: job.attemptNo,
  });
}

function propertiesOf(job: DeliveryJob): PublishProperties {
  return {
    // The same id on every try, as on the first publish.
    messageId: job.deliveryId,
    correlationId: job.eventId,
    type: DELIVERY_REQUESTED_TYPE,
  };
}
