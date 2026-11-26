import { registerAs } from '@nestjs/config';
import { loadEnv } from './env.schema.js';

export const relayConfig = registerAs('relay', () => {
  const env = loadEnv();
  return {
    databaseUrl: env.DATABASE_URL,
    rabbitmqUrl: env.RABBITMQ_URL,
    brokerNamespace: env.BROKER_NAMESPACE,
    batchSize: env.RELAY_BATCH_SIZE,
    pollIntervalMs: env.RELAY_POLL_INTERVAL_MS,
    confirmTimeoutMs: env.RELAY_CONFIRM_TIMEOUT_MS,
    errorBackoffMs: env.RELAY_ERROR_BACKOFF_MS,
    purge: {
      retentionMs: env.EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      batchSize: env.PURGE_BATCH_SIZE,
      intervalMs: env.PURGE_INTERVAL_MS,
      errorBackoffMs: env.PURGE_ERROR_BACKOFF_MS,
    },
  };
});
