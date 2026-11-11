import { registerAs } from '@nestjs/config';
import { loadEnv } from './env.schema.js';

export const ssrfConfig = registerAs('ssrf', () => ({
  allowHosts: loadEnv().SSRF_ALLOW_HOSTS,
}));
