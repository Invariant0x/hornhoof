import { describe, expect, it } from 'vitest';
import { checkAddress, refusedIp, refusedName, vetHost } from '../src/web-page/address.js';

describe('the addresses hh-browse opens', () => {
  it.each([
    'https://example.org/',
    'http://example.org:8080/catalogue?page=2#top',
    'https://shop.example.com./spring',
    'https://93.184.215.14/',
    'https://[2606:4700:4700::1111]/',
  ])('opens %s', text => {
    expect(checkAddress(text)).toMatchObject({ ok: true });
  });

  it.each([
    ['file:///etc/passwd', /only http and https/],
    ['data:text/html,<p>hi</p>', /only http and https/],
    ['ftp://example.org/file', /only http and https/],
    ['javascript:alert(1)', /only http and https/],
    ['https://user:secret@example.org/', /user name or password/],
    ['not an address', /not a valid address/],
    ['http://localhost:8080/', /local name/],
    ['http://app.localhost/', /local name/],
    ['http://intranet/', /local name/],
    ['http://printer.local/', /local name/],
    ['http://db.internal/', /local name/],
    ['http://metadata.google.internal/computeMetadata/v1/', /cloud metadata/],
    ['http://127.0.0.1/', /loopback/],
    ['http://127.1/', /loopback/],
    ['http://0x7f000001/', /loopback/],
    ['http://2130706433/', /loopback/],
    ['http://[::1]/', /loopback/],
    ['http://[::ffff:127.0.0.1]/', /loopback/],
    ['http://0.0.0.0/', /reserved/],
    ['http://10.1.2.3/', /private/],
    ['http://172.20.0.5/', /private/],
    ['http://192.168.1.1/', /private/],
    ['http://[fd12:3456::1]/', /private/],
    ['http://169.254.10.20/', /link-local/],
    ['http://[fe80::1]/', /link-local/],
    ['http://100.64.0.1/', /CGNAT/],
    ['http://169.254.169.254/latest/meta-data/', /cloud metadata/],
    ['http://[fd00:ec2::254]/', /cloud metadata/],
    ['http://100.100.100.200/', /cloud metadata/],
    ['http://224.0.0.1/', /multicast/],
    ['http://[ff02::1]/', /multicast/],
    ['http://255.255.255.255/', /reserved/],
    ['http://[64:ff9b::a00:1]/', /private/],
  ])('refuses %s', (text, reason) => {
    const verdict = checkAddress(text);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.reason).toMatch(reason);
  });

  it('tells public addresses from every internal range, IPv4 inside IPv6 included', () => {
    for (const ip of ['8.8.8.8', '93.184.215.14', '2606:4700:4700::1111', '2a00:1450:4001:82a::200e', '64:ff9b::808:808', '::ffff:8.8.8.8']) expect(refusedIp(ip), ip).toBeNull();
    for (const ip of ['127.0.0.53', '::', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '2001:db8::1', '2002:7f00:1::1', 'fe80::1%eth0', '198.18.0.1', '192.0.2.1', '240.0.0.1', '100.127.255.255']) {
      expect(refusedIp(ip), ip).not.toBeNull();
    }
    expect(refusedName('Example.ORG.')).toBeNull();
    expect(refusedName('localhost.')).toMatch(/local name/);
  });

  it('refuses a name when any of its addresses is internal, and a name with no address', async () => {
    const lookup = async (host: string) => ({ 'shop.example': ['93.184.215.14'], 'mixed.example': ['93.184.215.14', '10.0.0.7'], 'inside.example': ['192.168.0.9'] })[host] ?? [];
    await expect(vetHost('shop.example', lookup)).resolves.toEqual({ ok: true, addresses: ['93.184.215.14'] });
    await expect(vetHost('mixed.example', lookup)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/private/) });
    await expect(vetHost('inside.example', lookup)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/private/) });
    await expect(vetHost('nowhere.example', lookup)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/no address/) });
    await expect(vetHost('[::1]', lookup)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/loopback/) });
    await expect(vetHost('localhost', async () => ['93.184.215.14'])).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/local name/) });
    await expect(vetHost('broken.example', async () => { throw new Error('ENOTFOUND'); })).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/no address/) });
  });
});
