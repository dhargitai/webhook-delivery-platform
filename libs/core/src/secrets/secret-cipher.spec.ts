import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvKeyProvider } from './env-key-provider.js';
import { type SealedSecret, SecretCipher, secretAad } from './secret-cipher.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ENDPOINT = '22222222-2222-4222-8222-222222222222';
const SECRET = 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

// A secret sealed independently with Python's `cryptography` (AESGCM), not
// with the code under test: KEK 0x00..0x1f wraps DEK 0x20..0x3f (IV
// 0x40..0x4b), and the DEK encrypts SECRET with IV 0x50..0x5b and the AAD
// `wdp:endpoint-secret:v1:<TENANT>:<ENDPOINT>`. It pins the stored format.
const KEK = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const STORED: SealedSecret = {
  kekId: 'v1',
  wrappedDek: Buffer.from(
    'QEFCQ0RFRkdISUpLwpiMAAIZoSTl7T0dt0k9dEn3YG+DADkUT3503qsu0+T4vMJfBYRf0aF1r065k28A',
    'base64',
  ),
  iv: Buffer.from('UFFSU1RVVldYWVpb', 'base64'),
  ciphertext: Buffer.from(
    'xsjbd1JwNkxxTEttPE/ByL+lDG4Xuj1BkrOcIvFYZVGskwCKP3n+ME7zKz6Yp+eyw20=',
    'base64',
  ),
  tag: Buffer.from('lZlcJDTOYL5uUab53DiubQ==', 'base64'),
};

function flipByte(buffer: Buffer, index: number): Buffer {
  const copy = Buffer.from(buffer);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

describe('secretAad', () => {
  it('names the purpose, the format version, the tenant and the endpoint', () => {
    expect(secretAad(TENANT, ENDPOINT)).toBe(
      `wdp:endpoint-secret:v1:${TENANT}:${ENDPOINT}`,
    );
  });
});

describe('SecretCipher', () => {
  const cipher = new SecretCipher(
    new EnvKeyProvider({ kekId: 'v1', key: KEK }),
  );
  const aad = secretAad(TENANT, ENDPOINT);

  it('opens a secret sealed independently with AES-256-GCM', async () => {
    await expect(cipher.open(STORED, aad)).resolves.toBe(SECRET);
  });

  it('opens what it sealed', async () => {
    const sealed = await cipher.seal(SECRET, aad);

    await expect(cipher.open(sealed, aad)).resolves.toBe(SECRET);
  });

  it('stores no plaintext bytes', async () => {
    const sealed = await cipher.seal(SECRET, aad);

    for (const part of [
      sealed.wrappedDek,
      sealed.iv,
      sealed.ciphertext,
      sealed.tag,
    ]) {
      expect(part.includes(Buffer.from(SECRET))).toBe(false);
      expect(part.includes(Buffer.from(SECRET.slice('whsec_'.length)))).toBe(
        false,
      );
    }
  });

  it('uses a fresh key and IV for every seal', async () => {
    const first = await cipher.seal(SECRET, aad);
    const second = await cipher.seal(SECRET, aad);

    expect(first.wrappedDek.equals(second.wrappedDek)).toBe(false);
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('seals under the provider KEK id with a 12-byte IV and a 16-byte tag', async () => {
    const sealed = await cipher.seal(SECRET, aad);

    expect(sealed.kekId).toBe('v1');
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
  });

  it.each([
    { name: 'another endpoint', aad: secretAad(TENANT, TENANT) },
    { name: 'another tenant', aad: secretAad(ENDPOINT, ENDPOINT) },
    { name: 'no binding', aad: '' },
  ])('refuses to open a secret bound to $name', async ({ aad: other }) => {
    await expect(cipher.open(STORED, other)).rejects.toThrow();
  });

  it.each([
    {
      name: 'the ciphertext',
      change: { ciphertext: flipByte(STORED.ciphertext, 0) },
    },
    { name: 'the tag', change: { tag: flipByte(STORED.tag, 15) } },
    { name: 'the IV', change: { iv: flipByte(STORED.iv, 0) } },
    {
      name: 'the wrapped DEK',
      change: { wrappedDek: flipByte(STORED.wrappedDek, 20) },
    },
  ])('refuses a secret with a flipped byte in $name', async ({ change }) => {
    await expect(cipher.open({ ...STORED, ...change }, aad)).rejects.toThrow();
  });

  it('refuses a truncated tag', async () => {
    await expect(
      cipher.open({ ...STORED, tag: STORED.tag.subarray(0, 4) }, aad),
    ).rejects.toThrow(/tag/);
  });

  it('refuses a secret sealed under another KEK', async () => {
    const other = new SecretCipher(
      new EnvKeyProvider({ kekId: 'v1', key: randomBytes(32) }),
    );

    await expect(other.open(STORED, aad)).rejects.toThrow();
  });

  it('refuses a KEK id the provider does not hold', async () => {
    await expect(cipher.open({ ...STORED, kekId: 'v2' }, aad)).rejects.toThrow(
      /v2/,
    );
  });
});
