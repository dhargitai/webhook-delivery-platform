import { registerAs } from '@nestjs/config';
import { loadEnv } from './env.schema.js';

export const ingestConfig = registerAs('ingest', () => {
  const env = loadEnv();
  return {
    ratePerSecond: env.INGEST_RATE_PER_SECOND,
    burst: env.INGEST_BURST,
  };
});
