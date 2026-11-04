/* The bytes of a PROXY protocol v2 header, for the tests of the code that reads them from the network. */
const SIGNATURE = Buffer.from('0d0a0d0a000d0a515549540a', 'hex');

const PROXY_V2 = 0x21;
const TCP_OVER_IPV4 = 0x11;
const PORTS = Buffer.from([0xc7, 0x38, 0x20, 0xfb]); // 51000 and 8443

export type ProxyV2Fields = {
  /* The byte at 12: the version in the high nibble and the command in the low one. */
  versionAndCommand?: number;
  family?: number;
  addresses?: Buffer;
  /* What the bytes at 14 and 15 claim, when a test has them lie about what follows. */
  declaredLength?: number;
};

export function proxyV2(fields: ProxyV2Fields = {}): Buffer {
  const addresses = fields.addresses ?? Buffer.alloc(0);
  const fixed = Buffer.alloc(4);
  fixed[0] = fields.versionAndCommand ?? PROXY_V2;
  fixed[1] = fields.family ?? TCP_OVER_IPV4;
  fixed.writeUInt16BE(fields.declaredLength ?? addresses.length, 2);
  return Buffer.concat([SIGNATURE, fixed, addresses]);
}

export const ipv4Addresses = (source: string): Buffer =>
  Buffer.concat([Buffer.from(source.split('.').map(Number)), Buffer.from([127, 0, 0, 1]), PORTS]);

/* A PROXY header over IPv4 from this visitor to the listener. */
export const visitorHeader = (visitor: string): Buffer => proxyV2({ addresses: ipv4Addresses(visitor) });
