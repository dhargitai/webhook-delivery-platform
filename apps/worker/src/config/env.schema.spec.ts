import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

const required = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  RABBITMQ_URL: 'amqp://localhost',
  MONGO_URL: 'mongodb://localhost:27017',
  REDIS_URL: 'redis://localhost:6379',
};

describe('worker env schema', () => {
  it('applies the defaults: the port Compose maps, the PRD prefetches, real-time retries, no allowed hosts', () => {
    expect(envSchema.parse(required)).toEqual({
      ...required,
      PORT: 3001,
      MONGO_DB: 'wdp',
      BROKER_NAMESPACE: 'wdp',
      LANE_COUNT: 4,
      WORKER_PREFETCH: 20,
      WORKER_RETRY_PREFETCH: 5,
      TIME_SCALE: 1,
      RETRY_MIN_DELAY_MS: 0,
      SSRF_ALLOW_HOSTS: [],
    });
  });

  it('reads numbers from their string form', () => {
    const env = envSchema.parse({
      ...required,
      PORT: '4100',
      LANE_COUNT: '16',
      WORKER_PREFETCH: '50',
      WORKER_RETRY_PREFETCH: '8',
      TIME_SCALE: '30',
      RETRY_MIN_DELAY_MS: '500',
    });

    expect(env.PORT).toBe(4100);
    expect(env.LANE_COUNT).toBe(16);
    expect(env.WORKER_PREFETCH).toBe(50);
    expect(env.WORKER_RETRY_PREFETCH).toBe(8);
    expect(env.TIME_SCALE).toBe(30);
    expect(env.RETRY_MIN_DELAY_MS).toBe(500);
  });

  it('accepts a fractional time scale, which slows retries down', () => {
    expect(envSchema.parse({ ...required, TIME_SCALE: '0.5' }).TIME_SCALE).toBe(
      0.5,
    );
  });

  it.each(['DATABASE_URL', 'RABBITMQ_URL', 'MONGO_URL', 'REDIS_URL'] as const)(
    'requires %s',
    (name) => {
      const { [name]: _removed, ...rest } = required;

      expect(envSchema.safeParse(rest).success).toBe(false);
    },
  );

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
    { name: 'a retry prefetch of 0', env: { WORKER_RETRY_PREFETCH: '0' } },
    {
      name: 'a fractional retry prefetch',
      env: { WORKER_RETRY_PREFETCH: '2.5' },
    },
    { name: 'a time scale of 0', env: { TIME_SCALE: '0' } },
    { name: 'a negative time scale', env: { TIME_SCALE: '-30' } },
    { name: 'an infinite time scale', env: { TIME_SCALE: 'Infinity' } },
    { name: 'a non-numeric time scale', env: { TIME_SCALE: 'fast' } },
    { name: 'a negative retry floor', env: { RETRY_MIN_DELAY_MS: '-1' } },
    { name: 'a fractional retry floor', env: { RETRY_MIN_DELAY_MS: '0.5' } },
  ])('rejects $name', ({ env }) => {
    expect(envSchema.safeParse({ ...required, ...env }).success).toBe(false);
  });

  it('rejects an empty broker namespace, which would prefix every queue with nothing', () => {
    expect(
      envSchema.safeParse({ ...required, BROKER_NAMESPACE: '' }).success,
    ).toBe(false);
  });

  it('rejects an empty Mongo database name, which would log into no database', () => {
    expect(envSchema.safeParse({ ...required, MONGO_DB: '' }).success).toBe(
      false,
    );
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
