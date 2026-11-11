import { laneRoutingKey } from '@wdp/domain';
import type { Channel } from 'amqplib';
import {
  EVENT_PUBLISHED_ROUTING_KEY,
  RETRY_READY_ROUTING_KEY,
  type TopologyNames,
  topologyNames,
} from './names.js';

/** PRD: a message redelivered more than this many times is dead-lettered. */
export const DELIVERY_LIMIT = 5;

/**
 * Arguments shared by every working queue.
 *
 * `x-delivery-limit` only counts redeliveries, such as a consumer dying
 * before it acks, so a message that keeps crashing consumers ends in the DLQ.
 * A consumer that rejects a message without requeueing sends it there at once.
 */
export function quorumQueueArguments(deadLetterExchange: string) {
  return {
    'x-queue-type': 'quorum',
    'x-delivery-limit': DELIVERY_LIMIT,
    'x-dead-letter-exchange': deadLetterExchange,
  };
}

export interface TopologyOptions {
  /** Number of fresh-delivery lanes (`LANE_COUNT`). */
  laneCount: number;
  namespace?: string;
}

/** Where a service that only needs the events side declares from. */
export interface EventTopologyOptions {
  namespace?: string;
}

/** Declares the dead-letter exchange and queue every working queue falls back to. */
async function declareDeadLetters(channel: Channel, names: TopologyNames) {
  // Dead letters from every queue land in one place for inspection and replay.
  await channel.assertExchange(names.deadLetterExchange, 'fanout', {
    durable: true,
  });
  await channel.assertQueue(names.deadLetterQueue, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(names.deadLetterQueue, names.deadLetterExchange, '');
}

/**
 * Declares the events side: the events exchange, the dispatch queue and the
 * dead-letter queue. Idempotent. The relay needs only this, so it does not
 * have to know the lane count.
 */
export async function declareEventTopology(
  channel: Channel,
  { namespace }: EventTopologyOptions = {},
): Promise<TopologyNames> {
  const names = topologyNames(namespace);
  await declareDeadLetters(channel, names);

  await channel.assertExchange(names.eventsExchange, 'direct', {
    durable: true,
  });
  await channel.assertQueue(names.dispatchQueue, {
    durable: true,
    arguments: quorumQueueArguments(names.deadLetterExchange),
  });
  await channel.bindQueue(
    names.dispatchQueue,
    names.eventsExchange,
    EVENT_PUBLISHED_ROUTING_KEY,
  );
  return names;
}

export interface DispatchRetryOptions {
  /** How long a failed event waits before it is dispatched again. */
  delayMs: number;
  namespace?: string;
}

/**
 * Declares the queue a failed dispatch waits in. After `delayMs` the broker
 * dead-letters the message through the events exchange back onto the dispatch
 * queue, so the pause costs no consumer slot and survives a restart. Declared
 * by the dispatcher only; the relay does not need it. Idempotent. Call
 * `declareEventTopology` first.
 */
export async function declareDispatchRetryTopology(
  channel: Channel,
  { delayMs, namespace }: DispatchRetryOptions,
): Promise<TopologyNames> {
  if (!Number.isInteger(delayMs) || delayMs < 1) {
    throw new RangeError(`delayMs must be a positive integer, got ${delayMs}`);
  }
  const names = topologyNames(namespace);
  await channel.assertQueue(names.dispatchRetryQueue(delayMs), {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-message-ttl': delayMs,
      'x-dead-letter-exchange': names.eventsExchange,
      'x-dead-letter-routing-key': EVENT_PUBLISHED_ROUTING_KEY,
    },
  });
  return names;
}

export interface RetryTopologyOptions {
  /** Number of fresh-delivery lanes (`LANE_COUNT`). */
  laneCount: number;
  /**
   * The effective delay of every retry tier queue, in ms, after scaling and
   * floor (`RetryPolicy.delays()`). Repeats are fine: a floor can give several
   * buckets one delay, and that queue is declared once.
   */
  retryDelaysMs: readonly number[];
  /** How long a parked job waits before its lane (`RetryPolicy.parkDelayMs`). */
  parkDelayMs: number;
  namespace?: string;
}

