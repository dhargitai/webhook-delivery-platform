import { describe, expect, it } from 'vitest';
import { CachedSecretOpener } from './cached-secret-opener.js';
import type { SealedSecret, SecretOpener } from './secret-cipher.js';

/** Answers with a secret named after the call, and counts how often it is asked. */
class CountingOpener implements SecretOpener {
  calls = 0;
  failNext = false;

  open(sealed: SealedSecret, aad: string): Promise<string> {
    this.calls += 1;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('KEK unavailable'));
    }
    return Promise.resolve(`secret:${aad}:${sealed.iv.toString('hex')}`);
  }
}

class Clock {
  constructor(public ms = 1_000_000) {}
  now = (): number => this.ms;
}

function sealed(ivByte: number): SealedSecret {
  return {
    kekId: 'v1',
    wrappedDek: Buffer.alloc(60),
    iv: Buffer.alloc(12, ivByte),
    ciphertext: Buffer.alloc(8),
    tag: Buffer.alloc(16),
  };
}

function setup(options: { ttlMs?: number; maxEntries?: number } = {}) {
  const inner = new CountingOpener();
  const clock = new Clock();
  const opener = new CachedSecretOpener(inner, { ...options, now: clock.now });
  return { inner, clock, opener };
}

describe('CachedSecretOpener', () => {
  it('serves a second open within the TTL without asking again', async () => {
    const { inner, clock, opener } = setup();
    const first = await opener.open(sealed(1), 'aad-a');

    clock.ms += 59_999;
    const second = await opener.open(sealed(1), 'aad-a');

    expect(second).toBe(first);
    expect(inner.calls).toBe(1);
  });

  it('defaults to the PRD 60 s and asks again once they have passed', async () => {
    const { inner, clock, opener } = setup();
    await opener.open(sealed(1), 'aad-a');

    clock.ms += 60_000;
    await opener.open(sealed(1), 'aad-a');

    expect(inner.calls).toBe(2);
  });

  it('honours a shorter TTL', async () => {
    const { inner, clock, opener } = setup({ ttlMs: 10 });
    await opener.open(sealed(1), 'aad-a');

    clock.ms += 10;
    await opener.open(sealed(1), 'aad-a');

    expect(inner.calls).toBe(2);
  });

  it('treats a new seal of the same endpoint (another IV) as a miss', async () => {
    const { inner, opener } = setup();
    await opener.open(sealed(1), 'aad-a');

    const rotated = await opener.open(sealed(2), 'aad-a');

    expect(rotated).toBe(`secret:aad-a:${'02'.repeat(12)}`);
    expect(inner.calls).toBe(2);
  });

  it('treats another endpoint with the same IV as a miss', async () => {
    const { inner, opener } = setup();
    await opener.open(sealed(1), 'aad-a');

    const other = await opener.open(sealed(1), 'aad-b');

    expect(other).toBe(`secret:aad-b:${'01'.repeat(12)}`);
    expect(inner.calls).toBe(2);
  });

  it('does not cache a failure', async () => {
    const { inner, opener } = setup();
    inner.failNext = true;

    await expect(opener.open(sealed(1), 'aad-a')).rejects.toThrow(
      'KEK unavailable',
    );
    await expect(opener.open(sealed(1), 'aad-a')).resolves.toBe(
      `secret:aad-a:${'01'.repeat(12)}`,
    );
    expect(inner.calls).toBe(2);
  });

  it('asks once for concurrent opens of the same secret', async () => {
    const { inner, opener } = setup();

    const [first, second] = await Promise.all([
      opener.open(sealed(1), 'aad-a'),
      opener.open(sealed(1), 'aad-a'),
    ]);

    expect(second).toBe(first);
    expect(inner.calls).toBe(1);
  });

  it('evicts the oldest entry past maxEntries', async () => {
    const { inner, opener } = setup({ maxEntries: 2 });
    await opener.open(sealed(1), 'aad-a');
    await opener.open(sealed(2), 'aad-b');
    await opener.open(sealed(3), 'aad-c');
    expect(inner.calls).toBe(3);

    await opener.open(sealed(2), 'aad-b');
    expect(inner.calls).toBe(3);

    await opener.open(sealed(1), 'aad-a');
    expect(inner.calls).toBe(4);
  });

  it('evicts an expired entry before a live one', async () => {
    const { inner, clock, opener } = setup({ ttlMs: 100, maxEntries: 2 });
    await opener.open(sealed(1), 'aad-a');
    clock.ms += 50;
    await opener.open(sealed(2), 'aad-b');
    clock.ms += 60; // aad-a has expired, aad-b has 40 ms left.

    await opener.open(sealed(3), 'aad-c');
    await opener.open(sealed(2), 'aad-b');

    expect(inner.calls).toBe(3);
  });

  it.each([
    { ttlMs: 0 },
    { ttlMs: -1 },
    { ttlMs: 1.5 },
    { maxEntries: 0 },
    { maxEntries: 2.5 },
  ])('rejects the options %o', (options) => {
    expect(() => new CachedSecretOpener(new CountingOpener(), options)).toThrow(
      RangeError,
    );
  });
});
