import { registerAs } from '@nestjs/config';
import { loadEnv } from './env.schema.js';

export const dispatcherConfig = registerAs('dispatcher', () => {
  const env = loadEnv();
  return {
    databaseUrl: env.DATABASE_URL,
    rabbitmqUrl: env.RABBITMQ_URL,
    brokerNamespace: env.BROKER_NAMESPACE,
    laneCount: env.LANE_COUNT,
    prefetch: env.DISPATCHER_PREFETCH,
    confirmTimeoutMs: env.DISPATCHER_CONFIRM_TIMEOUT_MS,
    retryDelayMs: env.DISPATCHER_RETRY_DELAY_MS,
    maxAttempts: env.DISPATCHER_MAX_ATTEMPTS,
  };
});
