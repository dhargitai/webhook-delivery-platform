import { describe, expect, it } from 'vitest';
import { SignatureService } from './signature-service.js';

// Key bytes 0x00..0x1f. The expected signatures below were computed
// independently with `openssl dgst -sha256 -mac HMAC -macopt hexkey:...` over
// `<id>.<timestamp>.<body>`, not with the code under test.
const SECRET = 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const ID = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W';
const TIMESTAMP = 1614265330;
const BODY = '{"event":"invoice.paid"}';
const BODY_SIGNATURE = 'v1,jf9rM/NINwipontWMpBdic7UzNbr2wjE/00bW5e9LeU=';
// A second secret, key bytes 0x20..0x3f, signed the same way for rotation.
const SECOND_SECRET = 'whsec_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=';
const SECOND_BODY_SIGNATURE = 'v1,OCOawTO84puAAQNbGbbgMxNzGpTIlKrJCEo8a6zx344=';

describe('SignatureService.sign', () => {
  const service = new SignatureService();

  it('signs id.timestamp.body with HMAC-SHA256 under the decoded secret', () => {
    expect(service.sign([SECRET], ID, TIMESTAMP, BODY)).toBe(BODY_SIGNATURE);
  });

  it('signs a Uint8Array body exactly like the same string', () => {
    const bytes = new TextEncoder().encode(BODY);

    expect(service.sign([SECRET], ID, TIMESTAMP, bytes)).toBe(BODY_SIGNATURE);
  });

  it('signs the UTF-8 bytes of a non-ASCII body', () => {
    expect(service.sign([SECRET], ID, TIMESTAMP, '{"name":"Zoë €"}')).toBe(
      'v1,XkOdKg8xQrAzXLI5TMXqmqv9SypOykG7p+UpofVA3ik=',
    );
  });

  it.each([
    { name: 'the id', id: `${ID}x`, timestamp: TIMESTAMP, body: BODY },
    { name: 'the timestamp', id: ID, timestamp: TIMESTAMP + 1, body: BODY },
    { name: 'the body', id: ID, timestamp: TIMESTAMP, body: `${BODY} ` },
  ])('produces a different signature when $name changes', (input) => {
    expect(
      service.sign([SECRET], input.id, input.timestamp, input.body),
    ).not.toBe(BODY_SIGNATURE);
  });

  it.each([
    {
      name: 'has no whsec_ prefix',
      secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    },
    { name: 'is not valid base64', secret: 'whsec_not base64!' },
    {
      name: 'decodes to fewer than 32 bytes',
      secret: 'whsec_AAECAwQFBgcICQoLDA0ODw==',
    },
    { name: 'is empty after the prefix', secret: 'whsec_' },
  ])('throws when a secret $name', ({ secret }) => {
    expect(() => service.sign([secret], ID, TIMESTAMP, BODY)).toThrow(
      /secret/i,
    );
  });

  it('throws when no secret is given', () => {
    expect(() => service.sign([], ID, TIMESTAMP, BODY)).toThrow(/secret/i);
  });
});

describe('SignatureService.sign with several secrets', () => {
  it('emits one space-separated v1 entry per secret, in the order given', () => {
    const header = new SignatureService().sign(
      [SECRET, SECOND_SECRET],
      ID,
      TIMESTAMP,
      BODY,
    );

    expect(header).toBe(`${BODY_SIGNATURE} ${SECOND_BODY_SIGNATURE}`);
  });
});

describe('SignatureService.verify', () => {
  const service = new SignatureService();
  const verify = (
    header: string,
    overrides: {
      id?: string;
      timestamp?: number;
      body?: string | Uint8Array;
      secrets?: string[];
    } = {},
  ) =>
    service.verify(
      header,
      overrides.id ?? ID,
      overrides.timestamp ?? TIMESTAMP,
      overrides.body ?? BODY,
      overrides.secrets ?? [SECRET],
      // The request was just made: well inside the window.
      new Date(TIMESTAMP * 1000),
    );

  it('accepts a header produced by sign', () => {
    expect(verify(service.sign([SECRET], ID, TIMESTAMP, BODY))).toBe(true);
  });

  it('accepts a Uint8Array body that holds the signed bytes', () => {
    expect(
      verify(BODY_SIGNATURE, { body: new TextEncoder().encode(BODY) }),
    ).toBe(true);
  });

  describe('during a secret rotation', () => {
    const both = `${BODY_SIGNATURE} ${SECOND_BODY_SIGNATURE}`;

    it.each([
      { name: 'the old secret alone', secrets: [SECRET] },
      { name: 'the new secret alone', secrets: [SECOND_SECRET] },
      { name: 'both secrets', secrets: [SECRET, SECOND_SECRET] },
    ])('accepts a two-signature header against $name', ({ secrets }) => {
      expect(verify(both, { secrets })).toBe(true);
    });

    it('accepts a header signed only with the old secret while both are configured', () => {
      expect(verify(BODY_SIGNATURE, { secrets: [SECOND_SECRET, SECRET] })).toBe(
        true,
      );
    });

    it('accepts when only the second header entry matches', () => {
      expect(verify(both, { secrets: [SECOND_SECRET] })).toBe(true);
    });
  });

  it.each([
    { name: 'a tampered body', overrides: { body: `${BODY} ` } },
    { name: 'another id', overrides: { id: `${ID}x` } },
    { name: 'another timestamp', overrides: { timestamp: TIMESTAMP + 1 } },
    { name: 'another secret', overrides: { secrets: [SECOND_SECRET] } },
  ])('rejects $name', ({ overrides }) => {
    expect(verify(BODY_SIGNATURE, overrides)).toBe(false);
  });

  it('rejects a signature with one flipped character', () => {
    const flipped = BODY_SIGNATURE.replace('jf9r', 'jf9s');

    expect(flipped).not.toBe(BODY_SIGNATURE);
    expect(verify(flipped)).toBe(false);
  });

  it.each([
    { name: 'empty', header: '' },
    { name: 'only whitespace', header: '   ' },
    { name: 'without a version', header: BODY_SIGNATURE.slice(3) },
    { name: 'a v2 entry only', header: BODY_SIGNATURE.replace('v1,', 'v2,') },
    { name: 'a truncated signature', header: BODY_SIGNATURE.slice(0, -10) },
    { name: 'an over-long signature', header: `${BODY_SIGNATURE}AAAA` },
    { name: 'not base64', header: 'v1,!!!not-base64!!!' },
  ])(
    'returns false, not an error, for a header that is $name',
    ({ header }) => {
      expect(verify(header)).toBe(false);
    },
  );

  it('still accepts a valid entry next to unusable ones', () => {
    const header = `v2,abc garbage ${BODY_SIGNATURE} v1,AAAA`;

    expect(verify(header)).toBe(true);
  });

  it('throws on a malformed secret, like sign', () => {
    expect(() => verify(BODY_SIGNATURE, { secrets: ['nope'] })).toThrow(
      /secret/i,
    );
    expect(() => verify(BODY_SIGNATURE, { secrets: [] })).toThrow(/secret/i);
  });
});

