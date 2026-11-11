import { laneRoutingKey } from '@wdp/domain';

/** Routing key of an accepted event on the events exchange. */
export const EVENT_PUBLISHED_ROUTING_KEY = 'event.published';

export interface TopologyNames {
  eventsExchange: string;
  dispatchQueue: string;
  deliveriesExchange: string;
  /** Receives everything the queues reject or give up on. */
  deadLetterExchange: string;
  deadLetterQueue: string;
  /** The queue behind fresh-delivery lane `index`. */
  laneQueue(index: number): string;
}

/**
 * Every exchange and queue name, derived from one namespace. Services use the
 * default; tests pass their own so specs sharing a broker never collide.
 */
export function topologyNames(namespace = 'wdp'): TopologyNames {
  return {
    eventsExchange: `${namespace}.events`,
    dispatchQueue: `${namespace}.dispatch`,
    deliveriesExchange: `${namespace}.deliveries`,
    deadLetterExchange: `${namespace}.dlx`,
    deadLetterQueue: `${namespace}.dlq`,
    laneQueue: (index) => `${namespace}.${laneRoutingKey(index)}`,
  };
}
