import { describe, expect, it } from 'vitest';
import type { LookupAddress } from 'node:dns';
import {
  isBlockedAddress,
  SsrfBlockedError,
  SsrfGuard,
  type HostResolver,
} from './ssrf-guard.js';

describe('isBlockedAddress', () => {
  describe('blocks every deny-list category', () => {
    it.each([
      // IPv4
      ['0.0.0.0', 'unspecified'],
      ['0.255.255.255', 'unspecified'],
      ['10.0.0.1', 'private network (RFC 1918)'],
      ['10.255.255.255', 'private network (RFC 1918)'],
      ['172.16.0.1', 'private network (RFC 1918)'],
      ['172.31.255.255', 'private network (RFC 1918)'],
      ['192.168.0.1', 'private network (RFC 1918)'],
      ['192.168.255.255', 'private network (RFC 1918)'],
      ['100.64.0.1', 'carrier-grade NAT'],
      ['100.127.255.255', 'carrier-grade NAT'],
      ['127.0.0.1', 'loopback'],
      ['127.255.255.255', 'loopback'],
      ['169.254.0.1', 'link-local'],
      ['169.254.169.254', 'link-local'],
      ['192.0.0.1', 'IETF protocol assignment'],
      ['192.0.0.255', 'IETF protocol assignment'],
      ['192.0.2.1', 'documentation'],
      ['198.51.100.1', 'documentation'],
      ['203.0.113.1', 'documentation'],
      ['198.18.0.1', 'benchmarking'],
      ['198.19.255.255', 'benchmarking'],
      ['224.0.0.1', 'multicast'],
      ['239.255.255.255', 'multicast'],
      ['240.0.0.1', 'reserved'],
      ['255.255.255.255', 'reserved'],
      // IPv6
      ['::', 'unspecified'],
      ['::1', 'loopback'],
      ['fc00::1', 'unique local (IPv6 private)'],
      [
        'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        'unique local (IPv6 private)',
      ],
      ['fe80::1', 'link-local'],
      ['febf::1', 'link-local'],
      ['ff02::1', 'multicast'],
      ['ff80::1', 'multicast'],
      ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'multicast'],
      ['2001:db8::1', 'documentation'],
      ['2001:db8:8000::1', 'documentation'],
      ['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', 'documentation'],
    ])('%s is %s', (address, reason) => {
      expect(isBlockedAddress(address)).toBe(reason);
    });
  });

  describe('sees through an IPv4 address wrapped in an IPv6 one', () => {
    it.each([
      // IPv4-mapped, dotted and hex forms
      ['::ffff:10.0.0.1', 'private network (RFC 1918)'],
      ['::ffff:a00:1', 'private network (RFC 1918)'],
      ['::ffff:127.0.0.1', 'loopback'],
      ['::ffff:169.254.169.254', 'link-local'],
      // NAT64
      ['64:ff9b::a00:1', 'private network (RFC 1918)'],
      ['64:ff9b::169.254.169.254', 'link-local'],
      // 6to4
      ['2002:a00:1::', 'private network (RFC 1918)'],
      ['2002:7f00:1::1', 'loopback'],
    ])('%s is %s', (address, reason) => {
      expect(isBlockedAddress(address)).toBe(reason);
    });

    it.each([
      '::ffff:93.184.216.34',
      '::ffff:5db8:d822',
      '64:ff9b::5db8:d822',
      '2002:5db8:d822::',
    ])('allows %s, which wraps a public address', (address) => {
      expect(isBlockedAddress(address)).toBeUndefined();
    });
  });

  describe('allows public addresses, right up to the edge of a blocked range', () => {
    it.each([
      '93.184.216.34',
      '8.8.8.8',
      '1.1.1.1',
      '1.0.0.0',
      '9.255.255.255',
      '11.0.0.0',
      '100.63.255.255',
      '100.128.0.0',
      '126.255.255.255',
      '128.0.0.1',
      '169.253.255.255',
      '169.255.0.0',
      '172.15.255.255',
      '172.32.0.0',
      '192.0.1.1',
      '192.167.255.255',
      '192.169.0.0',
      '198.17.255.255',
      '198.20.0.0',
      '198.51.99.255',
      '198.51.101.0',
      '203.0.112.255',
      '203.0.114.0',
      '223.255.255.255',
      '2606:4700::1111',
      '2001:4860:4860::8888',
      '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff',
      '2001:db9::1',
      'fbff:ffff::1',
      'fe00::1',
      // Just past fe80::/10, which ends at febf:ffff:...
      'fec0::1',
      // Not in 64:ff9b::/96, so no IPv4 address is embedded in it.
      '64:ff9b::1:a00:1',
    ])('%s', (address) => {
      expect(isBlockedAddress(address)).toBeUndefined();
    });
  });

  it.each(['not-an-ip', '', '10.0.0', '10.0.0.256', 'example.com'])(
    'refuses %j as input instead of treating it as public',
    (value) => {
      expect(() => isBlockedAddress(value)).toThrow(TypeError);
    },
  );
});

