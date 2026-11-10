import { describe, expect, it } from 'vitest';
import { generateApiKey, parseApiKey, verifyApiKey } from './api-key.js';

const KEY_PATTERN = /^whk_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/;

describe('generateApiKey', () => {
  it('produces a whk_<prefix>_<secret> key with a 8-char alphanumeric prefix', () => {
    const { key } = generateApiKey();

    expect(key).toMatch(KEY_PATTERN);
  });

  it('returns the prefix embedded in the key and a SHA-256 hex hash', () => {
    const { key, prefix, hash } = generateApiKey();

    expect(key.startsWith(`whk_${prefix}_`)).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key);
  });

  it('never repeats a key or a prefix across calls', () => {
    const keys = Array.from({ length: 200 }, () => generateApiKey());

    expect(new Set(keys.map((k) => k.key)).size).toBe(200);
    expect(new Set(keys.map((k) => k.prefix)).size).toBe(200);
  });
});

describe('parseApiKey', () => {
  it('extracts the prefix of a generated key', () => {
    const { key, prefix } = generateApiKey();

    expect(parseApiKey(key)).toEqual({ prefix });
  });

  it('parses a key whose secret contains underscores and dashes', () => {
    const secret = `${'a_b-c'.repeat(8)}abc`; // 43 chars
    expect(secret).toHaveLength(43);

    expect(parseApiKey(`whk_Ab3dEf9h_${secret}`)).toEqual({
      prefix: 'Ab3dEf9h',
    });
  });

  const secret = 'x'.repeat(43);
  it.each([
    { name: 'an empty string', raw: '' },
    { name: 'a wrong scheme', raw: `sk_Ab3dEf9h_${secret}` },
    { name: 'a short prefix', raw: `whk_Ab3dEf9_${secret}` },
    { name: 'a long prefix', raw: `whk_Ab3dEf9hi_${secret}` },
    { name: 'a prefix with a dash', raw: `whk_Ab3dEf-h_${secret}` },
    { name: 'a missing secret', raw: 'whk_Ab3dEf9h_' },
    { name: 'a short secret', raw: `whk_Ab3dEf9h_${'x'.repeat(42)}` },
    { name: 'a long secret', raw: `whk_Ab3dEf9h_${'x'.repeat(44)}` },
    { name: 'an extra segment', raw: `whk_Ab3dEf9h_${secret}_extra` },
    { name: 'surrounding whitespace', raw: ` whk_Ab3dEf9h_${secret} ` },
  ])('returns null for $name', ({ raw }) => {
    expect(parseApiKey(raw)).toBeNull();
  });
});

describe('verifyApiKey', () => {
  it('accepts the key that produced the stored hash', () => {
    const { key, hash } = generateApiKey();

    expect(verifyApiKey(key, hash)).toBe(true);
  });

  it('rejects a key with one altered secret character', () => {
    const { key, hash } = generateApiKey();
    const last = key.at(-1) === 'A' ? 'B' : 'A';
    const tampered = `${key.slice(0, -1)}${last}`;

    expect(verifyApiKey(tampered, hash)).toBe(false);
  });

  it("rejects another key's hash", () => {
    const first = generateApiKey();
    const second = generateApiKey();

    expect(verifyApiKey(first.key, second.hash)).toBe(false);
  });

  it.each([
    { name: 'an empty key', raw: '' },
    { name: 'a truncated key', raw: generateApiKey().key.slice(0, 20) },
  ])('rejects $name', ({ raw }) => {
    const { hash } = generateApiKey();

    expect(verifyApiKey(raw, hash)).toBe(false);
  });

  it.each([
    { name: 'empty', stored: '' },
    { name: 'too short', stored: 'abc123' },
    { name: 'too long', stored: 'a'.repeat(65) },
  ])(
    'returns false, not an error, when the stored hash is $name',
    ({ stored }) => {
      const { key } = generateApiKey();

      expect(verifyApiKey(key, stored)).toBe(false);
    },
  );
});
