const KEY_BYTES = 32;
// 32 bytes are exactly 44 base64 characters, the last one padding. The shape
// is checked before decoding: Buffer.from(..., 'base64') silently skips
// invalid characters, so a mangled key could still decode to 32 bytes.
const KEK_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Decodes a key-encryption key as the environment holds it
 * (`SECRETS_KEK_V1`): standard base64 of 32 random bytes. The error never
 * contains the value.
 */
export function parseKek(value: string): Buffer {
  if (!KEK_PATTERN.test(value)) {
    throw new RangeError(
      `a KEK must be the standard base64 of ${KEY_BYTES} bytes (44 characters)`,
    );
  }
  return Buffer.from(value, 'base64');
}