const PUBLIC: LookupAddress = { address: '93.184.216.34', family: 4 };
const PRIVATE: LookupAddress = { address: '10.0.0.5', family: 4 };
const METADATA: LookupAddress = { address: '169.254.169.254', family: 4 };

/** A resolver that answers each call from the script, in order. */
function scripted(...answers: LookupAddress[][]): HostResolver & {
  calls: string[];
} {
  const calls: string[] = [];
  const resolve: HostResolver = (hostname) => {
    calls.push(hostname);
    const answer = answers[calls.length - 1];
    if (answer === undefined) throw new Error('resolver called too often');
    return Promise.resolve(answer);
  };
  return Object.assign(resolve, { calls });
}

/** Calls the guard the way Node does without `all`: one address back. */
function lookupOne(guard: SsrfGuard, hostname: string) {
  return new Promise<{ address: string; family?: number }>(
    (resolve, reject) => {
      guard.lookup(hostname, {}, (error, address, family) => {
        if (error) return reject(error);
        if (typeof address !== 'string') {
          return reject(new Error('expected a single address'));
        }
        resolve({ address, family });
      });
    },
  );
}

/** Calls the guard the way a happy-eyeballs connect does: `all: true`. */
function lookupAll(guard: SsrfGuard, hostname: string) {
  return new Promise<LookupAddress[]>((resolve, reject) => {
    guard.lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return reject(error);
      if (typeof addresses === 'string') {
        return reject(new Error('expected a list of addresses'));
      }
      resolve(addresses);
    });
  });
}

