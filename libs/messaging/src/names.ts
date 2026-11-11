import { laneRoutingKey } from '@wdp/domain';

/** Routing key of an accepted event on the events exchange. */
export const EVENT_PUBLISHED_ROUTING_KEY = 'event.published';

/** Header: which dispatch attempt a message is on. Absent on the first. */
export const DISPATCH_ATTEMPT_HEADER = 'x-dispatch-attempt';
/** Header on a dead-lettered message: what kind of failure put it there. */
export const FAILURE_KIND_HEADER = 'x-failure-kind';
/** Header on a dead-lettered message: why, in words. */
export const FAILURE_REASON_HEADER = 'x-failure-reason';
/** An event whose dispatch kept failing until its attempts ran out. */
export const DISPATCH_EXHAUSTED = 'dispatch-exhausted';

export interface TopologyNames {
  eventsExchange: string;
  dispatchQueue: string;
  deliveriesExchange: string;
  /** Receives everything the queues reject or give up on. */
  deadLetterExchange: string;
  deadLetterQueue: string;
  /**
   * Where a failed dispatch waits before another try. The delay is part of the
   * name because RabbitMQ refuses to change a queue's TTL after the fact.
   */
  dispatchRetryQueue(delayMs: number): string;
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
    dispatchRetryQueue: (delayMs) => `${namespace}.dispatch.retry.${delayMs}`,
    laneQueue: (index) => `${namespace}.${laneRoutingKey(index)}`,
  };
}
