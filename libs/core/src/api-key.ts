import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX_LENGTH = 8;
const SECRET_BYTES = 32;
// 32 bytes in unpadded base64url.
const SECRET_LENGTH = 43;
// No '_' or '-': the prefix sits between underscores, so it must not contain
// one, or splitting a key into its parts would be ambiguous.
const PREFIX_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const KEY_PATTERN = new RegExp(
  `^whk_([A-Za-z0-9]{${PREFIX_LENGTH}})_[A-Za-z0-9_-]{${SECRET_LENGTH}}$`,
);

export interface GeneratedApiKey {
  /** The full key. Shown to the tenant once and never stored. */
  key: string;
  /** Stored in clear text as the lookup handle. */
  prefix: string;
  /** SHA-256 hex of the full key. The only stored trace of the secret. */
  hash: string;
}

function randomPrefix(): string {
  const chars: string[] = [];
  while (chars.length < PREFIX_LENGTH) {
    for (const byte of randomBytes(PREFIX_LENGTH)) {
      // Rejecting 248..255 keeps the 62-letter choice free of modulo bias.
      if (byte < 248 && chars.length < PREFIX_LENGTH) {
        chars.push(PREFIX_ALPHABET.charAt(byte % PREFIX_ALPHABET.length));
      }
    }
  }
  return chars.join('');
}

function hashKey(key: string): string {
  // A plain SHA-256 is enough: the secret has 256 bits of entropy, so there is
  // nothing for a slow hash to protect against brute force.
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomPrefix();
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const key = `whk_${prefix}_${secret}`;
  return { key, prefix, hash: hashKey(key) };
}

/** Returns the lookup prefix of a well-formed key, or null for anything else. */
export function parseApiKey(raw: string): { prefix: string } | null {
  const match = KEY_PATTERN.exec(raw);
  const prefix = match?.[1];
  return prefix === undefined ? null : { prefix };
}

/** Constant-time check of a presented key against its stored hash. */
export function verifyApiKey(raw: string, storedHash: string): boolean {
  const presented = Buffer.from(hashKey(raw), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  // A stored hash of the wrong length can never match, so returning early
  // leaks nothing about the secret.
  if (presented.length !== stored.length) {
    return false;
  }
  return timingSafeEqual(presented, stored);
}
