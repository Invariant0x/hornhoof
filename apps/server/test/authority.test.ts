import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { webcrypto } from 'node:crypto';
import { once } from 'node:events';
import http2 from 'node:http2';
import type { Http2SecureServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import * as peculiar from '@peculiar/x509';
import { describe, expect, it } from 'vitest';
import {
  certFacts,
  issueCertificate,
  issuedBy,
  makeAuthority,
  makeCrl,
  needsRenewal,
} from '../src/modules/network/authority.js';
import type { MachineRole } from '../src/db/schema.js';
import type { Authority } from '../src/modules/network/authority.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date('2026-06-15T12:00:00.000Z');
const COMPANY = '0f0f0f0f-0000-4000-8000-00000000000a';
const MACHINE_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const MACHINE_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const MACHINE_C = 'cccccccc-0000-4000-8000-00000000000c';
const NAMES_NO_MACHINE = 'This certificate names no machine of a company.';

type Held = { keyPem: string; signKey: string; certPem: string; serial: string };

function machineKeys(): { keyPem: string; signKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { keyPem: privateKey, signKey: publicKey };
}

async function machine(authority: Authority, machineId: string, role: MachineRole, now?: Date): Promise<Held> {
  const keys = machineKeys();
  const issued = await issueCertificate(authority, { machineId, role, signKey: keys.signKey, now });
  return { ...keys, certPem: issued.certPem, serial: issued.serial };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function ed25519Keys(): Promise<webcrypto.CryptoKeyPair> {
  return crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as Promise<webcrypto.CryptoKeyPair>;
}

// Carries the authority's name and key id but is signed with another key, so only the signature tells it apart.
async function forgedUnder(authority: Authority): Promise<string> {
  const keys = await ed25519Keys();
  const real = new peculiar.X509Certificate(authority.certPem);
  const cert = await peculiar.X509CertificateGenerator.create({
    subject: `CN=${MACHINE_A}`,
    issuer: real.subjectName,
    publicKey: keys.publicKey,
    signingKey: keys.privateKey,
    signingAlgorithm: { name: 'Ed25519' },
    extensions: [new peculiar.AuthorityKeyIdentifierExtension(real.getExtension(peculiar.SubjectKeyIdentifierExtension)!.keyId)],
  });
  return cert.toString('pem');
}

// A certificate made by hand, for the names the authority itself would never write.
async function certificateNaming(uris: string[]): Promise<string> {
  const cert = await peculiar.X509CertificateGenerator.createSelfSigned({
    name: 'CN=test',
    keys: await ed25519Keys(),
    signingAlgorithm: { name: 'Ed25519' },
    extensions: uris.length > 0 ? [new peculiar.SubjectAlternativeNameExtension(uris.map((value) => ({ type: 'url' as const, value })))] : [],
  });
  return cert.toString('pem');
}

type PeerServer = { port: number; peers: string[]; accepted: () => number; refusal: Promise<unknown[]>; close: () => Promise<void> };

function servedPeers(server: Http2SecureServer): string[] {
  const peers: string[] = [];
  server.on('stream', (stream) => {
    const socket = stream.session?.socket as TLSSocket;
    peers.push(socket.getPeerCertificate().subjectaltname ?? '');
    stream.respond({ ':status': 200 });
    stream.end();
  });
  return peers;
}

// The server a keeper will run, by the plan's options, so the certificates are tried against what they must pass.
async function peerServer(authority: Authority, held: Held, crl?: string): Promise<PeerServer> {
  const server = http2.createSecureServer({
    key: held.keyPem,
    cert: held.certPem,
    ca: authority.certPem,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
    allowHTTP1: false,
    ...(crl ? { crl } : {}),
  });
  let accepted = 0;
  server.on('secureConnection', () => {
    accepted += 1;
  });
  const refusal = once(server, 'tlsClientError');
  refusal.catch(() => undefined);
  const peers = servedPeers(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    peers,
    accepted: () => accepted,
    refusal,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// In TLS 1.3 the client's side of the handshake ends before the server judges its certificate, so a refusal
// reaches the client as a session that closes with no answer.
function ask(port: number, authority: Authority, held: Held): Promise<'answered' | 'refused'> {
  return new Promise((resolve) => {
    let answered = false;
    const session = http2.connect(`https://127.0.0.1:${port}`, {
      ca: authority.certPem,
      key: held.keyPem,
      cert: held.certPem,
      checkServerIdentity: () => undefined,
    });
    session.on('error', () => undefined);
    session.on('close', () => resolve(answered ? 'answered' : 'refused'));
    const request = session.request({ ':path': '/' });
    request.on('response', () => {
      answered = true;
    });
    request.on('error', () => undefined);
    request.on('close', () => session.destroy());
    request.resume();
    request.end();
  });
}

describe('the authority', () => {
  it('makes an authority that signs only certificates', async () => {
    const authority = await makeAuthority(COMPANY, NOW);
    const cert = new X509Certificate(authority.certPem);
    expect(cert.subject).toBe(`CN=Hornhoof company ${COMPANY}`);
    expect(cert.issuer).toBe(`CN=Hornhoof company ${COMPANY}`);
    expect(cert.checkIssued(cert)).toBe(true);
    expect(cert.ca).toBe(true);
    expect(new Date(cert.validFrom).toISOString()).toBe('2026-06-15T11:55:00.000Z');
    expect(new Date(cert.validTo).toISOString()).toBe('2046-06-15T11:55:00.000Z');
    const key = createPrivateKey(authority.keyPem);
    expect(key.asymmetricKeyType).toBe('ed25519');
    expect(cert.verify(createPublicKey(key))).toBe(true);

    const read = new peculiar.X509Certificate(authority.certPem);
    const constraints = read.getExtension(peculiar.BasicConstraintsExtension);
    expect([constraints?.ca, constraints?.pathLength, constraints?.critical]).toEqual([true, 0, true]);
    const usages = read.getExtension(peculiar.KeyUsagesExtension);
    expect([usages?.usages, usages?.critical]).toEqual([peculiar.KeyUsageFlags.keyCertSign | peculiar.KeyUsageFlags.cRLSign, true]);
    expect(read.getExtension(peculiar.SubjectKeyIdentifierExtension)).not.toBeNull();
  });

  it('issues a machine certificate for a key and a role', async () => {
    const authority = await makeAuthority(COMPANY);
    const { signKey } = machineKeys();
    const issued = await issueCertificate(authority, { machineId: MACHINE_A, role: 'worker', signKey, now: new Date('2026-06-15T12:00:00.500Z') });
    const facts = certFacts(issued.certPem);
    expect(facts.machineId).toBe(MACHINE_A);
    expect(facts.role).toBe('worker');
    expect(facts.serial).toMatch(/^[1-7][0-9a-f]{31}$/);
    expect(facts.serial).toBe(issued.serial);
    expect(facts.notBefore.toISOString()).toBe('2026-06-15T11:55:00.000Z');
    expect(facts.notAfter.toISOString()).toBe('2026-07-15T12:00:00.000Z');
    expect(issued.until.toISOString()).toBe('2026-07-15T12:00:00.000Z');
    expect(facts.signKey).toBe(signKey);
    expect(issuedBy(authority.certPem, issued.certPem)).toBe(true);

    const second = await issueCertificate(authority, { machineId: MACHINE_A, role: 'data', signKey });
    expect(certFacts(second.certPem).role).toBe('data');
    expect(second.serial).not.toBe(issued.serial);
  });

  it('writes a machine certificate that cannot sign another', async () => {
    const authority = await makeAuthority(COMPANY);
    const { certPem } = await machine(authority, MACHINE_A, 'data');
    expect(new X509Certificate(certPem).subject).toBe(`CN=${MACHINE_A}`);
    expect(new X509Certificate(certPem).ca).toBe(false);

    const read = new peculiar.X509Certificate(certPem);
    const constraints = read.getExtension(peculiar.BasicConstraintsExtension);
    expect([constraints?.ca, constraints?.critical]).toEqual([false, true]);
    const usages = read.getExtension(peculiar.KeyUsagesExtension);
    expect([usages?.usages, usages?.critical]).toEqual([peculiar.KeyUsageFlags.digitalSignature, true]);
    expect(read.getExtension(peculiar.ExtendedKeyUsageExtension)?.usages).toEqual([peculiar.ExtendedKeyUsage.serverAuth, peculiar.ExtendedKeyUsage.clientAuth]);
    const authorityKeyId = new peculiar.X509Certificate(authority.certPem).getExtension(peculiar.SubjectKeyIdentifierExtension)?.keyId;
    expect(read.getExtension(peculiar.AuthorityKeyIdentifierExtension)?.keyId).toBe(authorityKeyId);
  });

  it('tells a certificate of another authority', async () => {
    // The same company's name on another key is what a restored database leaves behind, so the name must not be enough.
    const authority = await makeAuthority(COMPANY);
    const other = await makeAuthority(COMPANY);
    const { certPem } = await machine(other, MACHINE_A, 'data');
    expect(issuedBy(authority.certPem, certPem)).toBe(false);
    expect(issuedBy(other.certPem, certPem)).toBe(true);

    const forged = await forgedUnder(authority);
    expect(new X509Certificate(forged).checkIssued(new X509Certificate(authority.certPem))).toBe(true);
    expect(issuedBy(authority.certPem, forged)).toBe(false);
  });

  it('refuses a key that is not Ed25519', async () => {
    const authority = await makeAuthority(COMPANY);
    const ec = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    // Node derives a public key from a private one, so a private key handed in by mistake would pass as a machine's.
    const broken = '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n';
    for (const signKey of [ec.publicKey, machineKeys().keyPem, broken, 'not a key']) {
      await expect(issueCertificate(authority, { machineId: MACHINE_A, role: 'data', signKey })).rejects.toThrow('Not an Ed25519 public key.');
    }
  });

  it('reads no machine from a certificate that does not name one', async () => {
    const machineUri = `urn:hornhoof:machine:${MACHINE_A}`;
    const roleUri = 'urn:hornhoof:role:data';
    const unnamed = [
      [],
      [machineUri],
      [roleUri],
      ['urn:hornhoof:machine:not-a-uuid', roleUri],
      [machineUri, 'urn:hornhoof:role:root'],
      [machineUri, roleUri, 'urn:hornhoof:role:worker'],
      [machineUri, `urn:hornhoof:machine:${MACHINE_B}`, roleUri],
    ];
    for (const uris of unnamed) {
      const certPem = await certificateNaming(uris);
      expect(() => certFacts(certPem)).toThrow(NAMES_NO_MACHINE);
    }
    expect(certFacts(await certificateNaming([machineUri, roleUri])).machineId).toBe(MACHINE_A);
  });

  it('carries mutual TLS 1.3 between two machines', async () => {
    const authority = await makeAuthority(COMPANY);
    const server = await peerServer(authority, await machine(authority, MACHINE_A, 'data'));
    try {
      expect(await ask(server.port, authority, await machine(authority, MACHINE_B, 'worker'))).toBe('answered');
      expect(server.peers[0]).toContain(`urn:hornhoof:machine:${MACHINE_B}`);

      const other = await makeAuthority(COMPANY);
      expect(await ask(server.port, authority, await machine(other, MACHINE_C, 'data'))).toBe('refused');
      expect(server.peers).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('refuses an expired certificate at the handshake', async () => {
    const authority = await makeAuthority(COMPANY);
    const server = await peerServer(authority, await machine(authority, MACHINE_A, 'data'));
    try {
      const expired = await machine(authority, MACHINE_B, 'data', daysAgo(31));
      expect(await ask(server.port, authority, expired)).toBe('refused');
      await server.refusal;
      expect(server.accepted()).toBe(0);
      expect(issuedBy(authority.certPem, expired.certPem)).toBe(true);

      // A day short of the end it still answers, so the date is what refused the other, not the backdating.
      expect(await ask(server.port, authority, await machine(authority, MACHINE_C, 'data', daysAgo(29)))).toBe('answered');
    } finally {
      await server.close();
    }
  });

  it('refuses a revoked certificate at the handshake by its CRL', async () => {
    const authority = await makeAuthority(COMPANY);
    const own = await machine(authority, MACHINE_A, 'data');
    const revoked = await machine(authority, MACHINE_B, 'data');
    const crl = await makeCrl(authority, [revoked.serial]);

    const listing = await peerServer(authority, own, crl);
    try {
      expect(await ask(listing.port, authority, revoked)).toBe('refused');
      await listing.refusal;
      expect(listing.accepted()).toBe(0);
      expect(await ask(listing.port, authority, await machine(authority, MACHINE_C, 'data'))).toBe('answered');
    } finally {
      await listing.close();
    }

    const empty = await peerServer(authority, own, await makeCrl(authority, []));
    try {
      expect(await ask(empty.port, authority, revoked)).toBe('answered');
    } finally {
      await empty.close();
    }

    const entries = new peculiar.X509Crl(crl).entries.map((entry) => [entry.serialNumber.toLowerCase(), entry.reason]);
    expect(entries).toEqual([[revoked.serial, peculiar.X509CrlReason.cessationOfOperation]]);
  });

  it('dates its list a day back and a year ahead, under its own name', async () => {
    const authority = await makeAuthority(COMPANY, NOW);
    const read = new peculiar.X509Crl(await makeCrl(authority, [], NOW));
    expect(read.thisUpdate.toISOString()).toBe('2026-06-14T12:00:00.000Z');
    expect(read.nextUpdate?.toISOString()).toBe('2027-06-15T12:00:00.000Z');
    expect(read.issuer).toBe(`CN=Hornhoof company ${COMPANY}`);
  });

  it('asks for renewal after 7 days', async () => {
    const authority = await makeAuthority(COMPANY, NOW);
    const facts = certFacts((await machine(authority, MACHINE_A, 'data', NOW)).certPem);
    expect(needsRenewal(facts, new Date(NOW.getTime() + 6 * DAY_MS + 23 * HOUR_MS))).toBe(false);
    expect(needsRenewal(facts, new Date(NOW.getTime() + 7 * DAY_MS + HOUR_MS))).toBe(true);
  });
});
