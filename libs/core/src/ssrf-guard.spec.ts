import { describe, expect, it } from 'vitest';
import { isBlockedAddress } from './ssrf-guard.js';

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