describe('SignatureService tolerance window', () => {
  const HOUR = 3600;
  const at = (secondsAfterTimestamp: number) =>
    new Date((TIMESTAMP + secondsAfterTimestamp) * 1000);
  const verifyAt = (service: SignatureService, now: Date) =>
    service.verify(BODY_SIGNATURE, ID, TIMESTAMP, BODY, [SECRET], now);

  describe('by default (5 minutes)', () => {
    const service = new SignatureService();

    it.each([
      { name: 'just made', seconds: 0, accepted: true },
      { name: '300 s old', seconds: 300, accepted: true },
      { name: '301 s old', seconds: 301, accepted: false },
      { name: '300 s in the future', seconds: -300, accepted: true },
      { name: '301 s in the future', seconds: -301, accepted: false },
      { name: '300.9 s old (whole seconds)', seconds: 300.9, accepted: true },
    ])('a request $name is accepted: $accepted', ({ seconds, accepted }) => {
      expect(verifyAt(service, at(seconds))).toBe(accepted);
    });

    it('rejects a captured request replayed 20 hours later', () => {
      expect(verifyAt(service, at(20 * HOUR))).toBe(false);
    });

    it('accepts the same event re-signed with a fresh timestamp', () => {
      // What a retry does: the id and body stay, the timestamp is renewed.
      const freshTimestamp = TIMESTAMP + 20 * HOUR;
      const header = service.sign([SECRET], ID, freshTimestamp, BODY);

      expect(
        service.verify(
          header,
          ID,
          freshTimestamp,
          BODY,
          [SECRET],
          new Date(freshTimestamp * 1000),
        ),
      ).toBe(true);
    });

    it('still rejects a wrong signature on a fresh timestamp', () => {
      expect(
        service.verify(
          BODY_SIGNATURE,
          ID,
          TIMESTAMP,
          `${BODY} `,
          [SECRET],
          at(0),
        ),
      ).toBe(false);
    });
  });

  describe('with a custom tolerance', () => {
    it.each([
      { seconds: 10, accepted: true },
      { seconds: 11, accepted: false },
      { seconds: -10, accepted: true },
      { seconds: -11, accepted: false },
    ])('of 10 s accepts $seconds s: $accepted', ({ seconds, accepted }) => {
      const service = new SignatureService({ toleranceSeconds: 10 });

      expect(verifyAt(service, at(seconds))).toBe(accepted);
    });

    it('is not narrowed by the default', () => {
      const service = new SignatureService({ toleranceSeconds: 600 });

      expect(verifyAt(service, at(500))).toBe(true);
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a tolerance of %s',
    (toleranceSeconds) => {
      expect(() => new SignatureService({ toleranceSeconds })).toThrow(
        RangeError,
      );
    },
  );
});

describe('SignatureService with an unusable clock or timestamp', () => {
  const service = new SignatureService();

  it('refuses an invalid Date instead of treating it as inside the window', () => {
    expect(
      service.verify(
        BODY_SIGNATURE,
        ID,
        TIMESTAMP,
        BODY,
        [SECRET],
        new Date(Number.NaN),
      ),
    ).toBe(false);
  });

  it('refuses a NaN timestamp', () => {
    const header = service.sign([SECRET], ID, Number.NaN, BODY);

    expect(
      service.verify(
        header,
        ID,
        Number.NaN,
        BODY,
        [SECRET],
        new Date(TIMESTAMP * 1000),
      ),
    ).toBe(false);
  });
});
