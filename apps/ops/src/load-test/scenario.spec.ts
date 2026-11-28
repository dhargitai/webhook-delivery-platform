import { describe, expect, it } from 'vitest';
import {
  eventTypeFor,
  planScenario,
  type ScenarioOptions,
} from './scenario.js';

const defaults: ScenarioOptions = {
  label: 'run1',
  tenants: 6,
  ratePerTenant: 90,
  fanout: 1,
  noisyRate: 400,
  receiverBaseUrl: 'http://mock-receiver:4000',
};

describe('planScenario', () => {
  it('spreads a victim tenant over enough endpoints to stay under the token bucket', () => {
    const { victims } = planScenario(defaults);

    expect(victims).toHaveLength(6);
    const [first] = victims;
    expect(first?.eventTypes).toEqual([
      'load.t0',
      'load.t1',
      'load.t2',
      'load.t3',
      'load.t4',
      'load.t5',
    ]);
    expect(first?.endpoints).toHaveLength(6);
    for (const endpoint of first?.endpoints ?? []) {
      expect(endpoint.eventTypes).toHaveLength(1);
      expect(endpoint.offeredRate).toBe(15);
      expect(endpoint.url).toBe('http://mock-receiver:4000/hook?latency=20');
    }
  });

  it('subscribes every type to `fanout` endpoints of its own', () => {
    const { victims } = planScenario({ ...defaults, fanout: 3 });
    const endpoints = victims[0]?.endpoints ?? [];

    expect(endpoints).toHaveLength(18);
    const perType = new Map<string, number>();
    for (const { eventTypes } of endpoints) {
      for (const type of eventTypes) {
        perType.set(type, (perType.get(type) ?? 0) + 1);
      }
    }
    expect([...perType.values()]).toEqual([3, 3, 3, 3, 3, 3]);
    expect(endpoints.every((e) => e.offeredRate === 15)).toBe(true);
  });

  it('rounds the type count up, so an uneven rate stays under the bucket', () => {
    const { victims } = planScenario({ ...defaults, ratePerTenant: 31 });

    // 3 types at 10.33/s each, not 2 at 15.5/s.
    expect(victims[0]?.eventTypes).toHaveLength(3);
    expect(victims[0]?.endpoints[0]?.offeredRate).toBeCloseTo(31 / 3);
  });

  it('gives the noisy tenant one hanging endpoint for its one type', () => {
    const { noisy } = planScenario(defaults);

    expect(noisy).toMatchObject({
      name: 'load-run1-noisy',
      ratePerSecond: 400,
      eventTypes: ['noisy.flood'],
      endpoints: [
        {
          url: 'http://mock-receiver:4000/hook?hang=1',
          eventTypes: ['noisy.flood'],
        },
      ],
    });
  });

  it('names the tenants after the label, so every run gets new ones', () => {
    const names = (label: string) => {
      const { victims, noisy } = planScenario({ ...defaults, label });
      return [...victims.map((v) => v.name), noisy.name];
    };

    expect(names('a')).toEqual([
      'load-a-v1',
      'load-a-v2',
      'load-a-v3',
      'load-a-v4',
      'load-a-v5',
      'load-a-v6',
      'load-a-noisy',
    ]);
    expect(new Set([...names('a'), ...names('b')]).size).toBe(14);
  });

  it('accepts a trailing slash on the receiver URL', () => {
    const { noisy } = planScenario({
      ...defaults,
      receiverBaseUrl: 'http://mock-receiver:4000/',
    });

    expect(noisy.endpoints[0]?.url).toBe(
      'http://mock-receiver:4000/hook?hang=1',
    );
  });

  it('allows a run without the noisy tenant flooding', () => {
    expect(
      planScenario({ ...defaults, noisyRate: 0 }).noisy.ratePerSecond,
    ).toBe(0);
  });

  it.each([
    { name: 'no tenants', options: { tenants: 0 } },
    { name: 'a fractional rate', options: { ratePerTenant: 9.5 } },
    { name: 'a zero fan-out', options: { fanout: 0 } },
    { name: 'a negative noisy rate', options: { noisyRate: -1 } },
    { name: 'an empty label', options: { label: '' } },
    { name: 'a label with spaces', options: { label: 'my run' } },
  ])('rejects $name', ({ options }) => {
    expect(() => planScenario({ ...defaults, ...options })).toThrow();
  });
});

describe('eventTypeFor', () => {
  it('cycles through the tenant types, hitting each one equally', () => {
    const [tenant] = planScenario(defaults).victims;
    if (tenant === undefined) throw new Error('no tenant');

    const counts = new Map<string, number>();
    for (let i = 0; i < 60; i++) {
      const type = eventTypeFor(tenant, i);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }

    expect(counts.size).toBe(6);
    expect([...counts.values()]).toEqual([10, 10, 10, 10, 10, 10]);
  });
});
