import { registerAs } from '@nestjs/config';
import { loadEnv } from './env.schema.js';

export const workerConfig = registerAs('worker', () => {
  const env = loadEnv();
  return { port: env.PORT };
});
