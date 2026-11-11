import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

const required = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  RABBITMQ_URL: 'amqp://localhost',
};

describe('worker env schema', () => {
  it('applies the defaults: the port Compose maps, the PRD prefetch, no allowed hosts', () => {
    expect(envSchema.parse(required)).toEqual({
      ...required,
      PORT: 3001,
      BROKER_NAMESPACE: 'wdp',
      LANE_COUNT: 4,
      WORKER_PREFETCH: 20,
      SSRF_ALLOW_HOSTS: [],
    });
  });

  it('reads numbers from their string form', () => {
    const env = envSchema.parse({
      ...required,
      PORT: '4100',
      LANE_COUNT: '16',
      WORKER_PREFETCH: '50',
    });

    expect(env.PORT).toBe(4100);
    expect(env.LANE_COUNT).toBe(16);
    expect(env.WORKER_PREFETCH).toBe(50);
  });

  it.each(['DATABASE_URL', 'RABBITMQ_URL'] as const)('requires %s', (name) => {
    const { [name]: _removed, ...rest } = required;

    expect(envSchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    { name: 'a port of 0', env: { PORT: '0' } },
    { name: 'a negative port', env: { PORT: '-1' } },
    { name: 'a fractional port', env: { PORT: '30.5' } },
    { name: 'a non-numeric port', env: { PORT: 'http' } },
    { name: 'a lane count of 0', env: { LANE_COUNT: '0' } },
    { name: 'a fractional lane count', env: { LANE_COUNT: '2.5' } },
    { name: 'a non-numeric lane count', env: { LANE_COUNT: 'many' } },
    { name: 'a prefetch of 0', env: { WORKER_PREFETCH: '0' } },
    { name: 'a negative prefetch', env: { WORKER_PREFETCH: '-3' } },
    { name: 'a fractional prefetch', env: { WORKER_PREFETCH: '1.5' } },
  ])('rejects $name', ({ env }) => {
    expect(envSchema.safeParse({ ...required, ...env }).success).toBe(false);
  });

  it('rejects an empty broker namespace, which would prefix every queue with nothing', () => {
    expect(
      envSchema.safeParse({ ...required, BROKER_NAMESPACE: '' }).success,
    ).toBe(false);
  });

  describe('SSRF_ALLOW_HOSTS', () => {
    const parse = (value: string) =>
      envSchema.parse({ ...required, SSRF_ALLOW_HOSTS: value })
        .SSRF_ALLOW_HOSTS;

    it('splits on commas, trims and lowercases, to match how the guard compares names', () => {
      expect(parse(' Mock-Receiver , 127.0.0.1 ')).toEqual([
        'mock-receiver',
        '127.0.0.1',
      ]);
    });

    it('drops empty entries', () => {
      expect(parse('a,,b,')).toEqual(['a', 'b']);
    });

    it('reads an empty string as no allowed hosts', () => {
      expect(parse('')).toEqual([]);
    });
  });
});
