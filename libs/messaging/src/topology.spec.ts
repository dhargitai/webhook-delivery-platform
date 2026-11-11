import { laneRoutingKey } from '@wdp/domain';
import { describe, expect, it } from 'vitest';
import { RETRY_READY_ROUTING_KEY, topologyNames } from './names.js';
import { DELIVERY_LIMIT, quorumQueueArguments } from './topology.js';

describe('topologyNames', () => {
  it('uses the wdp namespace by default', () => {
    const names = topologyNames();

    expect(names).toMatchObject({
      eventsExchange: 'wdp.events',
      dispatchQueue: 'wdp.dispatch',
      deliveriesExchange: 'wdp.deliveries',
      deadLetterExchange: 'wdp.dlx',
      deadLetterQueue: 'wdp.dlq',
    });
  });

  it('prefixes every name with a given namespace', () => {
    const names = topologyNames('t1');

    expect(names.eventsExchange).toBe('t1.events');
    expect(names.dispatchQueue).toBe('t1.dispatch');
    expect(names.deliveriesExchange).toBe('t1.deliveries');
    expect(names.deadLetterQueue).toBe('t1.dlq');
    expect(names.laneQueue(0)).toBe('t1.fresh.shard.00');
  });

  it.each([
    { index: 0, name: 'wdp.fresh.shard.00' },
    { index: 7, name: 'wdp.fresh.shard.07' },
    { index: 15, name: 'wdp.fresh.shard.15' },
  ])('names lane $index as $name', ({ index, name }) => {
    expect(topologyNames().laneQueue(index)).toBe(name);
  });
});

describe('topologyNames, retry and delay queues', () => {
  it('names the retry and delay queues under the wdp namespace by default', () => {
    const names = topologyNames();

    expect(names.retryReadyQueue).toBe('wdp.retry.ready');
    expect(names.retryTierQueue(5000)).toBe('wdp.retry.5000');
    expect(names.parkQueue(5000, 0)).toBe('wdp.delay.5000.fresh.shard.00');
  });

  it('prefixes them with a given namespace', () => {
    const names = topologyNames('t1');

    expect(names.retryReadyQueue).toBe('t1.retry.ready');
    expect(names.retryTierQueue(300)).toBe('t1.retry.300');
    expect(names.parkQueue(300, 12)).toBe('t1.delay.300.fresh.shard.12');
  });

  it('puts the delay in the name, so a new time scale makes new queues instead of clashing', () => {
    const names = topologyNames();

    expect(names.retryTierQueue(500)).not.toBe(names.retryTierQueue(1000));
    expect(names.parkQueue(500, 1)).not.toBe(names.parkQueue(1000, 1));
  });

  it('gives each lane its own delay queue, named after the lane it returns to', () => {
    const names = topologyNames();

    expect(names.parkQueue(500, 0)).not.toBe(names.parkQueue(500, 1));
    expect(names.parkQueue(500, 3)).toBe(`wdp.delay.500.${laneRoutingKey(3)}`);
  });

  it('keeps retry.ready apart from every tier queue', () => {
    const names = topologyNames();

    // A tier queue is retry.<digits>, so it can never be retry.ready.
    expect(names.retryTierQueue(1)).not.toBe(names.retryReadyQueue);
    expect(names.retryTierQueue(1)).toMatch(/^wdp\.retry\.\d+$/);
  });

  it('routes retry.ready by a fixed key', () => {
    expect(RETRY_READY_ROUTING_KEY).toBe('retry.ready');
  });
});

describe('quorumQueueArguments', () => {
  it('makes a quorum queue that dead-letters to the given exchange', () => {
    expect(quorumQueueArguments('wdp.dlx')).toEqual({
      'x-queue-type': 'quorum',
      'x-delivery-limit': DELIVERY_LIMIT,
      'x-dead-letter-exchange': 'wdp.dlx',
    });
  });

  it('limits redeliveries to 5, as the PRD locks', () => {
    expect(DELIVERY_LIMIT).toBe(5);
  });
});
