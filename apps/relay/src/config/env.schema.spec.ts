import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

const required = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  RABBITMQ_URL: 'amqp://localhost',
};

describe('relay env schema', () => {
  it('applies the PRD defaults', () => {
    expect(envSchema.parse(required)).toEqual({
      ...required,
      BROKER_NAMESPACE: 'wdp',
      RELAY_BATCH_SIZE: 200,
      RELAY_POLL_INTERVAL_MS: 100,
      RELAY_CONFIRM_TIMEOUT_MS: 5000,
      RELAY_ERROR_BACKOFF_MS: 1000,
    });
  });

  it('reads numbers from their string form', () => {
    const env = envSchema.parse({
      ...required,
      RELAY_BATCH_SIZE: '50',
      RELAY_POLL_INTERVAL_MS: '20',
    });

    expect(env.RELAY_BATCH_SIZE).toBe(50);
    expect(env.RELAY_POLL_INTERVAL_MS).toBe(20);
  });

  it.each(['DATABASE_URL', 'RABBITMQ_URL'] as const)('requires %s', (name) => {
    const { [name]: _removed, ...rest } = required;

    expect(envSchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    { name: 'a batch size of 0', env: { RELAY_BATCH_SIZE: '0' } },
    { name: 'a fractional batch size', env: { RELAY_BATCH_SIZE: '1.5' } },
    { name: 'a negative poll interval', env: { RELAY_POLL_INTERVAL_MS: '-1' } },
    { name: 'a confirm timeout of 0', env: { RELAY_CONFIRM_TIMEOUT_MS: '0' } },
    { name: 'a non-numeric batch size', env: { RELAY_BATCH_SIZE: 'lots' } },
  ])('rejects $name', ({ env }) => {
    expect(envSchema.safeParse({ ...required, ...env }).success).toBe(false);
  });
});
