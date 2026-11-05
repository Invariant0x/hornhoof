import { createPrivateKey, X509Certificate } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import { decryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { linkTls, publicLinks } from '../../db/schema.js';
import type { LinkView } from '../link/link.js';
import { certInfo } from './x509.js';

export type TlsRow = typeof linkTls.$inferSelect;
type TlsFields = Partial<Omit<TlsRow, 'companyId'>>;

/* A certificate this close to its end goes back to http while visitors can still reach the link, before it ends on them. */
const LEAST_LEFT_MS = 24 * 60 * 60 * 1000;

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

/* Whether this row may carry this link over https now: the manager chose https, for this very name, and what the
   listener would serve is a certificate of the link's host with time left and its own key. A certificate or a key that
   cannot be read throws, which linkMode takes as no. */
export function mayRunHttps(row: Pick<TlsRow, 'mode' | 'name' | 'certPem' | 'certKeyEnc'>, link: LinkView, secret: Buffer, now: Date): boolean {
  if (row.mode !== 'https' || row.name !== link.name || !row.certPem || !row.certKeyEnc) return false;
  const info = certInfo(row.certPem);
  if (!info.names.includes(new URL(link.url).hostname)) return false;
  if (info.notAfter.getTime() - now.getTime() <= LEAST_LEFT_MS) return false;
  return isKeyOf(row.certPem, decryptSecret(row.certKeyEnc, secret));
}

/* The mode the tunnel runs in. Anything unknown or missing about the certificate means http, which works through the
   relay's own TLS, while https on a bad certificate would take the link down. So ACME_DIRECTORY=off and a restart of the
   app are the way back whatever the row says. */
export async function linkMode(db: Db, config: Config): Promise<'http' | 'https'> {
  if (config.acmeDirectory === null) return 'http';
  try {
    const [link] = await db.select().from(publicLinks).limit(1);
    if (!link) return 'http';
    const row = await tlsOf(db, link.companyId);
    return row && mayRunHttps(row, link, config.secret, new Date()) ? 'https' : 'http';
  } catch {
    return 'http';
  }
}
