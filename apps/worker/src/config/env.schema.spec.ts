import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

describe('worker env schema', () => {
  it('defaults the port to 3001, the one Compose maps', () => {
    expect(envSchema.parse({})).toEqual({ PORT: 3001 });
  });

  it('reads the port from its string form', () => {
    expect(envSchema.parse({ PORT: '4100' }).PORT).toBe(4100);
  });

  it.each([
    { name: 'a port of 0', port: '0' },
    { name: 'a negative port', port: '-1' },
    { name: 'a fractional port', port: '30.5' },
    { name: 'a non-numeric port', port: 'http' },
  ])('rejects $name', ({ port }) => {
    expect(envSchema.safeParse({ PORT: port }).success).toBe(false);
  });
});
