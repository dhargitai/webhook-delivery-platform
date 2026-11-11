import { describe, expect, it } from 'vitest';
import { deliveryId } from './delivery-id.js';

describe('deliveryId', () => {
  it('is a 64-character lowercase hex digest', () => {
    expect(deliveryId('evt-1', 'ep-1')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same event and endpoint', () => {
    expect(deliveryId('evt-1', 'ep-1')).toBe(deliveryId('evt-1', 'ep-1'));
  });

  const differing: {
    name: string;
    a: [string, string];
    b: [string, string];
  }[] = [
    {
      name: 'a different event',
      a: ['evt-1', 'ep-1'],
      b: ['evt-2', 'ep-1'],
    },
    {
      name: 'a different endpoint',
      a: ['evt-1', 'ep-1'],
      b: ['evt-1', 'ep-2'],
    },
    {
      name: 'swapped arguments',
      a: ['evt-1', 'ep-1'],
      b: ['ep-1', 'evt-1'],
    },
    {
      name: 'ids that concatenate to the same string',
      a: ['ab', 'c'],
      b: ['a', 'bc'],
    },
  ];

  it.each(differing)('differs for $name', ({ a, b }) => {
    expect(deliveryId(...a)).not.toBe(deliveryId(...b));
  });
});
