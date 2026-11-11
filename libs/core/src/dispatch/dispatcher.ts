import { deliveryId } from '@wdp/domain';
import type { LaneRouter } from '../lane-router.js';
import type { DeliveryPublisher } from './delivery-publisher.js';
import type { SubscriptionLookup } from './subscription-lookup.js';

/** An accepted event, as the relay published it. */
export interface DispatchableEvent {
  eventId: string;
  tenantId: string;
  eventType: string;
  payload: unknown;
}

export interface DispatchFailure {
  endpointId: string;
  error: unknown;
}

/**
 * Some jobs of an event could not be published. The others went out, so the
 * event is handled again as a whole: the jobs that already exist come out
 * with the same ids.
 */
export class PartialDispatchError extends Error {
  constructor(
    /** How many jobs of the event did go out. */
    readonly dispatched: number,
    readonly failures: DispatchFailure[],
  ) {
    super(
      `${failures.length} of ${dispatched + failures.length} delivery jobs could not be published`,
      { cause: failures[0]?.error },
    );
    this.name = new.target.name;
  }
}

/**
 * Fans an event out into one delivery job per subscribed endpoint, each on the
 * lane of its endpoint.
 *
 * Subscribers are looked up when the event is dispatched, not when it was
 * accepted, so an endpoint registered in between receives it.
 *
 * Idempotent in effect: a job's id is a function of the event and endpoint, so
 * handling an event twice (a relay duplicate, or a crash before the ack)
 * produces the same ids and the workers can drop the repeats. The dispatcher
 * itself keeps no state.
 */
export class Dispatcher {
  constructor(
    private readonly subscriptions: SubscriptionLookup,
    private readonly publisher: DeliveryPublisher,
    private readonly router: LaneRouter,
  ) {}

  /** Publishes every job of the event and returns how many there were. */
  async handle(event: DispatchableEvent): Promise<number> {
    const endpointIds = await this.subscriptions.findActiveEndpointIds(
      event.tenantId,
      event.eventType,
    );

    // Publishing starts in registration order. Every job is attempted even if
    // one fails, so a single bad publish does not hold the others back.
    const outcomes = await Promise.all(
      endpointIds.map(async (endpointId) => {
        try {
          await this.publisher.publish(
            {
              deliveryId: deliveryId(event.eventId, endpointId),
              eventId: event.eventId,
              tenantId: event.tenantId,
              endpointId,
              eventType: event.eventType,
              payload: event.payload,
            },
            this.router.routingKey(endpointId),
          );
          return undefined;
        } catch (error) {
          return { endpointId, error };
        }
      }),
    );

    const failures = outcomes.filter(
      (outcome): outcome is DispatchFailure => outcome !== undefined,
    );
    if (failures.length > 0) {
      throw new PartialDispatchError(
        endpointIds.length - failures.length,
        failures,
      );
    }
    return endpointIds.length;
  }
}
