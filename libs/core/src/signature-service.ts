import { createHmac } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';
const SECRET_BYTES = 32;
const SIGNATURE_VERSION = 'v1';
// Standard base64 with optional padding. Buffer.from(..., 'base64') silently
// skips invalid characters, so the shape is checked before decoding.
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Signs outgoing webhook requests in the Standard Webhooks style: an
 * HMAC-SHA256 over `<id>.<timestamp>.<rawBody>`, sent as `v1,<base64>`.
 */
export class SignatureService {
  /**
   * Returns the `webhook-signature` header value: one `v1,<base64>` entry per
   * secret, space-separated, in the order given (several during a rotation).
   * The caller passes the timestamp, so a retry can sign with a fresh one, and
   * the exact bytes it is about to send, so the receiver verifies what it gets.
   */
  sign(
    secrets: readonly string[],
    id: string,
    timestamp: number,
    rawBody: string | Uint8Array,
  ): string {
    if (secrets.length === 0) {
      throw new Error('at least one signing secret is required');
    }
    // Decode every secret before signing: a bad one is a configuration bug and
    // must fail loudly, not be left out of the header.
    const keys = secrets.map(decodeSecret);
    const signed = Buffer.concat([
      Buffer.from(`${id}.${timestamp}.`, 'utf8'),
      typeof rawBody === 'string'
        ? Buffer.from(rawBody, 'utf8')
        : Buffer.from(rawBody),
    ]);
    return keys
      .map(
        (key) =>
          `${SIGNATURE_VERSION},${createHmac('sha256', key).update(signed).digest('base64')}`,
      )
      .join(' ');
  }
}

/** `whsec_<base64 of 32 bytes>` to the 32 key bytes. */
function decodeSecret(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX)
    ? secret.slice(SECRET_PREFIX.length)
    : undefined;
  if (encoded === undefined || !BASE64_PATTERN.test(encoded)) {
    throw new Error(`a signing secret must be ${SECRET_PREFIX}<base64>`);
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== SECRET_BYTES) {
    throw new Error(
      `a signing secret must decode to ${SECRET_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}
