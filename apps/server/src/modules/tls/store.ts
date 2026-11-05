import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import { decryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { linkTls, publicLinks } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import type { LinkView } from '../link/link.js';
import { certInfo, namesHost } from './x509.js';

export type TlsRow = typeof linkTls.$inferSelect;
type TlsFields = Partial<Omit<TlsRow, 'companyId'>>;

/* A certificate this close to its end goes back to http while visitors can still reach the link, before it ends on them. */
export const LEAST_LEFT_MS = 24 * 60 * 60 * 1000;

export async function tlsOf(db: Db, companyId: string): Promise<TlsRow | null> {
  const [row] = await db.select().from(linkTls).where(eq(linkTls.companyId, companyId));
  return row ?? null;
}

/* Makes the row, or changes the fields named in one made before. */
export async function saveTls(db: Db, companyId: string, set: TlsFields & Pick<TlsRow, 'directory' | 'accountKeyEnc'>): Promise<void> {
  const fields = { ...set, updatedAt: new Date() };
  await db.insert(linkTls).values({ companyId, ...fields }).onConflictDoUpdate({ target: linkTls.companyId, set: fields });
}

/* Changes a row that exists. A change that finds none would lose what the manager just decided, so it throws. */
export async function updateTls(db: Db, companyId: string, set: TlsFields): Promise<void> {
  const changed = await db.update(linkTls).set({ ...set, updatedAt: new Date() }).where(eq(linkTls.companyId, companyId)).returning({ companyId: linkTls.companyId });
  if (changed.length === 0) throw new Error('The link has no certificate row to change.');
}

const isKeyOf = (certPem: string, keyPem: string) => new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem));

/* Whether the listener could serve this chain with this key. X509Certificate reads only a chain's first block, while
   createSecureContext, the listener's own call, reads them all and throws on a broken one. It takes a key of another
   algorithm without a word, so the key's own check stays. */
function listenerCanServe(certPem: string, keyPem: string): boolean {
  createSecureContext({ cert: certPem, key: keyPem });
  return isKeyOf(certPem, keyPem);
}

/* NaN compares false, so a date that cannot be read counts as no time left. */
const hasTimeLeft = (notAfter: Date, now: Date) => notAfter.getTime() - now.getTime() > LEAST_LEFT_MS;

/* Whether this row may carry this link over https now: the manager chose https, for this very name, and what the
   listener would serve is a certificate of the link's host with time left and its own key. A certificate or a key that
   cannot be read throws, which linkMode takes as no. */
export function mayRunHttps(row: Pick<TlsRow, 'mode' | 'name' | 'certPem' | 'certKeyEnc'>, link: LinkView, secret: Buffer, now: Date): boolean {
  if (row.mode !== 'https' || row.name !== link.name || !row.certPem || !row.certKeyEnc) return false;
  const info = certInfo(row.certPem);
  if (!namesHost(info, new URL(link.url).hostname)) return false;
  if (!hasTimeLeft(info.notAfter, now)) return false;
  return listenerCanServe(row.certPem, decryptSecret(row.certKeyEnc, secret));
}

/* The mode the tunnel runs in. Anything unknown or missing about the certificate means http, which works through the
   relay's own TLS, while https on a bad certificate would take the link down. So ACME_DIRECTORY=off and a restart of the
   app are the way back whatever the row says. A log, when the caller has one, says why an operator's link stays on http;
   loggable keeps no value the error was given, so no key reaches it. */
export async function linkMode(db: Db, config: Config, log?: FastifyBaseLogger): Promise<'http' | 'https'> {
  if (config.acmeDirectory === null) return 'http';
  try {
    const [link] = await db.select().from(publicLinks).limit(1);
    if (!link) return 'http';
    const row = await tlsOf(db, link.companyId);
    return row && mayRunHttps(row, link, config.secret, new Date()) ? 'https' : 'http';
  } catch (err) {
    log?.warn({ error: loggable(err) }, 'The link stays on http: its certificate could not be checked.');
    return 'http';
  }
}
