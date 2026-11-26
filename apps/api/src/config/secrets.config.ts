import { registerAs } from '@nestjs/config';
import { loadEnv } from './env.schema.js';

export const secretsConfig = registerAs('secrets', () => ({
  /** The current key-encryption key, decoded. */
  kek: loadEnv().SECRETS_KEK_V1,
}));
