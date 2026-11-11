import { describe, expect, it } from 'vitest';
import { topologyNames } from './names.js';
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
