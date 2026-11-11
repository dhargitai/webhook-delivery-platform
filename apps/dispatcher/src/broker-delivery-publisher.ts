import { type DeliveryJob, DeliveryPublisher } from '@wdp/core';
import {
  type ConfirmPublisher,
  encodeMessage,
  type TopologyNames,
} from '@wdp/messaging';

const DELIVERY_REQUESTED_TYPE = 'delivery.requested';

/** Publishes a delivery job to its lane on the deliveries exchange. */
export class BrokerDeliveryPublisher extends DeliveryPublisher {
  constructor(
    private readonly publisher: ConfirmPublisher,
    private readonly names: TopologyNames,
  ) {
    super();
  }

  publish(job: DeliveryJob, routingKey: string): Promise<void> {
    // Shaped like the DeliveryRequested contract, which the specs decode it with.
    const body = encodeMessage({
      deliveryId: job.deliveryId,
      eventId: job.eventId,
      tenantId: job.tenantId,
      endpointId: job.endpointId,
      eventType: job.eventType,
      payload: job.payload,
    });
    return this.publisher.publish(
      this.names.deliveriesExchange,
      routingKey,
      body,
      {
        // Stable for the (event, endpoint) pair, so workers can drop repeats.
        messageId: job.deliveryId,
        // The event id follows the event through every service and log line.
        correlationId: job.eventId,
        type: DELIVERY_REQUESTED_TYPE,
      },
    );
  }
}
