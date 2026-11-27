import { randomBytes } from 'node:crypto';

const SECRET_BYTES = 32;

/**
 * PRD: after a rotation the previous secret keeps signing for 24 h, so a
 * receiver can deploy the new one without dropping deliveries.
 */
export const SECRET_ROTATION_OVERLAP_SECONDS = 24 * 60 * 60;

/**
 * A new webhook signing secret, `whsec_<base64 of 32 random bytes>`. The
 * receiver gets it once, at endpoint creation, and verifies signatures with it.
 */
export function generateEndpointSecret(): string {
  return `whsec_${randomBytes(SECRET_BYTES).toString('base64')}`;
}
