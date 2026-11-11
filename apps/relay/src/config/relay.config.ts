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
  };
});
