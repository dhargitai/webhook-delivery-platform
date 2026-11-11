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

  describe('with an allowlist of hosts', () => {
    const allowHosts = ['mock-receiver', 'localhost'];

    it.each([
      {
        name: 'plain http on any port',
        raw: 'http://mock-receiver:4000/hook',
        url: 'http://mock-receiver:4000/hook',
      },
      {
        name: 'https on a port that is normally refused',
        raw: 'https://mock-receiver:9999/hook',
        url: 'https://mock-receiver:9999/hook',
      },
      {
        name: 'the host in another case',
        raw: 'http://MOCK-Receiver:4000/hook',
        url: 'http://mock-receiver:4000/hook',
      },
      {
        name: 'a second allowed host',
        raw: 'http://localhost:3000/in',
        url: 'http://localhost:3000/in',
      },
    ])('accepts $name', ({ raw, url }) => {
      expect(validateEndpointUrl(raw, { allowHosts })).toEqual({
        ok: true,
        url,
      });
    });

    it.each([
      {
        name: 'a host that is not on the list, still needing https',
        raw: 'http://other-host:4000/hook',
        reason: /https/i,
      },
      {
        name: 'a host that is not on the list, still needing the port rule',
        raw: 'https://other-host:4000/hook',
        reason: /4000.*443.*8443/,
      },
      {
        name: 'a subdomain of an allowed host',
        raw: 'http://evil.mock-receiver:4000/hook',
        reason: /https/i,
      },
      {
        name: 'a host that merely starts with an allowed one',
        raw: 'http://mock-receiver.evil.com:4000/hook',
        reason: /https/i,
      },
      {
        name: 'credentials, even on an allowed host',
        raw: 'http://user:pw@mock-receiver:4000/hook',
        reason: /credentials/i,
      },
      {
        name: 'a scheme other than http or https, even on an allowed host',
        raw: 'ftp://mock-receiver/hook',
        reason: /http/i,
      },
    ])('still rejects $name', ({ raw, reason }) => {
      const result = validateEndpointUrl(raw, { allowHosts });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(reason);
      }
    });

    it('changes nothing when the list is empty', () => {
      expect(
        validateEndpointUrl('http://mock-receiver:4000/hook', {
          allowHosts: [],
        }).ok,
      ).toBe(false);
    });
  });
});
