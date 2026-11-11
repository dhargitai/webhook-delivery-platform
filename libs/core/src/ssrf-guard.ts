import { BlockList, isIP } from 'node:net';

interface Category {
  /** What the developer is told, e.g. "link-local". */
  reason: string;
  /** CIDR ranges as `address/prefix`. */
  v4?: readonly string[];
  v6?: readonly string[];
}

/**
 * Where an outbound webhook must never go: loopback, private, link-local and
 * every other range that is not a public host. The reason names the category,
 * so a rejection can be explained.
 */
const CATEGORIES: readonly Category[] = [
  { reason: 'unspecified', v4: ['0.0.0.0/8'], v6: ['::/128'] },
  { reason: 'loopback', v4: ['127.0.0.0/8'], v6: ['::1/128'] },
  {
    reason: 'private network (RFC 1918)',
    v4: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  },
  { reason: 'carrier-grade NAT', v4: ['100.64.0.0/10'] },
  { reason: 'link-local', v4: ['169.254.0.0/16'], v6: ['fe80::/10'] },
  { reason: 'IETF protocol assignment', v4: ['192.0.0.0/24'] },
  {
    reason: 'documentation',
    v4: ['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24'],
    v6: ['2001:db8::/32'],
  },
  { reason: 'benchmarking', v4: ['198.18.0.0/15'] },
  { reason: 'multicast', v4: ['224.0.0.0/4'], v6: ['ff00::/8'] },
  { reason: 'reserved', v4: ['240.0.0.0/4'] },
  { reason: 'unique local (IPv6 private)', v6: ['fc00::/7'] },
];

const DENY_LIST = CATEGORIES.map(({ reason, v4 = [], v6 = [] }) => {
  const list = new BlockList();
  for (const cidr of v4) addSubnet(list, cidr, 'ipv4');
  for (const cidr of v6) addSubnet(list, cidr, 'ipv6');
  return { reason, list };
});

function addSubnet(list: BlockList, cidr: string, family: 'ipv4' | 'ipv6') {
  const [network = '', prefix = ''] = cidr.split('/');
  list.addSubnet(network, Number(prefix), family);
}

/**
 * Returns why a connection to this IP address must be refused, or `undefined`
 * when it is a public address. Throws a `TypeError` for anything that is not
 * an IP address: a caller bug must not read as "public".
 *
 * An IPv4 address wrapped in an IPv6 one (IPv4-mapped, NAT64, 6to4) is judged
 * by the IPv4 address inside, or `::ffff:10.0.0.1` would be a way around the
 * private ranges.
 */
export function isBlockedAddress(address: string): string | undefined {
  const family = isIP(address);
  if (family === 0) {
    throw new TypeError(`not an IP address: ${JSON.stringify(address)}`);
  }
  if (family === 4) return categoryOf(address, 'ipv4');

  const embedded = embeddedIpv4(address);
  if (embedded !== undefined) return categoryOf(embedded, 'ipv4');
  // Node matches the IPv4 ranges against IPv4-mapped IPv6 addresses too.
  return categoryOf(address, 'ipv6');
}

function categoryOf(
  address: string,
  family: 'ipv4' | 'ipv6',
): string | undefined {
  return DENY_LIST.find(({ list }) => list.check(address, family))?.reason;
}

/** The IPv4 address inside a NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`) address. */
function embeddedIpv4(address: string): string | undefined {
  const groups = expandIpv6(address);
  const [first = 0, second = 0] = groups;
  if (first === 0x64 && second === 0xff9b && groups.slice(2, 6).every(isZero)) {
    return dotted(groups[6], groups[7]);
  }
  if (first === 0x2002) return dotted(groups[1], groups[2]);
  return undefined;
}

function isZero(group: number): boolean {
  return group === 0;
}

function dotted(high = 0, low = 0): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** The eight 16-bit groups of a valid IPv6 address. */
function expandIpv6(address: string): number[] {
  let text = address;
  // A trailing dotted quad (`::ffff:1.2.3.4`) stands for the last two groups.
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad) {
    const [a = 0, b = 0, c = 0, d = 0] = quad.slice(1).map(Number);
    text =
      text.slice(0, quad.index) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const before = head === '' ? [] : head.split(':');
  if (tail === undefined) return before.map((group) => parseInt(group, 16));
  const after = tail === '' ? [] : tail.split(':');
  const fill = Array.from(
    { length: 8 - before.length - after.length },
    () => '0',
  );
  return [...before, ...fill, ...after].map((group) => parseInt(group, 16));
}
