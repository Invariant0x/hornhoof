import { X509Certificate, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

// The library needs a crypto provider once per process; Node's own is enough.
x509.cryptoProvider.set(webcrypto);

const DAY_MS = 24 * 60 * 60 * 1000;
const STAND_IN_DAYS = 30;
const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

export type SelfSignedOptions = { days?: number; serial?: string; now?: Date };
export type CertInfo = { names: string[]; notBefore: Date; notAfter: Date; fingerprint256: string };

// The library's PEM text has no final newline, and two such texts joined into a chain do not load in TLS.
export function toPem(label: string, der: ArrayBuffer): string {
  return `${x509.PemConverter.encode(der, label)}\n`;
}

// Serves a link while it has no real certificate, so the TLS port can always complete a handshake.
export async function selfSigned(
  host: string,
  opts: SelfSignedOptions = {},
): Promise<{ certPem: string; keyPem: string }> {
  const notBefore = opts.now ?? new Date();
  const notAfter = new Date(notBefore.getTime() + (opts.days ?? STAND_IN_DAYS) * DAY_MS);
  const keys = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
  const publicKey = keys.publicKey;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: opts.serial,
    name: 'CN=Hornhoof stand-in',
    notBefore,
    notAfter,
    signingAlgorithm: SIGNING_ALGORITHM,
    keys: { publicKey, privateKey: keys.privateKey },
    extensions: [
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: host }]),
      await x509.SubjectKeyIdentifierExtension.create(publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(publicKey),
    ],
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return { certPem: toPem('CERTIFICATE', cert.rawData), keyPem: toPem('PRIVATE KEY', pkcs8) };
}

function dnsNames(cert: x509.X509Certificate): string[] {
  const san = cert.getExtension(x509.SubjectAlternativeNameExtension);
  return (san?.names.items ?? []).filter((name) => name.type === 'dns').map((name) => name.value);
}

// DNS names are the same in any case, and a CA may write them either way.
export function namesHost(info: Pick<CertInfo, 'names'>, host: string): boolean {
  return info.names.some((name) => name.toLowerCase() === host.toLowerCase());
}

// Node's reader is the one TLS uses, so it picks the certificate and the library then reads the same DER bytes.
export function certInfo(pem: string): CertInfo {
  const node = new X509Certificate(pem);
  return {
    names: dnsNames(new x509.X509Certificate(node.raw)),
    notBefore: new Date(node.validFrom),
    notAfter: new Date(node.validTo),
    fingerprint256: node.fingerprint256,
  };
}
