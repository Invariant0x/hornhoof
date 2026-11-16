import { createHash, X509Certificate } from 'node:crypto';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Person } from '../../auth/session.js';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { companies, recoveryKeys } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { tunnelSettings } from '../link/link.js';
import { authorityOf } from '../network/store.js';
import type { RecoveryLink } from './bundle.js';

/* The recovery file: the one key outside the company's machines that opens its backups. The CEO saves it once; the app
   makes the pair, answers the file and keeps only the public half. Whoever holds the file and a bundle holds the
   company's data, so the file says so in its first line. */
export const RECOVERY_KIND = 'hornhoof-recovery';

const FileShape = z.strictObject({
  v: z.literal(1),
  kind: z.literal(RECOVERY_KIND),
  company: z.uuid(),
  companyName: z.string().max(500),
  identity: z.string().regex(/^AGE-SECRET-KEY-1[0-9A-Z]+$/),
  recipient: z.string().regex(/^age1[0-9a-z]+$/),
  madeAt: z.iso.datetime(),
  link: z.strictObject({ url: z.string().min(1), name: z.string().min(1), key: z.string().min(1), tunnel: z.record(z.string(), z.unknown()) }).nullable(),
  authorityPem: z.string().min(1),
});
export type RecoveryFile = z.infer<typeof FileShape>;

const notAFile = () => new ApiError(400, 'validation', 'This is not a Hornhoof recovery file.', 'recovery_file_invalid');

/* What tells one link from another: its name and the key the relay gave for it. A recovery key is the company's own
   only while the link it was saved with is still the link. */
export function linkPrint(link: { name: string; key: string } | null): string | null {
  return link ? createHash('sha256').update(`${link.name}\n${link.key}`).digest('hex') : null;
}

/* The company's link as a recovery file keeps it: the one people open the company at. A hidden name, which Hornhoof
   took by itself for the company's machines, is none: making or dropping one changes nothing a file was saved with,
   and a new server takes a name of its own. */
async function fileLink(db: Db, config: Config) {
  const link = await tunnelSettings(db, config);
  return link && !link.hidden ? link : null;
}

export type ActiveRecovery = { id: string; recipient: string; madeAt: Date; madeBy: string; link: RecoveryLink | null };

/* The company's recovery key now: the newest one not retired, when the link it was saved with is the link now. With the
   link taken, renamed or removed since, there is none, and bundles are sealed without one until a new file is saved. */
export async function activeRecovery(db: Db, config: Config): Promise<ActiveRecovery | null> {
  const [newest] = await db.select().from(recoveryKeys).where(isNull(recoveryKeys.retiredAt)).orderBy(desc(recoveryKeys.madeAt), desc(recoveryKeys.id)).limit(1);
  if (!newest || newest.linkPrint !== linkPrint(await fileLink(db, config))) return null;
  const link = newest.linkName && newest.linkUrl ? { name: newest.linkName, url: newest.linkUrl } : null;
  return { id: newest.id, recipient: newest.recipient, madeAt: newest.madeAt, madeBy: newest.madeBy, link };
}

/* Whether a key that is not retired was saved with another link than the one now: a new file is due. */
export async function linkChanged(db: Db, config: Config): Promise<boolean> {
  const [newest] = await db.select(only(recoveryKeys, 'linkPrint')).from(recoveryKeys).where(isNull(recoveryKeys.retiredAt)).orderBy(desc(recoveryKeys.madeAt), desc(recoveryKeys.id)).limit(1);
  return Boolean(newest) && newest!.linkPrint !== linkPrint(await fileLink(db, config));
}

/* Makes a new pair and the file with its private half, which is answered once and kept nowhere: the row holds the
   public half and the link it was saved with, and every older key is retired. */
export async function makeRecoveryFile(db: Db, config: Config, me: Person): Promise<{ name: string; text: string }> {
  const authority = await authorityOf(db, config);
  if (!authority) throw new ApiError(409, 'conflict', 'The company has no certificate authority yet. Wait a minute and try again.', 'no_authority');
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  const link = await fileLink(db, config);
  const madeAt = new Date();
  const [company] = await db.select(only(companies, 'name')).from(companies).where(eq(companies.id, me.companyId));
  await db.transaction(async tx => {
    await tx.update(recoveryKeys).set({ retiredAt: madeAt }).where(and(eq(recoveryKeys.companyId, me.companyId), isNull(recoveryKeys.retiredAt)));
    await tx.insert(recoveryKeys).values({ companyId: me.companyId, recipient, linkPrint: linkPrint(link), linkName: link?.name ?? null, linkUrl: link?.url ?? null, madeBy: me.id, madeAt });
  });
  const file: RecoveryFile = {
    v: 1, kind: RECOVERY_KIND, company: me.companyId, companyName: company?.name ?? '', identity, recipient, madeAt: madeAt.toISOString(),
    link: link ? { url: link.url, name: link.name, key: link.key, tunnel: link.tunnel as Record<string, unknown> } : null,
    authorityPem: authority.certPem,
  };
  const comment = `# Hornhoof recovery file for ${(company?.name ?? '').replace(/\s+/g, ' ')}. It opens every backup made for it: keep it like a password.`;
  return { name: `hornhoof-recovery-${link?.name ?? me.companyId.slice(0, 8)}-${madeAt.toISOString().slice(0, 10)}.txt`, text: `${comment}\n${JSON.stringify(file)}\n` };
}

/* Reads a recovery file: the one line of JSON after any comment lines, with a private half that decodes whole and is the
   pair of its public half, and an authority's certificate. Anything else is not a recovery file; nothing of what was
   read is said back, and the age library's own words, which can quote a key, go nowhere. */
export async function parseRecoveryFile(text: string): Promise<RecoveryFile> {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  let file: RecoveryFile;
  try {
    if (lines.length !== 1) throw new Error('lines');
    file = FileShape.parse(JSON.parse(lines[0]!));
  } catch {
    throw notAFile();
  }
  const recipient = await identityToRecipient(file.identity).catch(() => null);
  if (recipient !== file.recipient) throw notAFile();
  try {
    if (!new X509Certificate(file.authorityPem).ca) throw new Error('no authority');
  } catch {
    throw notAFile();
  }
  return file;
}
