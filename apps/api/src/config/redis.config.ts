import { registerAs } from '@nestjs/config';
import { loadEnv } from './env.schema.js';

export const redisConfig = registerAs('redis', () => ({
  url: loadEnv().REDIS_URL,
}));
