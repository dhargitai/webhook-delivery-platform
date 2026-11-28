import { describe, expect, it } from 'vitest';
import { uuidV7Millis } from './uuid-v7-time.js';

describe('uuidV7Millis', () => {
  it('reads the Unix milliseconds from the first 48 bits', () => {
    // Computed independently: 2026-11-28T12:00:00.123Z is 1795867200123 ms,
    // 0x01a22206ca7b.
    expect(uuidV7Millis('01a22206-ca7b-7abc-9def-0123456789ab')).toBe(
      1_795_867_200_123,
    );
  });

  it('accepts upper-case hex', () => {
    expect(uuidV7Millis('01A22206-CA7B-7ABC-9DEF-0123456789AB')).toBe(
      1_795_867_200_123,
    );
  });

  it.each([
    { name: 'a version 4 id', id: '01a22206-ca7b-4abc-9def-0123456789ab' },
    { name: 'a wrong variant', id: '01a22206-ca7b-7abc-1def-0123456789ab' },
    { name: 'a malformed string', id: 'not-a-uuid' },
    { name: 'a truncated id', id: '01a22206-ca7b-7abc-9def-0123456789a' },
  ])('rejects $name', ({ id }) => {
    expect(() => uuidV7Millis(id)).toThrow(/UUIDv7/);
  });
});
