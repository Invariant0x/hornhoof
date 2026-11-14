/* The PROXY protocol v2 header the link's frpc sends first on each connection (haproxy's proxy-protocol.txt, 2.2). */
export type ProxyHeader = { state: 'more' } | { state: 'bad' } | { state: 'done'; length: number; source: string | null };

const SIGNATURE = Buffer.from('0d0a0d0a000d0a515549540a', 'hex');
const FIXED_LENGTH = 16;
const MAX_FOLLOWING = 512;
const V2_LOCAL = 0x20;
const V2_PROXY = 0x21;

const ipv4Source = (buf: Buffer): string => buf.subarray(FIXED_LENGTH, FIXED_LENGTH + 4).join('.');
const ipv6Source = (buf: Buffer): string =>
  Array.from({ length: 8 }, (_unused, i) => buf.readUInt16BE(FIXED_LENGTH + i * 2).toString(16)).join(':');

/* The TCP families: how long their two addresses and two ports are, and how to read the source among them. */
const TCP_FAMILIES = new Map([
  [0x11, { addressesLength: 12, source: ipv4Source }],
  [0x21, { addressesLength: 36, source: ipv6Source }],
]);

/* What a PROXY command's addresses say. Another family gives no source, and the socket's own address counts then; a TCP
   family too short for its addresses is a broken header. */
function fromAddresses(buf: Buffer, following: number): ProxyHeader {
  const length = FIXED_LENGTH + following;
  const family = TCP_FAMILIES.get(buf[13]!);
  if (!family) return { state: 'done', length, source: null };
  return following < family.addressesLength ? { state: 'bad' } : { state: 'done', length, source: family.source(buf) };
}

/* These bytes come from the network, so it never throws: a `bad` closes only that connection. */
export function readProxyV2(buf: Buffer): ProxyHeader {
  if (buf.length < FIXED_LENGTH) return { state: 'more' };
  const versionAndCommand = buf[12];
  if (!buf.subarray(0, SIGNATURE.length).equals(SIGNATURE)) return { state: 'bad' };
  if (versionAndCommand !== V2_LOCAL && versionAndCommand !== V2_PROXY) return { state: 'bad' };
  const following = buf.readUInt16BE(14);
  if (following > MAX_FOLLOWING) return { state: 'bad' };
  if (buf.length < FIXED_LENGTH + following) return { state: 'more' };
  /* A LOCAL header is the sender's own connection, and the protocol says to ignore its family and addresses. */
  return versionAndCommand === V2_LOCAL ? { state: 'done', length: FIXED_LENGTH + following, source: null } : fromAddresses(buf, following);
}
