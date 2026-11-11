import { describe, expect, it } from 'vitest';
import { laneRoutingKey } from './lane-routing-key.js';

describe('laneRoutingKey', () => {
  it.each([
    { lane: 0, key: 'fresh.shard.00' },
    { lane: 3, key: 'fresh.shard.03' },
    { lane: 10, key: 'fresh.shard.10' },
    { lane: 15, key: 'fresh.shard.15' },
  ])('names lane $lane $key', ({ lane, key }) => {
    expect(laneRoutingKey(lane)).toBe(key);
  });
});
