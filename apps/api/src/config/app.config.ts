import { registerAs } from '@nestjs/config';
import { loadEnv } from './env.schema.js';

export const appConfig = registerAs('app', () => ({
  port: loadEnv().PORT,
}));
