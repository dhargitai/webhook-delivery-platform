import { describe, expect, it } from 'vitest';
import { requestHash } from './request-hash.js';

describe('requestHash', () => {
  it('returns a 64-character lowercase hex SHA-256 digest', () => {
    expect(requestHash({ type: 'invoice.paid', payload: {} })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it.each([
    {
      name: 'top-level key order',
      a: { type: 'invoice.paid', payload: { invoice: 'INV-42' } },
      b: { payload: { invoice: 'INV-42' }, type: 'invoice.paid' },
    },
    {
      name: 'nested key order',
      a: { type: 't', payload: { a: 1, b: { c: 2, d: 3 } } },
      b: { type: 't', payload: { b: { d: 3, c: 2 }, a: 1 } },
    },
    {
      name: 'key order inside objects within arrays',
      a: { type: 't', payload: { items: [{ a: 1, b: 2 }] } },
      b: { type: 't', payload: { items: [{ b: 2, a: 1 }] } },
    },
  ])('is stable regardless of $name', ({ a, b }) => {
    expect(requestHash(a)).toBe(requestHash(b));
  });

  it.each([
    {
      name: 'a different payload value',
      a: { type: 'invoice.paid', payload: { invoice: 'INV-42' } },
      b: { type: 'invoice.paid', payload: { invoice: 'INV-43' } },
    },
    {
      name: 'a different event type',
      a: { type: 'invoice.paid', payload: { invoice: 'INV-42' } },
      b: { type: 'invoice.failed', payload: { invoice: 'INV-42' } },
    },
    {
      name: 'an extra payload field',
      a: { type: 't', payload: { a: 1 } },
      b: { type: 't', payload: { a: 1, b: 2 } },
    },
    {
      name: 'array element order',
      a: { type: 't', payload: { items: [1, 2] } },
      b: { type: 't', payload: { items: [2, 1] } },
    },
    {
      name: 'a number versus the same digits as a string',
      a: { type: 't', payload: { n: 1 } },
      b: { type: 't', payload: { n: '1' } },
    },
  ])('differs for $name', ({ a, b }) => {
    expect(requestHash(a)).not.toBe(requestHash(b));
  });
});