function assertDelay(name: string, delayMs: number): void {
  if (!Number.isInteger(delayMs) || delayMs < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${delayMs}`);
  }
}

/**
 * Declares where a delivery waits before another try, and where a parked job
 * waits before its lane. Idempotent. Declared by the worker only. Calls
 * `declareTopology` first, for the deliveries exchange and the lanes.
 *
 * - **Retry tiers:** one queue per delay. It has a fixed `x-message-ttl`, since
 *   RabbitMQ expires a message only at the head of its queue, so a per-message
 *   TTL would let a long wait hold up a short one. When the TTL runs out the
 *   broker dead-letters the message to `retry.ready`, the one queue workers
 *   consume retries from.
 * - **Delay queues:** one per lane, so each can dead-letter by a fixed routing
 *   key straight back to its own lane.
 *
 * The delay is part of every queue name, because RabbitMQ refuses to change the
 * TTL of an existing queue: a new time scale makes new queues, and messages
 * still waiting in the old ones run out as before. Neither kind of queue gets a
 * delivery limit: nothing consumes them, messages only leave by expiring.
 */
export async function declareRetryTopology(
  channel: Channel,
  { laneCount, retryDelaysMs, parkDelayMs, namespace }: RetryTopologyOptions,
): Promise<TopologyNames> {
  if (retryDelaysMs.length === 0) {
    throw new RangeError('retryDelaysMs must not be empty');
  }
  for (const delayMs of retryDelaysMs) {
    assertDelay('every retry delay', delayMs);
  }
  assertDelay('parkDelayMs', parkDelayMs);

  const names = await declareTopology(channel, { laneCount, namespace });

  await channel.assertQueue(names.retryReadyQueue, {
    durable: true,
    arguments: quorumQueueArguments(names.deadLetterExchange),
  });
  await channel.bindQueue(
    names.retryReadyQueue,
    names.deliveriesExchange,
    RETRY_READY_ROUTING_KEY,
  );

  for (const delayMs of new Set(retryDelaysMs)) {
    await channel.assertQueue(names.retryTierQueue(delayMs), {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-message-ttl': delayMs,
        'x-dead-letter-exchange': names.deliveriesExchange,
        'x-dead-letter-routing-key': RETRY_READY_ROUTING_KEY,
      },
    });
  }

  for (let lane = 0; lane < laneCount; lane++) {
    await channel.assertQueue(names.parkQueue(parkDelayMs, lane), {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-message-ttl': parkDelayMs,
        'x-dead-letter-exchange': names.deliveriesExchange,
        'x-dead-letter-routing-key': laneRoutingKey(lane),
      },
    });
  }
  return names;
}

/**
 * Declares everything: the events side plus the deliveries exchange and its
 * lane queues. Idempotent, so every service can call it at startup. RabbitMQ
 * refuses to redeclare a queue with different arguments, which turns a
 * drifting config into a loud failure.
 */
export async function declareTopology(
  channel: Channel,
  { laneCount, namespace }: TopologyOptions,
): Promise<TopologyNames> {
  if (!Number.isInteger(laneCount) || laneCount < 1) {
    throw new RangeError(
      `laneCount must be a positive integer, got ${laneCount}`,
    );
  }
  const names = await declareEventTopology(channel, { namespace });

  await channel.assertExchange(names.deliveriesExchange, 'direct', {
    durable: true,
  });
  for (let lane = 0; lane < laneCount; lane++) {
    const queue = names.laneQueue(lane);
    await channel.assertQueue(queue, {
      durable: true,
      arguments: quorumQueueArguments(names.deadLetterExchange),
    });
    await channel.bindQueue(
      queue,
      names.deliveriesExchange,
      laneRoutingKey(lane),
    );
  }
  return names;
}
