import { registerAs } from '@nestjs/config';
import { loadEnv } from './env.schema.js';

export const workerConfig = registerAs('worker', () => {
  const env = loadEnv();
  return {
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    rabbitmqUrl: env.RABBITMQ_URL,
    mongoUrl: env.MONGO_URL,
    mongoDb: env.MONGO_DB,
    brokerNamespace: env.BROKER_NAMESPACE,
    laneCount: env.LANE_COUNT,
    prefetch: env.WORKER_PREFETCH,
    ssrfAllowHosts: env.SSRF_ALLOW_HOSTS,
  };
});
