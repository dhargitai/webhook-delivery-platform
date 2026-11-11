import { describe, expect, it } from 'vitest';
import {
  createEndpointSchema,
  replaceSubscriptionsSchema,
} from './endpoint.schemas.js';

describe('createEndpointSchema', () => {
  it('normalises the URL and defaults the description to null', () => {
    const result = createEndpointSchema().parse({
      url: 'https://HOOKS.acme.test:443/in',
    });

    expect(result).toEqual({
      url: 'https://hooks.acme.test/in',
      description: null,
    });
  });

  it('keeps a given description', () => {
    expect(
      createEndpointSchema().parse({
        url: 'https://hooks.acme.test/in',
        description: 'billing',
      }).description,
    ).toBe('billing');
  });

  it('explains why a URL was rejected, on the url field', () => {
    const result = createEndpointSchema().safeParse({
      url: 'http://hooks.acme.test/in',
    });

    expect(result.success).toBe(false);
    const issue = result.error?.issues[0];
    expect(issue?.path).toEqual(['url']);
    expect(issue?.message).toMatch(/https/i);
  });

  it.each([
    { name: 'a missing url', body: {} },
    { name: 'a non-string url', body: { url: 5 } },
    {
      name: 'a url longer than 2048 characters',
      body: { url: `https://hooks.acme.test/${'a'.repeat(2048)}` },
    },
    {
      name: 'a description longer than 500 characters',
      body: { url: 'https://hooks.acme.test/in', description: 'd'.repeat(501) },
    },
    {
      name: 'an unknown field',
      body: { url: 'https://hooks.acme.test/in', status: 'disabled' },
    },
  ])('rejects $name', ({ body }) => {
    expect(createEndpointSchema().safeParse(body).success).toBe(false);
  });
});

describe('createEndpointSchema with allowed hosts', () => {
  const schema = createEndpointSchema(['mock-receiver']);

  it('accepts an http URL on an allowed host', () => {
    expect(schema.parse({ url: 'http://mock-receiver:4000/hook' }).url).toBe(
      'http://mock-receiver:4000/hook',
    );
  });

  it('still rejects a host that is not allowed, with the https reason', () => {
    const result = schema.safeParse({ url: 'http://other:4000/hook' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/https/i);
  });
});

describe('replaceSubscriptionsSchema', () => {
  it.each([
    { name: 'an empty list', body: { event_types: [] } },
    { name: 'several types', body: { event_types: ['a', 'b'] } },
    {
      name: 'exactly 50 types',
      body: { event_types: Array.from({ length: 50 }, (_, i) => `t${i}`) },
    },
  ])('accepts $name', ({ body }) => {
    expect(replaceSubscriptionsSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    { name: 'a missing list', body: {} },
    { name: 'a non-array list', body: { event_types: 'a' } },
    { name: 'an empty type', body: { event_types: [''] } },
    {
      name: 'a type longer than 255 characters',
      body: { event_types: ['x'.repeat(256)] },
    },
    {
      name: 'more than 50 types',
      body: { event_types: Array.from({ length: 51 }, (_, i) => `t${i}`) },
    },
    { name: 'an unknown field', body: { event_types: [], extra: 1 } },
  ])('rejects $name', ({ body }) => {
    expect(replaceSubscriptionsSchema.safeParse(body).success).toBe(false);
  });
});
