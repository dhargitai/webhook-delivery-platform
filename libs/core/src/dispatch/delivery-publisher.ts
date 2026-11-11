/** One event bound for one endpoint. */
export interface DeliveryJob {
  /** Stable for an (event, endpoint) pair, so a repeated dispatch is recognisable. */
  deliveryId: string;
  eventId: string;
  tenantId: string;
  endpointId: string;
  eventType: string;
  payload: unknown;
}

/** Hands one delivery job to the broker. Resolves only once the broker has it. */
export abstract class DeliveryPublisher {
  abstract publish(job: DeliveryJob, routingKey: string): Promise<void>;
}
