import { describe, expect, it } from 'vitest';
import { parseKek } from './kek.js';

const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const KEY_BASE64 = KEY_BYTES.toString('base64');

describe('parseKek', () => {
  it('decodes a base64 key of 32 bytes', () => {
    expect(parseKek(KEY_BASE64)).toEqual(KEY_BYTES);
  });

  it.each([
    { name: 'empty', value: '' },
    { name: '31 bytes', value: Buffer.alloc(31).toString('base64') },
    { name: '33 bytes', value: Buffer.alloc(33).toString('base64') },
    // Buffer.from(..., 'base64') skips these and would still give 32 bytes.
    {
      name: 'junk inside',
      value: `${KEY_BASE64.slice(0, 20)}!!${KEY_BASE64.slice(20)}`,
    },
    { name: 'surrounding spaces', value: ` ${KEY_BASE64} ` },
    { name: 'base64url', value: KEY_BYTES.toString('base64url') },
  ])('rejects a key that is $name', ({ value }) => {
    expect(() => parseKek(value)).toThrow(RangeError);
  });

  it('never echoes the key in its error', () => {
    const value = Buffer.alloc(31, 7).toString('base64');

    expect(() => parseKek(value)).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(value),
      }),
    );
  });
});
