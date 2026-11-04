import { describe, expect, it } from 'vitest';
import { readProxyV2 } from '../src/modules/tls/proxy-header.js';
import { ipv4Addresses, proxyV2, visitorHeader } from './proxy-v2.js';

const LOCAL_V2 = 0x20;
const TCP_OVER_IPV4 = 0x11;
const TCP_OVER_IPV6 = 0x21;

function ipv6Addresses(source: number[]): Buffer {
  const addresses = Buffer.alloc(36);
  source.forEach((group, i) => addresses.writeUInt16BE(group, i * 2));
  return addresses;
}

describe('readProxyV2', () => {
  it('reads an IPv4 visitor', () => {
    expect(readProxyV2(visitorHeader('203.0.113.7'))).toEqual({ state: 'done', length: 28, source: '203.0.113.7' });
  });

  it('counts the TLVs after the addresses in the length', () => {
    const header = proxyV2({ addresses: Buffer.concat([ipv4Addresses('203.0.113.7'), Buffer.alloc(7)]) });
    expect(readProxyV2(header)).toEqual({ state: 'done', length: 35, source: '203.0.113.7' });
  });

  it('leaves what follows the header out of the length', () => {
    const header = Buffer.concat([visitorHeader('203.0.113.7'), Buffer.from('a TLS hello')]);
    expect(readProxyV2(header)).toEqual({ state: 'done', length: 28, source: '203.0.113.7' });
  });

  it('reads an IPv6 visitor as eight lowercase groups without leading zeros or a shortening', () => {
    const header = proxyV2({ family: TCP_OVER_IPV6, addresses: ipv6Addresses([0x2001, 0x0db8, 0, 0, 0, 0, 0, 7]) });
    expect(readProxyV2(header)).toEqual({ state: 'done', length: 52, source: '2001:db8:0:0:0:0:0:7' });
  });

  it('gives no source for a LOCAL header, whatever family it names', () => {
    expect(readProxyV2(proxyV2({ versionAndCommand: LOCAL_V2, family: 0 }))).toEqual({ state: 'done', length: 16, source: null });
    const claimsAFamily = proxyV2({ versionAndCommand: LOCAL_V2, family: TCP_OVER_IPV4 });
    expect(readProxyV2(claimsAFamily)).toEqual({ state: 'done', length: 16, source: null });
  });

  it('gives no source for a family it has no address for', () => {
    expect(readProxyV2(proxyV2({ family: 0 }))).toEqual({ state: 'done', length: 16, source: null });
    const udp = proxyV2({ family: 0x12, addresses: ipv4Addresses('203.0.113.7') });
    expect(readProxyV2(udp)).toEqual({ state: 'done', length: 28, source: null });
  });

  it.each([
    ['nothing', Buffer.alloc(0)],
    ['the first 10 bytes', visitorHeader('203.0.113.7').subarray(0, 10)],
    ['20 bytes of an IPv4 header', visitorHeader('203.0.113.7').subarray(0, 20)],
    ['one byte short of an IPv6 header', proxyV2({ family: TCP_OVER_IPV6, addresses: ipv6Addresses([]) }).subarray(0, 51)],
  ])('asks for more after %s', (_what, bytes) => {
    expect(readProxyV2(bytes)).toEqual({ state: 'more' });
  });

  it('takes 512 bytes after the fixed part and refuses 513', () => {
    const at = (length: number) => proxyV2({ addresses: Buffer.alloc(length) });
    expect(readProxyV2(at(512))).toMatchObject({ state: 'done', length: 528 });
    expect(readProxyV2(at(513))).toEqual({ state: 'bad' });
  });

  const header = visitorHeader('203.0.113.7');
  const wrongSignature = Buffer.from(header);
  wrongSignature[3] = 0xff;

  it.each([
    ['a wrong signature', wrongSignature],
    ['words of plain http', Buffer.from('GET / HTTP/1.1\r\n')],
    ['version 1', proxyV2({ versionAndCommand: 0x11, addresses: ipv4Addresses('203.0.113.7') })],
    ['version 3', proxyV2({ versionAndCommand: 0x31, addresses: ipv4Addresses('203.0.113.7') })],
    ['command 2', proxyV2({ versionAndCommand: 0x22, addresses: ipv4Addresses('203.0.113.7') })],
    ['a length of 600, before all of it came', proxyV2({ declaredLength: 600 })],
  ])('refuses %s', (_what, bytes) => {
    expect(readProxyV2(bytes)).toEqual({ state: 'bad' });
  });

  it.each([
    ['IPv4', 0, TCP_OVER_IPV4],
    ['IPv4', 11, TCP_OVER_IPV4],
    ['IPv6', 0, TCP_OVER_IPV6],
    ['IPv6', 35, TCP_OVER_IPV6],
  ])('refuses %s with %i bytes of addresses', (_name, length, family) => {
    expect(readProxyV2(proxyV2({ family, addresses: Buffer.alloc(length) }))).toEqual({ state: 'bad' });
  });
});
