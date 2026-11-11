/** One event bound for one endpoint. */
export interface DeliveryJob {
  /** Stable for an (event, endpoint) pair, so a repeated dispatch is recognisable. */
  deliveryId: string;
  eventId: string;
  tenantId: string;
  endpointId: string;
  eventType: string;
  payload: unknown;
  /**
   * Which try of this delivery the job is, from 1. Absent means the first; a
   * retry sets it, so the attempt log can tell the tries apart.
   */
  attemptNo?: number;
}

/** Hands one delivery job to the broker. Resolves only once the broker has it. */
export abstract class DeliveryPublisher {
  abstract publish(job: DeliveryJob, routingKey: string): Promise<void>;
}
