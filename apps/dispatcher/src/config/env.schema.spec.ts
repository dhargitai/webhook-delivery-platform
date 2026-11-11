import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

const required = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  RABBITMQ_URL: 'amqp://localhost',
};

describe('dispatcher env schema', () => {
  it('applies the PRD defaults', () => {
    expect(envSchema.parse(required)).toEqual({
      ...required,
      BROKER_NAMESPACE: 'wdp',
      LANE_COUNT: 4,
      DISPATCHER_PREFETCH: 20,
      DISPATCHER_CONFIRM_TIMEOUT_MS: 5000,
    });
  });

  it('reads numbers from their string form', () => {
    const env = envSchema.parse({
      ...required,
      LANE_COUNT: '16',
      DISPATCHER_PREFETCH: '50',
    });

    expect(env.LANE_COUNT).toBe(16);
    expect(env.DISPATCHER_PREFETCH).toBe(50);
  });

  it.each(['DATABASE_URL', 'RABBITMQ_URL'] as const)('requires %s', (name) => {
    const { [name]: _removed, ...rest } = required;

    expect(envSchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    { name: 'a lane count of 0', env: { LANE_COUNT: '0' } },
    { name: 'a fractional lane count', env: { LANE_COUNT: '2.5' } },
    { name: 'a prefetch of 0', env: { DISPATCHER_PREFETCH: '0' } },
    {
      name: 'a confirm timeout of 0',
      env: { DISPATCHER_CONFIRM_TIMEOUT_MS: '0' },
    },
    { name: 'a non-numeric lane count', env: { LANE_COUNT: 'many' } },
  ])('rejects $name', ({ env }) => {
    expect(envSchema.safeParse({ ...required, ...env }).success).toBe(false);
  });
});
