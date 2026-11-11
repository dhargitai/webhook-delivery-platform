import { createHash } from 'node:crypto';

/**
 * Serialises a JSON value with object keys sorted at every depth, so two
 * bodies that differ only in key order produce the same string. Array order
 * is significant and kept as is.
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      // Mirrors JSON.stringify, which omits undefined-valued keys.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 (hex) of the canonical JSON of an event request. Stored next to the
 * idempotency key so a retry with the same key can be told apart from a key
 * reused for a different body.
 */
export function requestHash(body: unknown): string {
  return createHash('sha256').update(canonicalize(body)).digest('hex');
}
