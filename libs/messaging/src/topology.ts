import { laneRoutingKey } from '@wdp/domain';
import type { Channel } from 'amqplib';
import {
  EVENT_PUBLISHED_ROUTING_KEY,
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
