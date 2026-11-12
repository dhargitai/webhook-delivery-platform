import { randomUUID } from 'node:crypto';
import { laneRoutingKey } from '@wdp/domain';
import { describe, expect, it } from 'vitest';
import { LaneRouter } from './lane-router.js';

describe('LaneRouter', () => {
  it('always routes the same endpoint to the same lane', () => {
    const router = new LaneRouter(4);

    expect(router.routingKey('ep-1')).toBe(router.routingKey('ep-1'));
  });

  it('routes every endpoint to a fresh.shard.NN key within the lane count', () => {
    const router = new LaneRouter(4);

    for (let i = 0; i < 200; i++) {
      const match = /^fresh\.shard\.(\d{2})$/.exec(
        router.routingKey(randomUUID()),
      );
      expect(match).not.toBeNull();
      expect(Number(match?.[1])).toBeLessThan(4);
    }
  });

  it('spreads endpoints over all lanes without one dominating', () => {
    const router = new LaneRouter(4);
    const counts = new Map<string, number>();

    for (let i = 0; i < 1000; i++) {
      const key = router.routingKey(randomUUID());
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    expect(counts.size).toBe(4);
    for (const count of counts.values()) {
      expect(count).toBeLessThan(400);
    }
  });

  it('uses the only lane when there is a single lane', () => {
    const router = new LaneRouter(1);

    expect(router.routingKey('ep-1')).toBe('fresh.shard.00');
    expect(router.routingKey('ep-2')).toBe('fresh.shard.00');
  });

  it('zero-pads lane numbers to two digits for 16 lanes', () => {
    const router = new LaneRouter(16);
    const keys = new Set<string>();

    for (let i = 0; i < 500; i++) {
      keys.add(router.routingKey(randomUUID()));
    }

    expect(keys.size).toBe(16);
    for (const key of keys) {
      expect(key).toMatch(/^fresh\.shard\.\d{2}$/);
    }
  });

  it('gives the lane number its routing key names, for every endpoint', () => {
    const router = new LaneRouter(16);
    const lanes = new Set<number>();

    for (let i = 0; i < 500; i++) {
      const endpointId = randomUUID();
      const lane = router.lane(endpointId);
      lanes.add(lane);
      expect(router.routingKey(endpointId)).toBe(laneRoutingKey(lane));
    }

    expect(lanes.size).toBe(16);
    for (const lane of lanes) {
      expect(Number.isInteger(lane) && lane >= 0 && lane < 16).toBe(true);
    }
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects an invalid lane count (%s)',
    (laneCount) => {
      expect(() => new LaneRouter(laneCount)).toThrow();
    },
  );
});
