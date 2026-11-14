import { isIPv4, isIPv6 } from 'node:net';

/* Which addresses a browser on a node may open: public http and https only. A page that reaches inside the machine, its
   network or a cloud's metadata service could read what only the node may read, so every such address is refused, by
   name, by number and by what a name points to. */

export type Lookup = (host: string) => Promise<string[]>;
export type Vetted = { ok: true; addresses: string[] } | { ok: false; reason: string };

export const ONLY_WEB = 'only http and https addresses open';
const LOCAL_NAME = 'a local name';
const METADATA = 'a cloud metadata address';
const LOOPBACK = 'a loopback address';
const PRIVATE = 'a private network address';
const LINK_LOCAL = 'a link-local address';
const SHARED = 'a shared address of a provider (CGNAT)';
const MULTICAST = 'a multicast address';
const RESERVED = 'a reserved address';

const LOCAL_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.lan', '.home.arpa', '.intranet'];
const METADATA_NAMES = new Set(['metadata.google.internal', 'metadata.goog']);
const METADATA_IPS = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200', '192.0.0.192']);

/* Each range: its first address, its prefix length and why it is refused. The first that holds the address decides. */
const V4: [string, number, string][] = [
  ['0.0.0.0', 8, RESERVED],
  ['10.0.0.0', 8, PRIVATE],
  ['100.64.0.0', 10, SHARED],
  ['127.0.0.0', 8, LOOPBACK],
  ['169.254.0.0', 16, LINK_LOCAL],
  ['172.16.0.0', 12, PRIVATE],
  ['192.0.0.0', 24, RESERVED],
  ['192.0.2.0', 24, RESERVED],
  ['192.88.99.0', 24, RESERVED],
  ['192.168.0.0', 16, PRIVATE],
  ['198.18.0.0', 15, RESERVED],
  ['198.51.100.0', 24, RESERVED],
  ['203.0.113.0', 24, RESERVED],
  ['224.0.0.0', 4, MULTICAST],
  ['240.0.0.0', 4, RESERVED],
];

function v4Number(ip: string): number {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

function refusedV4(ip: string): string | null {
  if (METADATA_IPS.has(ip)) return METADATA;
  const n = v4Number(ip);
  for (const [first, bits, reason] of V4) {
    const size = 2 ** (32 - bits);
    const start = v4Number(first);
    if (n >= start && n < start + size) return reason;
  }
  return null;
}

/* An IPv6 address as one number, with an IPv4 address at its end written as two groups. */
function v6Number(ip: string): bigint {
  let text = ip;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const n = v4Number(tail[1]!);
    text = `${text.slice(0, -tail[1]!.length)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const before = head ? head.split(':') : [];
  const after = rest ? rest.split(':') : [];
  const groups = rest === undefined ? before : [...before, ...Array<string>(8 - before.length - after.length).fill('0'), ...after];
  return groups.reduce((n, group) => (n << 16n) | BigInt(parseInt(group, 16)), 0n);
}

const within = (n: bigint, first: bigint, bits: number): boolean => n >> BigInt(128 - bits) === first >> BigInt(128 - bits);
const embeddedV4 = (n: bigint): string => [24n, 16n, 8n, 0n].map(shift => String((n >> shift) & 0xffn)).join('.');

/* An IPv6 range that carries an IPv4 address in its last 32 bits, which then decides. */
const EMBEDDED = 'an IPv4 address inside';
/* Each IPv6 range as for V4. Of the rest only global unicast is public. */
const V6: [bigint, number, string][] = [
  [1n, 128, LOOPBACK],
  [v6Number('fd00:ec2::254'), 128, METADATA],
  [0xffffn << 32n, 96, EMBEDDED],
  [0x0064ff9bn << 96n, 96, EMBEDDED],
  [0x0064ff9b0001n << 80n, 48, PRIVATE],
  [0xfc00n << 112n, 7, PRIVATE],
  [0xfe80n << 112n, 10, LINK_LOCAL],
  [0xff00n << 112n, 8, MULTICAST],
  /* Ranges for protocols, documentation and 6to4. */
  [0x2001n << 112n, 23, RESERVED],
  [0x20010db8n << 96n, 32, RESERVED],
  [0x2002n << 112n, 16, RESERVED],
];
const GLOBAL_UNICAST: [bigint, number] = [0x2000n << 112n, 3];

function refusedV6(ip: string): string | null {
  if (ip.includes('%')) return LINK_LOCAL;
  const n = v6Number(ip);
  const range = V6.find(([first, bits]) => within(n, first, bits));
  if (range?.[2] === EMBEDDED) return refusedV4(embeddedV4(n));
  if (range) return range[2];
  return within(n, ...GLOBAL_UNICAST) ? null : RESERVED;
}

/* Why an IP address is refused, or null for a public one. */
export function refusedIp(ip: string): string | null {
  const bare = ip.replace(/^\[|\]$/g, '');
  if (isIPv4(bare)) return refusedV4(bare);
  if (isIPv6(bare.split('%')[0]!)) return refusedV6(bare);
  return RESERVED;
}

/* Why a host name is refused before anything looks it up, or null. A name of one label resolves through the machine's
   own search domains, so it is local too. */
export function refusedName(host: string): string | null {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (METADATA_NAMES.has(name)) return METADATA;
  if (!name || name === 'localhost' || !name.includes('.') || LOCAL_SUFFIXES.some(suffix => name.endsWith(suffix))) return LOCAL_NAME;
  return null;
}

const isIp = (host: string): boolean => isIPv4(host) || isIPv6(host.replace(/^\[|\]$/g, '').split('%')[0]!);

/* An address an agent asked for, as far as its text tells. */
export function checkAddress(text: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { ok: false, reason: 'not a valid address' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: ONLY_WEB };
  if (url.username || url.password) return { ok: false, reason: 'the address holds a user name or password' };
  const reason = isIp(url.hostname) ? refusedIp(url.hostname) : refusedName(url.hostname);
  return reason ? { ok: false, reason } : { ok: true, url };
}

/* A host is opened only when every address it has is public: a name that answers with one inside is refused whole. */
export async function vetHost(host: string, lookup: Lookup): Promise<Vetted> {
  if (isIp(host)) {
    const bare = host.replace(/^\[|\]$/g, '');
    const reason = refusedIp(bare);
    return reason ? { ok: false, reason } : { ok: true, addresses: [bare] };
  }
  const named = refusedName(host);
  if (named) return { ok: false, reason: named };
  const addresses = await lookup(host).catch(() => [] as string[]);
  if (!addresses.length) return { ok: false, reason: 'the name has no address' };
  for (const address of addresses) {
    const reason = refusedIp(address);
    if (reason) return { ok: false, reason };
  }
  return { ok: true, addresses };
}

