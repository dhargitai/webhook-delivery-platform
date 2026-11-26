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
      EVENTS_RETENTION_DAYS: 30,
      PURGE_BATCH_SIZE: 1000,
      PURGE_INTERVAL_MS: 86_400_000,
      PURGE_ERROR_BACKOFF_MS: 60_000,
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
    { name: 'a retention of 0 days', env: { EVENTS_RETENTION_DAYS: '0' } },
    {
      name: 'a fractional retention',
      env: { EVENTS_RETENTION_DAYS: '1.5' },
    },
    { name: 'a purge batch size of 0', env: { PURGE_BATCH_SIZE: '0' } },
    { name: 'a purge interval of 0', env: { PURGE_INTERVAL_MS: '0' } },
    {
      name: 'a negative purge error backoff',
      env: { PURGE_ERROR_BACKOFF_MS: '-1' },
    },
  ])('rejects $name', ({ env }) => {
    expect(envSchema.safeParse({ ...required, ...env }).success).toBe(false);
  });
});
