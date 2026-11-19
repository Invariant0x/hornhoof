import { X509Certificate, createPrivateKey, createPublicKey, randomBytes, webcrypto } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import type { MachineRole } from '../../db/schema.js';
import { toPem } from '../tls/x509.js';
import { UUID } from '../../net/proxy.js';

const AUTHORITY_YEARS = 20;
export const CERT_DAYS = 30;
export const RENEW_AFTER_DAYS = 7;
const SKEW_MS = 5 * 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const CRL_BACK_DAYS = 1;
const CRL_AHEAD_DAYS = 365;
const SERIAL_BYTES = 16;
const ED25519 = { name: 'Ed25519' } as const;
const MACHINE_URN = 'URI:urn:hornhoof:machine:';
const ROLE_URN = 'URI:urn:hornhoof:role:';
const SPKI_PEM = /^\s*-----BEGIN PUBLIC KEY-----/;
const NOT_ED25519 = 'Not an Ed25519 public key.';
const NAMES_NO_MACHINE = 'This certificate names no machine of a company.';

export type Authority = { certPem: string; keyPem: string };
export type Issued = { certPem: string; serial: string; until: Date };
type IssueRequest = { machineId: string; role: MachineRole; signKey: string; now?: Date };
type CertFacts = { machineId: string; role: MachineRole; serial: string; notBefore: Date; notAfter: Date; signKey: string };

function yearsLater(from: Date, years: number): Date {
  const later = new Date(from);
  later.setUTCFullYear(later.getUTCFullYear() + years);
  return later;
}

// A name given as data, not as text to parse, so nothing in an id can open another attribute.
function commonName(value: string): x509.JsonName {
  return [{ CN: [value] }];
}

async function authorityExtensions(publicKey: webcrypto.CryptoKey): Promise<x509.Extension[]> {
  return [
    new x509.BasicConstraintsExtension(true, 0, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    await x509.SubjectKeyIdentifierExtension.create(publicKey),
  ];
}

export async function makeAuthority(companyId: string, now: Date = new Date()): Promise<Authority> {
  const notBefore = new Date(now.getTime() - SKEW_MS);
  const keys = (await webcrypto.subtle.generateKey(ED25519, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: commonName(`Hornhoof company ${companyId}`),
    notBefore,
    notAfter: yearsLater(notBefore, AUTHORITY_YEARS),
    signingAlgorithm: ED25519,
    keys,
    extensions: await authorityExtensions(keys.publicKey),
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return { certPem: toPem('CERTIFICATE', cert.rawData), keyPem: toPem('PRIVATE KEY', pkcs8) };
}

// Node's createPublicKey also takes a private key or a certificate and derives the public key, so the label decides first.
export function readEd25519PublicKey(signKey: string): KeyObject | null {
  try {
    if (!SPKI_PEM.test(signKey)) return null;
    const key = createPublicKey(signKey);
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function ed25519PublicKey(signKey: string): webcrypto.CryptoKey {
  const key = readEd25519PublicKey(signKey);
  if (!key) throw new Error(NOT_ED25519);
  return key.toCryptoKey(ED25519, true, ['verify']);
}

function signingKeyOf(authority: Authority): webcrypto.CryptoKey {
  return createPrivateKey(authority.keyPem).toCryptoKey(ED25519, false, ['sign']);
}

// The first byte stays in 0x10..0x7f: no sign byte and no leading zero, so the text is always 32 hex digits,
// and a CRL, which writes a serial's bytes as they are, names the same integer as the certificate.
function randomSerial(): string {
  const bytes = randomBytes(SERIAL_BYTES);
  bytes[0] = 0x10 + (bytes[0]! % 0x70);
  return bytes.toString('hex');
}

async function machineExtensions(authorityCert: x509.X509Certificate, req: IssueRequest): Promise<x509.Extension[]> {
  return [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth, x509.ExtendedKeyUsage.clientAuth]),
    await x509.AuthorityKeyIdentifierExtension.create(authorityCert),
    new x509.SubjectAlternativeNameExtension([
      { type: 'url', value: `urn:hornhoof:machine:${req.machineId}` },
      { type: 'url', value: `urn:hornhoof:role:${req.role}` },
    ]),
  ];
}

export async function issueCertificate(authority: Authority, req: IssueRequest): Promise<Issued> {
  const now = req.now ?? new Date();
  const authorityCert = new x509.X509Certificate(authority.certPem);
  const serial = randomSerial();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial,
    subject: commonName(req.machineId),
    issuer: authorityCert.subjectName,
    notBefore: new Date(now.getTime() - SKEW_MS),
    notAfter: new Date(now.getTime() + CERT_DAYS * DAY_MS),
    publicKey: ed25519PublicKey(req.signKey),
    signingKey: signingKeyOf(authority),
    signingAlgorithm: ED25519,
    extensions: await machineExtensions(authorityCert, req),
  });
  // The certificate keeps whole seconds, and the date it holds is the one everyone else will read.
  return { certPem: toPem('CERTIFICATE', cert.rawData), serial, until: cert.notAfter };
}

function isRole(value: string | undefined): value is MachineRole {
  return value === 'data' || value === 'worker';
}

function onlyValue(names: string[], prefix: string): string | undefined {
  const found = names.filter((name) => name.startsWith(prefix));
  return found.length === 1 ? found[0]!.slice(prefix.length) : undefined;
}

function namedMachine(subjectAltName: string | undefined): { machineId: string; role: MachineRole } {
  const names = (subjectAltName ?? '').split(', ');
  const machineId = onlyValue(names, MACHINE_URN);
  const role = onlyValue(names, ROLE_URN);
  if (machineId === undefined || !UUID.test(machineId) || !isRole(role)) throw new Error(NAMES_NO_MACHINE);
  return { machineId, role };
}

export function certFacts(certPem: string): CertFacts {
  const cert = new X509Certificate(certPem);
  return {
    ...namedMachine(cert.subjectAltName),
    serial: cert.serialNumber.toLowerCase(),
    notBefore: new Date(cert.validFrom),
    notAfter: new Date(cert.validTo),
    signKey: cert.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

export function issuedBy(authorityPem: string, certPem: string): boolean {
  const authority = new X509Certificate(authorityPem);
  const cert = new X509Certificate(certPem);
  return cert.checkIssued(authority) && cert.verify(authority.publicKey);
}

export function needsRenewal(facts: CertFacts, now: Date): boolean {
  return now.getTime() - (facts.notBefore.getTime() + SKEW_MS) > RENEW_AFTER_DAYS * DAY_MS;
}

export async function makeCrl(authority: Authority, serials: string[], now: Date = new Date()): Promise<string> {
  const thisUpdate = new Date(now.getTime() - CRL_BACK_DAYS * DAY_MS);
  const crl = await x509.X509CrlGenerator.create({
    issuer: new x509.X509Certificate(authority.certPem).subjectName,
    thisUpdate,
    nextUpdate: new Date(now.getTime() + CRL_AHEAD_DAYS * DAY_MS),
    // With no reason the library writes an empty extension list on the entry, which X.509's grammar does not allow.
    entries: serials.map((serialNumber) => ({
      serialNumber,
      revocationDate: thisUpdate,
      reason: x509.X509CrlReason.cessationOfOperation,
    })),
    signingAlgorithm: ED25519,
    signingKey: signingKeyOf(authority),
  });
  // OpenSSL reads only this label; the library's own PEM text says CRL.
  return toPem('X509 CRL', crl.rawData);
}
