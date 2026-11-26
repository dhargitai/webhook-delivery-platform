import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvKeyProvider } from './env-key-provider.js';

const KEK = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
// The DEK 0x20..0x3f wrapped under KEK 0x00..0x1f with IV 0x40..0x4b, computed
// independently with Python's `cryptography` (AESGCM), not with the code under
// test: iv(12) ‖ ciphertext(32) ‖ tag(16).
const WRAPPED_DEK = Buffer.from(
  'QEFCQ0RFRkdISUpLwpiMAAIZoSTl7T0dt0k9dEn3YG+DADkUT3503qsu0+T4vMJfBYRf0aF1r065k28A',
  'base64',
);
const DEK = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x20 + i));

function flipByte(buffer: Buffer, index: number): Buffer {
  const copy = Buffer.from(buffer);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

describe('EnvKeyProvider', () => {
  const provider = new EnvKeyProvider({ kekId: 'v1', key: KEK });

  it('unwraps a DEK wrapped independently with AES-256-GCM', async () => {
    await expect(
      provider.unwrap({ kekId: 'v1', wrappedDek: WRAPPED_DEK }),
    ).resolves.toEqual(DEK);
  });

  it('wraps a DEK so that it unwraps to the same bytes', async () => {
    const dek = randomBytes(32);

    const wrapped = await provider.wrap(dek);

    expect(wrapped.kekId).toBe('v1');
    expect(wrapped.wrappedDek).toHaveLength(60);
    await expect(provider.unwrap(wrapped)).resolves.toEqual(dek);
  });

  it('never wraps the same DEK to the same bytes', async () => {
    const dek = randomBytes(32);

    const first = await provider.wrap(dek);
    const second = await provider.wrap(dek);

    expect(first.wrappedDek.equals(second.wrappedDek)).toBe(false);
  });

  it.each([
    { name: 'the IV', index: 0 },
    { name: 'the ciphertext', index: 12 },
    { name: 'the tag', index: 59 },
  ])(
    'refuses a wrapped DEK with a flipped byte in $name',
    async ({ index }) => {
      await expect(
        provider.unwrap({
          kekId: 'v1',
          wrappedDek: flipByte(WRAPPED_DEK, index),
        }),
      ).rejects.toThrow();
    },
  );

  it('refuses a wrapped DEK of the wrong length', async () => {
    await expect(
      provider.unwrap({ kekId: 'v1', wrappedDek: WRAPPED_DEK.subarray(0, 59) }),
    ).rejects.toThrow(/wrapped DEK/);
  });

  it('refuses a DEK wrapped under another KEK', async () => {
    const other = new EnvKeyProvider({ kekId: 'v1', key: randomBytes(32) });

    await expect(
      other.unwrap({ kekId: 'v1', wrappedDek: WRAPPED_DEK }),
    ).rejects.toThrow();
  });

  it('refuses a KEK id it does not hold', async () => {
    await expect(
      provider.unwrap({ kekId: 'v2', wrappedDek: WRAPPED_DEK }),
    ).rejects.toThrow(/v2/);
  });

  it.each([0, 16, 31, 33])('rejects a KEK of %i bytes', (length) => {
    expect(
      () => new EnvKeyProvider({ kekId: 'v1', key: Buffer.alloc(length) }),
    ).toThrow(RangeError);
  });

  it('rejects an empty KEK id', () => {
    expect(() => new EnvKeyProvider({ kekId: '', key: KEK })).toThrow(
      RangeError,
    );
  });
});
