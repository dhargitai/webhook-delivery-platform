import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';
const SECRET_BYTES = 32;
const SIGNATURE_VERSION = 'v1';
const ENTRY_PREFIX = `${SIGNATURE_VERSION},`;
// Standard base64 with optional padding. Buffer.from(..., 'base64') silently
// skips invalid characters and stops at '=', so the shape is checked before
// decoding: otherwise junk appended to a valid signature would still verify.
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Signs and verifies webhook requests in the Standard Webhooks style: an
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
    return computeSignatures(secrets, id, timestamp, rawBody)
      .map((signature) => `${ENTRY_PREFIX}${signature.toString('base64')}`)
      .join(' ');
  }

  /**
   * True when any `v1` entry of the header matches the signature of any of the
   * secrets. Accepting either secret is what lets a receiver cut over during a
   * rotation. Anything unusable in the header (other versions, junk, a wrong
   * length) is skipped, never thrown: the header is attacker input. A bad
   * secret does throw, since that is a configuration bug.
   */
  verify(
    header: string,
    id: string,
    timestamp: number,
    rawBody: string | Uint8Array,
    secrets: readonly string[],
  ): boolean {
    const expected = computeSignatures(secrets, id, timestamp, rawBody);
    const presented = parseHeader(header);
    // Every pair is compared, without stopping at the first match, so the time
    // taken does not reveal which secret or entry matched.
    let matched = false;
    for (const wanted of expected) {
      for (const candidate of presented) {
        // timingSafeEqual throws on a length mismatch, so check it first.
        if (
          candidate.length === wanted.length &&
          timingSafeEqual(candidate, wanted)
        ) {
          matched = true;
        }
      }
    }
    return matched;
  }
}

/** One raw HMAC per secret, in order. Shared so sign and verify cannot drift. */
function computeSignatures(
  secrets: readonly string[],
  id: string,
  timestamp: number,
  rawBody: string | Uint8Array,
): Buffer[] {
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
  return keys.map((key) => createHmac('sha256', key).update(signed).digest());
}

/** The decoded signatures of every well-formed `v1,<base64>` entry. */
function parseHeader(header: string): Buffer[] {
  const signatures: Buffer[] = [];
  for (const entry of header.split(/\s+/)) {
    if (!entry.startsWith(ENTRY_PREFIX)) {
      continue;
    }
    const encoded = entry.slice(ENTRY_PREFIX.length);
    if (BASE64_PATTERN.test(encoded)) {
      signatures.push(Buffer.from(encoded, 'base64'));
    }
  }
  return signatures;
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
