import { EventPublisher, type OutboxEvent } from '@wdp/core';
import {
  type ConfirmPublisher,
  encodeMessage,
  EVENT_PUBLISHED_ROUTING_KEY,
  type TopologyNames,
} from '@wdp/messaging';

/** Publishes an outbox event to the events exchange as an `EventPublished` message. */
export class BrokerEventPublisher extends EventPublisher {
  constructor(
    private readonly publisher: ConfirmPublisher,
    private readonly names: TopologyNames,
  ) {
    super();
  }

  publish(event: OutboxEvent): Promise<void> {
    // Shaped like the EventPublished contract, which the specs decode it with.
    const body = encodeMessage({
      eventId: event.eventId,
      tenantId: event.tenantId,
      eventType: event.eventType,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    });
    return this.publisher.publish(
      this.names.eventsExchange,
      EVENT_PUBLISHED_ROUTING_KEY,
      body,
      {
        // The same id on every attempt, so consumers can drop duplicates.
        messageId: event.eventId,
        // The event id follows the event through every service and log line.
        correlationId: event.eventId,
        type: EVENT_PUBLISHED_ROUTING_KEY,
      },
    );
  }
}
