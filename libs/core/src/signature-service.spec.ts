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
