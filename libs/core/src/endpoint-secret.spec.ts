import { describe, expect, it } from 'vitest';
import { generateEndpointSecret } from './endpoint-secret.js';

const SECRET_PATTERN = /^whsec_[A-Za-z0-9+/]{43}=$/;

describe('generateEndpointSecret', () => {
  it('produces whsec_ followed by the base64 of exactly 32 bytes', () => {
    const secret = generateEndpointSecret();

    expect(secret).toMatch(SECRET_PATTERN);
    const bytes = Buffer.from(secret.slice('whsec_'.length), 'base64');
    expect(bytes).toHaveLength(32);
  });

  it('never repeats a secret across calls', () => {
    const secrets = Array.from({ length: 1000 }, () =>
      generateEndpointSecret(),
    );

    expect(new Set(secrets).size).toBe(1000);
  });
});