describe('SsrfGuard.lookup', () => {
  it('refuses a name that resolves to a blocked address, and says why', async () => {
    const guard = new SsrfGuard({ resolve: scripted([METADATA]) });

    const refused = lookupOne(guard, 'metadata.evil.test');

    await expect(refused).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(refused).rejects.toMatchObject({ code: 'ESSRF' });
    await expect(refused).rejects.toThrow(/169\.254\.169\.254.*link-local/);
  });

  it('refuses the whole lookup when only one of several answers is blocked', async () => {
    const guard = new SsrfGuard({ resolve: scripted([PUBLIC, PRIVATE]) });

    await expect(lookupAll(guard, 'mixed.test')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('refuses when the blocked answer comes first too', async () => {
    const guard = new SsrfGuard({ resolve: scripted([PRIVATE, PUBLIC]) });

    await expect(lookupOne(guard, 'mixed.test')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it('checks again on every lookup, so a DNS rebind is caught', async () => {
    // The name is public for the first connection and private for the second.
    const resolver = scripted([PUBLIC], [PRIVATE]);
    const guard = new SsrfGuard({ resolve: resolver });

    await expect(lookupOne(guard, 'rebind.test')).resolves.toEqual({
      address: PUBLIC.address,
      family: 4,
    });
    await expect(lookupOne(guard, 'rebind.test')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(resolver.calls).toEqual(['rebind.test', 'rebind.test']);
  });

  it('returns exactly the address it checked, with its family', async () => {
    const v6: LookupAddress = { address: '2606:4700::1111', family: 6 };
    const guard = new SsrfGuard({ resolve: scripted([v6]) });

    await expect(lookupOne(guard, 'v6.test')).resolves.toEqual({
      address: '2606:4700::1111',
      family: 6,
    });
  });

  it('returns exactly the checked list, in order, when asked for all', async () => {
    const v6: LookupAddress = { address: '2606:4700::1111', family: 6 };
    const guard = new SsrfGuard({ resolve: scripted([v6, PUBLIC]) });

    await expect(lookupAll(guard, 'dual.test')).resolves.toEqual([v6, PUBLIC]);
  });

  it('passes a resolver failure through as it is', async () => {
    const failure = Object.assign(
      new Error('getaddrinfo ENOTFOUND gone.test'),
      {
        code: 'ENOTFOUND',
      },
    );
    const guard = new SsrfGuard({ resolve: () => Promise.reject(failure) });

    await expect(lookupOne(guard, 'gone.test')).rejects.toBe(failure);
  });

  it('fails a name that resolves to nothing instead of returning nothing', async () => {
    const guard = new SsrfGuard({ resolve: scripted([]) });

    await expect(lookupOne(guard, 'empty.test')).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
  });

  describe('allowHosts', () => {
    const LOOPBACK: LookupAddress = { address: '127.0.0.1', family: 4 };

    it('is off by default: the same host is blocked without it', async () => {
      const guard = new SsrfGuard({ resolve: scripted([LOOPBACK]) });

      await expect(lookupOne(guard, 'mock-receiver')).rejects.toBeInstanceOf(
        SsrfBlockedError,
      );
    });

    it('lets an allowlisted host through, still pinned to what it resolved to', async () => {
      const guard = new SsrfGuard({
        resolve: scripted([LOOPBACK]),
        allowHosts: ['mock-receiver'],
      });

      await expect(lookupOne(guard, 'mock-receiver')).resolves.toEqual({
        address: '127.0.0.1',
        family: 4,
      });
    });

    it('matches whole names without regard to case', async () => {
      const guard = new SsrfGuard({
        resolve: scripted([LOOPBACK]),
        allowHosts: ['Mock-Receiver'],
      });

      await expect(lookupOne(guard, 'MOCK-receiver')).resolves.toMatchObject({
        address: '127.0.0.1',
      });
    });

    it.each(['mock-receiver.evil.test', 'evil-mock-receiver', 'receiver'])(
      'does not extend to %s',
      async (hostname) => {
        const guard = new SsrfGuard({
          resolve: scripted([LOOPBACK]),
          allowHosts: ['mock-receiver'],
        });

        await expect(lookupOne(guard, hostname)).rejects.toBeInstanceOf(
          SsrfBlockedError,
        );
      },
    );
  });
});

describe('SsrfGuard.blockedHostReason', () => {
  const guard = new SsrfGuard({
    resolve: () =>
      Promise.reject(new Error('a literal host must not be resolved')),
  });

  it.each([
    ['127.0.0.1', /loopback/],
    ['169.254.169.254', /link-local/],
    ['10.1.2.3', /private network/],
    ['::1', /loopback/],
    ['fd00::1', /unique local/],
    ['::ffff:10.0.0.1', /private network/],
  ])('refuses the literal host %s', (hostname, reason) => {
    const refusal = guard.blockedHostReason(hostname);

    expect(refusal).toContain(hostname);
    expect(refusal).toMatch(reason);
  });

  it.each(['93.184.216.34', '2606:4700::1111', '::ffff:93.184.216.34'])(
    'lets the public literal host %s through',
    (hostname) => {
      expect(guard.blockedHostReason(hostname)).toBeUndefined();
    },
  );

  it.each(['example.com', 'mock-receiver', 'localhost', '10.example.com'])(
    'leaves the name %s to the lookup, which resolves it',
    (hostname) => {
      expect(guard.blockedHostReason(hostname)).toBeUndefined();
    },
  );

  it('lets an allowlisted literal host through', () => {
    const allowing = new SsrfGuard({ allowHosts: ['127.0.0.1'] });

    expect(allowing.blockedHostReason('127.0.0.1')).toBeUndefined();
    expect(allowing.blockedHostReason('127.0.0.2')).toMatch(/loopback/);
  });

  it('matches an allowlisted literal host without regard to case', () => {
    const allowing = new SsrfGuard({ allowHosts: ['fd00::ABCD'] });

    expect(allowing.blockedHostReason('FD00::abcd')).toBeUndefined();
  });
});
