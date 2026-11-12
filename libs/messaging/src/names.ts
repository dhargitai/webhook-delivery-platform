import { laneRoutingKey } from '@wdp/domain';

/** Routing key of an accepted event on the events exchange. */
export const EVENT_PUBLISHED_ROUTING_KEY = 'event.published';

/**
 * Routing key of `retry.ready` on the deliveries exchange: where a delivery
 * lands once its wait in a retry tier queue is over.
 */
export const RETRY_READY_ROUTING_KEY = 'retry.ready';

/** Header: which dispatch attempt a message is on. Absent on the first. */
export const DISPATCH_ATTEMPT_HEADER = 'x-dispatch-attempt';
/** Header on a dead-lettered message: what kind of failure put it there. */
export const FAILURE_KIND_HEADER = 'x-failure-kind';
/** Header on a dead-lettered message: why, in words. */
export const FAILURE_REASON_HEADER = 'x-failure-reason';
/** An event whose dispatch kept failing until its attempts ran out. */
export const DISPATCH_EXHAUSTED = 'dispatch-exhausted';
/** A delivery whose attempts all failed until its budget ran out. */
export const DELIVERY_EXHAUSTED = 'delivery-exhausted';

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
  /**
   * Where deliveries whose retry wait is over are consumed from, shared by
   * every lane.
   */
  retryReadyQueue: string;
  /**
   * Where a failed delivery waits `delayMs` before it moves to `retryReadyQueue`.
   * The delay is the effective one (after scaling and floor), and part of the
   * name because RabbitMQ refuses to change a queue's TTL after the fact.
   */
  retryTierQueue(delayMs: number): string;
  /**
   * Where a job parked without using up an attempt waits `delayMs` before it
   * returns to fresh lane `lane`. One per lane, so the broker can send it back
   * by a fixed routing key.
   */
  parkQueue(delayMs: number, lane: number): string;
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
    retryReadyQueue: `${namespace}.${RETRY_READY_ROUTING_KEY}`,
    retryTierQueue: (delayMs) => `${namespace}.retry.${delayMs}`,
    parkQueue: (delayMs, lane) =>
      `${namespace}.delay.${delayMs}.${laneRoutingKey(lane)}`,
  };
}
