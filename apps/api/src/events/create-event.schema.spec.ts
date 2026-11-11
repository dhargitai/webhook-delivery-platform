import { describe, expect, it } from 'vitest';
import {
  createEventSchema,
  idempotencyKeySchema,
} from './create-event.schema.js';

describe('createEventSchema', () => {
  it.each([
    {
      name: 'an object payload',
      body: { type: 'invoice.paid', payload: { a: 1 } },
    },
    {
      name: 'an array payload',
      body: { type: 't', payload: [1, 'two', null] },
    },
    { name: 'a string payload', body: { type: 't', payload: 'text' } },
    { name: 'a null payload', body: { type: 't', payload: null } },
    {
      name: 'a 255-character type',
      body: { type: 'x'.repeat(255), payload: {} },
    },
  ])('accepts $name', ({ body }) => {
    expect(createEventSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    { name: 'a missing type', body: { payload: {} } },
    { name: 'an empty type', body: { type: '', payload: {} } },
    {
      name: 'a 256-character type',
      body: { type: 'x'.repeat(256), payload: {} },
    },
    { name: 'a non-string type', body: { type: 42, payload: {} } },
    { name: 'a missing payload', body: { type: 't' } },
    {
      name: 'an unknown top-level field',
      body: { type: 't', payload: {}, extra: 1 },
    },
    { name: 'a non-object body', body: 'just a string' },
    { name: 'a null body', body: null },
  ])('rejects $name', ({ body }) => {
    expect(createEventSchema.safeParse(body).success).toBe(false);
  });
});

describe('idempotencyKeySchema', () => {
  it.each(['k', 'x'.repeat(255), 'a b/c:1'])('accepts %j', (key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(true);
  });

  it.each(['', 'x'.repeat(256)])('rejects a key of length %#', (key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});
