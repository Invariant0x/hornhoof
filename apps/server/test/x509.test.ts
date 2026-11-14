import { X509Certificate, createPrivateKey, webcrypto } from 'node:crypto';
import tls, { createSecureContext } from 'node:tls';
import type { AddressInfo } from 'node:net';
import * as peculiar from '@peculiar/x509';
import { describe, expect, it } from 'vitest';
import { certInfo, selfSigned } from '../src/modules/tls/x509.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOST = 'acme.hornhoof.org';

function validityMs(cert: X509Certificate): number {
  return new Date(cert.validTo).getTime() - new Date(cert.validFrom).getTime();
}

// What a TLS server presents when it is given this certificate text, as the listener would load it.
async function servedAltName(certPem: string, keyPem: string): Promise<string | undefined> {
  const server = tls.createServer({ cert: certPem, key: keyPem }, (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      const client = tls.connect({ port, host: '127.0.0.1', servername: HOST, rejectUnauthorized: false }, () => {
        const altName = client.getPeerCertificate().subjectaltname;
        client.end();
        resolve(altName);
      });
      client.on('error', (error) => {
        client.destroy();
        reject(error);
      });
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// The content octets of the serial number INTEGER, read from the DER bytes of the certificate.
function serialContentHex(cert: X509Certificate): string {
  const der = cert.raw;
  const contentStart = (at: number): number => at + 2 + (der[at + 1]! & 0x80 ? der[at + 1]! & 0x7f : 0);
  const versionLength = 5; // a0 03 02 01 02: the explicit version field
  const serialAt = contentStart(contentStart(0)) + versionLength;
  return der.subarray(serialAt + 2, serialAt + 2 + der[serialAt + 1]!).toString('hex');
}

async function certificateWithSans(sans: peculiar.JsonGeneralName[]): Promise<string> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const extensions = sans.length > 0 ? [new peculiar.SubjectAlternativeNameExtension(sans)] : [];
  const cert = await peculiar.X509CertificateGenerator.createSelfSigned({
    name: 'CN=test',
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    extensions,
  });
  return cert.toString('pem') + '\n';
}

describe('stand-in certificate', () => {
  it('makes a stand-in certificate Node reads', async () => {
    const { certPem, keyPem } = await selfSigned(HOST);
    const cert = new X509Certificate(certPem);
    expect(cert.subjectAltName).toBe(`DNS:${HOST}`);
    expect(cert.checkPrivateKey(createPrivateKey(keyPem))).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(validityMs(cert)).toBe(30 * DAY_MS);
  });

  it('is named, signed and keyed as a stand-in', async () => {
    const { certPem, keyPem } = await selfSigned(HOST);
    const cert = new X509Certificate(certPem);
    expect(cert.subject).toBe('CN=Hornhoof stand-in');
    expect(cert.issuer).toBe('CN=Hornhoof stand-in');
    expect(cert.publicKey.asymmetricKeyType).toBe('ec');
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(keyPem.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true);
  });

  it('carries key identifiers made from its own key', async () => {
    const { certPem } = await selfSigned(HOST);
    const cert = new peculiar.X509Certificate(certPem);
    const expected = await peculiar.SubjectKeyIdentifierExtension.create(cert.publicKey);
    const subjectKeyId = cert.getExtension(peculiar.SubjectKeyIdentifierExtension);
    const authorityKeyId = cert.getExtension(peculiar.AuthorityKeyIdentifierExtension);
    expect(subjectKeyId?.keyId).toBe(expected.keyId);
    expect(authorityKeyId?.keyId).toBe(expected.keyId);
  });

  it('honours the number of days', async () => {
    const { certPem } = await selfSigned(HOST, { days: 2 });
    expect(validityMs(new X509Certificate(certPem))).toBe(2 * DAY_MS);
  });

  it('accepts zero days, a certificate that ends when it starts', async () => {
    const { certPem } = await selfSigned(HOST, { days: 0 });
    expect(validityMs(new X509Certificate(certPem))).toBe(0);
  });

  it('starts at the given time', async () => {
    const now = new Date('2026-01-02T03:04:05Z');
    const { certPem } = await selfSigned(HOST, { now });
    expect(new Date(new X509Certificate(certPem).validFrom).getTime()).toBe(now.getTime());
  });

  it.each(['89abcdef', '0089abcdef'])('keeps the serial %s a positive integer of content 0089abcdef', async (serial) => {
    const { certPem } = await selfSigned(HOST, { serial });
    const cert = new X509Certificate(certPem);
    expect(cert.serialNumber).toBe('89ABCDEF');
    expect(serialContentHex(cert)).toBe('0089abcdef');
  });

  it('serves as a TLS certificate', async () => {
    const { certPem, keyPem } = await selfSigned(HOST);
    expect(await servedAltName(certPem, keyPem)).toBe(`DNS:${HOST}`);
  });

  it('makes a new key each time', async () => {
    const first = await selfSigned(HOST);
    const second = await selfSigned(HOST);
    expect(first.keyPem !== second.keyPem, 'two stand-ins share a private key').toBe(true);
    expect(certInfo(first.certPem).fingerprint256).not.toBe(certInfo(second.certPem).fingerprint256);
  });

  it('ends its certificate and key with a newline so that texts join into a chain', async () => {
    const a = await selfSigned('a.hornhoof.org');
    const b = await selfSigned('b.hornhoof.org');
    expect(a.certPem.endsWith('\n')).toBe(true);
    expect(a.keyPem.endsWith('\n')).toBe(true);
    expect(() => createSecureContext({ cert: a.certPem + b.certPem, key: a.keyPem })).not.toThrow();
  });
});

describe('certInfo', () => {
  it('reads names, dates and the fingerprint', async () => {
    const { certPem } = await selfSigned(HOST);
    const node = new X509Certificate(certPem);
    const info = certInfo(certPem);
    expect(info.names).toEqual([HOST]);
    expect(info.notBefore.getTime()).toBe(new Date(node.validFrom).getTime());
    expect(info.notAfter.getTime()).toBe(new Date(node.validTo).getTime());
    expect(info.fingerprint256).toBe(node.fingerprint256);
  });

  it('reads the first certificate of a chain', async () => {
    const a = await selfSigned('a.hornhoof.org');
    const b = await selfSigned('b.hornhoof.org');
    expect(certInfo(a.certPem + b.certPem).names).toEqual(['a.hornhoof.org']);
  });

  it('gives no names for a certificate without a subject alternative name', async () => {
    expect(certInfo(await certificateWithSans([])).names).toEqual([]);
  });

  it('gives only the dNSNames of a mixed list, in order', async () => {
    const pem = await certificateWithSans([
      { type: 'dns', value: 'one.hornhoof.org' },
      { type: 'ip', value: '10.0.0.1' },
      { type: 'url', value: 'https://example.org/x' },
      { type: 'dns', value: 'two.hornhoof.org' },
    ]);
    expect(certInfo(pem).names).toEqual(['one.hornhoof.org', 'two.hornhoof.org']);
  });

  it('fails on text without a certificate', () => {
    expect(() => certInfo('not a certificate')).toThrow();
  });

  describe('agrees with what TLS loads from the same text', () => {
    it('refuses certificates glued together, which TLS refuses too', async () => {
      const a = await selfSigned('a.hornhoof.org');
      const b = await selfSigned('b.hornhoof.org');
      const glued = a.certPem.trimEnd() + b.certPem;
      expect(() => createSecureContext({ cert: glued, key: a.keyPem })).toThrow();
      expect(() => certInfo(glued)).toThrow();
    });

    it('reads the certificate TLS serves when text comes before it on a line', async () => {
      const a = await selfSigned('a.hornhoof.org');
      const b = await selfSigned('b.hornhoof.org');
      const text = 'x ' + b.certPem + '\n' + a.certPem;
      expect(await servedAltName(text, a.keyPem)).toBe('DNS:a.hornhoof.org');
      expect(certInfo(text).names).toEqual(['a.hornhoof.org']);
    });

    it('reads a certificate whose lines end in spaces, as TLS does', async () => {
      const a = await selfSigned('a.hornhoof.org');
      const padded = a.certPem.replace(/\n/g, '  \n');
      expect(await servedAltName(padded, a.keyPem)).toBe('DNS:a.hornhoof.org');
      expect(certInfo(padded).names).toEqual(['a.hornhoof.org']);
    });
  });
});
