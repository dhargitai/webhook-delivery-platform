import { randomBytes } from 'node:crypto';

const SECRET_BYTES = 32;

/**
 * A new webhook signing secret, `whsec_<base64 of 32 random bytes>`. The
 * receiver gets it once, at endpoint creation, and verifies signatures with it.
 */
export function generateEndpointSecret(): string {
  return `whsec_${randomBytes(SECRET_BYTES).toString('base64')}`;
}
