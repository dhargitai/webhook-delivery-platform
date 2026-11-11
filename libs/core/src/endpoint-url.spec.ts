import { describe, expect, it } from 'vitest';
import { validateEndpointUrl } from './endpoint-url.js';

describe('validateEndpointUrl', () => {
  it.each([
    {
      name: 'a plain https URL',
      raw: 'https://hooks.acme.test/in',
      url: 'https://hooks.acme.test/in',
    },
    {
      name: 'port 443 spelled out (normalised away)',
      raw: 'https://hooks.acme.test:443/in',
      url: 'https://hooks.acme.test/in',
    },
    {
      name: 'port 8443',
      raw: 'https://hooks.acme.test:8443/in',
      url: 'https://hooks.acme.test:8443/in',
    },
    {
      name: 'a path and query string',
      raw: 'https://hooks.acme.test/a/b?token=1',
      url: 'https://hooks.acme.test/a/b?token=1',
    },
    {
      name: 'an upper-case host (normalised)',
      raw: 'https://HOOKS.Acme.test/in',
      url: 'https://hooks.acme.test/in',
    },
  ])('accepts $name', ({ raw, url }) => {
    expect(validateEndpointUrl(raw)).toEqual({ ok: true, url });
  });

  it.each([
    { name: 'plain http', raw: 'http://hooks.acme.test/in', reason: /https/i },
    { name: 'a javascript: URL', raw: 'javascript:alert(1)', reason: /https/i },
    { name: 'a file: URL', raw: 'file:///etc/passwd', reason: /https/i },
    {
      name: 'credentials in the URL',
      raw: 'https://user:pass@hooks.acme.test/in',
      reason: /credentials/i,
    },
    {
      name: 'a username without a password',
      raw: 'https://user@hooks.acme.test/in',
      reason: /credentials/i,
    },
    {
      name: 'a port other than 443 and 8443',
      raw: 'https://hooks.acme.test:8080/in',
      reason: /8080.*443.*8443/,
    },
    { name: 'a relative URL', raw: '/hooks/in', reason: /absolute/i },
    { name: 'an empty string', raw: '', reason: /absolute/i },
    { name: 'plain text', raw: 'not a url', reason: /absolute/i },
    { name: 'a URL without a host', raw: 'https://', reason: /absolute/i },
  ])('rejects $name with a reason', ({ raw, reason }) => {
    const result = validateEndpointUrl(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(reason);
    }
  });
});
