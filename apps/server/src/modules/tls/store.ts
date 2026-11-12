import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import { decryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { hasCode } from '../../db/errors.js';
import { linkTls, publicLinks } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import type { LinkView } from '../link/link.js';
import { certInfo, namesHost } from './x509.js';

export type TlsRow = typeof linkTls.$inferSelect;
type TlsFields = Partial<Omit<TlsRow, 'companyId'>>;

/* A certificate this close to its end goes back to http while visitors can still reach the link, before it ends on them. */
const LEAST_LEFT_MS = 24 * 60 * 60 * 1000;

/* The keeper starts before an update migrates the database, and one from before the link had a certificate has no table
   for it (42P01): the link then has none, which keeps it on http and the maintenance answer up meanwhile. */
export async function tlsOf(db: Db, companyId: string): Promise<TlsRow | null> {
  try {
    const [row] = await db.select().from(linkTls).where(eq(linkTls.companyId, companyId));
    return row ?? null;
  } catch (err) {
    if (hasCode(err, '42P01')) return null;
    throw err;
  }
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

const STAYS_ON_HTTP = 'The link stays on http: its certificate could not be checked.';

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

/* Certificate data that cannot be read counts as a no, which is no failure of the database. A log, when the caller has
   one, says why an operator's link stays on http; loggable keeps no value the error was given, so no key reaches it. */
function passes(row: TlsRow, link: LinkView, secret: Buffer, log?: FastifyBaseLogger): boolean {
  try {
    return mayRunHttps(row, link, secret, new Date());
  } catch (err) {
    log?.warn({ error: loggable(err) }, STAYS_ON_HTTP);
    return false;
  }
}

/* The mode the tunnel runs in. Anything unknown or missing about the certificate means http, which works through the
   relay's own TLS, while https on a bad certificate would take the link down. So ACME_DIRECTORY=off and a restart of the
   app are the way back whatever the row says. A failed read of the database throws, so a reader that keeps what it runs
   does not take it for a change. */
export async function readLinkMode(db: Db, config: Config, log?: FastifyBaseLogger): Promise<'http' | 'https'> {
  if (config.acmeDirectory === null) return 'http';
  const [link] = await db.select().from(publicLinks).limit(1);
  /* A hidden name has no certificate of its own: what goes through it rides the relay's TLS. */
  if (!link || link.hidden) return 'http';
  const row = await tlsOf(db, link.companyId);
  return row && passes(row, link, config.secret, log) ? 'https' : 'http';
}

export function linkMode(db: Db, config: Config, log?: FastifyBaseLogger): Promise<'http' | 'https'> {
  return readLinkMode(db, config, log).catch((err: unknown) => {
    log?.warn({ error: loggable(err) }, STAYS_ON_HTTP);
    return 'http' as const;
  });
}

function certificateIn(row: TlsRow | null, name: string, secret: Buffer): { certPem: string; keyPem: string } | null {
  if (row?.name !== name || !row.certPem || !row.certKeyEnc) return null;
  return { certPem: row.certPem, keyPem: decryptSecret(row.certKeyEnc, secret) };
}

/* What the link's TLS listener is to serve: null without a link, and the link's host with the certificate of its own
   name once there is one. With certificates off there is none, as the manager also tells the listener. */
export async function servedCertificate(db: Db, config: Config): Promise<{ host: string; cert: { certPem: string; keyPem: string } | null } | null> {
  const [link] = await db.select().from(publicLinks).limit(1);
  if (!link) return null;
  const row = config.acmeDirectory === null ? null : await tlsOf(db, link.companyId);
  return { host: new URL(link.url).hostname, cert: certificateIn(row, link.name, config.secret) };
}
