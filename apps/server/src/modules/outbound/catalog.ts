import { randomUUID } from 'node:crypto';
import { CatalogValue, UtcTime, type GateCode } from '@hornhoof/protocol';
import { and, desc, eq, gt, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { departments, outboundCatalogRevisions, outboundChannels } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import type { Tx } from '../tasks/engine.js';
import { digestOf, scanText, unsafeLink } from './checks.js';

/* The words, prices and links a message can be made of. Anyone with a say may propose a revision; only a person publishes
   one, and a revision is never changed: the next change is the next revision. What cannot be sent is refused at the door,
   so that nobody approves what the last look would turn away. */

type Row = typeof outboundCatalogRevisions.$inferSelect;

const noSuch = (what: string) => new ApiError(404, 'not_found', `There is no such ${what}.`, 'outbound_unknown');
const conflict = (message: string) => new ApiError(409, 'conflict', message, 'outbound_conflict');
const invalid = (message: string, reasonCodes: GateCode[] = []) => new ApiError(400, 'validation', message, 'outbound_invalid', { reasonCodes });

const wordsIn = (value: CatalogValue): string[] => {
  if ('text' in value) return [value.text];
  if ('name' in value) return [value.name];
  if (value.kind === 'template') return [...(value.subject === null ? [] : [value.subject]), ...value.parts.flatMap(part => (part.kind === 'text' ? [part.text] : []))];
  return value.kind === 'taxonomy' ? value.classes.map(c => c.description) : [];
};
const linkIn = (value: CatalogValue): string | null => (value.kind === 'link' ? value.url : value.kind === 'audience' ? value.destination : null);

/* What a revision carries that it may not, by the code that would refuse it at the last look. */
export function catalogReasons(value: CatalogValue): GateCode[] {
  const link = linkIn(value);
  return [...new Set([...wordsIn(value).flatMap(scanText), ...(link !== null && unsafeLink(link) ? (['link_unapproved'] as const) : [])])];
}

export const ProposalInput = z.strictObject({ departmentId: z.uuid(), productId: z.uuid().optional(), channelId: z.uuid().optional(), entryId: z.uuid().optional(), value: CatalogValue, validFrom: UtcTime.optional(), validUntil: UtcTime.optional() });
export type ProposalInput = z.infer<typeof ProposalInput>;
export type Proposal = ProposalInput & { companyId: string; author: { kind: 'person' | 'agent'; id: string } };

/* A price says when it holds; anything else holds from now, or from what its author said. */
function validityOf(p: Proposal, now: Date): { validFrom: Date; validUntil: Date | null } {
  const [from, until] = p.value.kind === 'price' ? [p.value.validFrom, p.value.validUntil] : [p.validFrom, p.validUntil];
  const validFrom = from ? new Date(from) : now;
  const validUntil = until ? new Date(until) : null;
  if (validUntil && validUntil <= validFrom) throw invalid('A revision has to end after it starts.');
  return { validFrom, validUntil };
}

type Place = Pick<Row, 'departmentId' | 'productId' | 'channelId'>;
const samePlace = (a: Place, b: Place): boolean => a.departmentId === b.departmentId && a.productId === b.productId && a.channelId === b.channelId;

/* A product named here is of this department and company. */
export async function requireProductOf(db: Pick<Db, 'select'>, at: { companyId: string; departmentId: string; productId?: string | undefined }): Promise<void> {
  if (!at.productId) return;
  const [product] = await db.select(idOnly(departments)).from(departments).where(and(eq(departments.id, at.productId), eq(departments.parentId, at.departmentId), eq(departments.companyId, at.companyId)));
  if (!product) throw noSuch('product');
}

/* Words for one channel are of its product too, as the channel itself is. */
async function placeOf(tx: Tx, p: Proposal): Promise<Place> {
  await requireProductOf(tx, p);
  if (!p.channelId) return { departmentId: p.departmentId, productId: p.productId ?? null, channelId: null };
  const [channel] = await tx.select({ productId: outboundChannels.productId }).from(outboundChannels).where(and(eq(outboundChannels.id, p.channelId), eq(outboundChannels.companyId, p.companyId), eq(outboundChannels.departmentId, p.departmentId)));
  if (!channel || (p.productId && channel.productId !== p.productId)) throw noSuch('channel');
  return { departmentId: p.departmentId, productId: channel.productId, channelId: p.channelId };
}

type Slot = { entryId: string; revision: number };

/* Where this revision goes: the next of its entry, which stays of one kind in one place, or the first of a new one. */
async function slotOf(tx: Tx, p: Proposal, place: Place): Promise<Slot> {
  if (!p.entryId) return { entryId: randomUUID(), revision: 1 };
  const [newest] = await tx.select().from(outboundCatalogRevisions).where(and(eq(outboundCatalogRevisions.companyId, p.companyId), eq(outboundCatalogRevisions.entryId, p.entryId))).orderBy(desc(outboundCatalogRevisions.revision)).limit(1);
  if (!newest) throw noSuch('catalog entry');
  if (newest.kind !== p.value.kind || !samePlace(newest, place)) throw conflict('An entry stays of one kind in one place. Propose a new entry for this.');
  return { entryId: p.entryId, revision: newest.revision + 1 };
}

export type Proposed = { id: string; entryId: string; revision: number; status: Row['status'] };
const proposedOf = (row: Row): Proposed => ({ id: row.id, entryId: row.entryId, revision: row.revision, status: row.status });

/* Takes a proposal, which no message may use until a person publishes it. */
export async function proposeRevision(ctx: Pick<Ctx, 'db'>, p: Proposal, now = new Date()): Promise<Proposed> {
  const reasonCodes = catalogReasons(p.value);
  if (reasonCodes.length) throw invalid('A message could not carry this.', reasonCodes);
  const validity = validityOf(p, now);
  return ctx.db.transaction(async tx => {
    const place = await placeOf(tx, p);
    const slot = await slotOf(tx, p, place);
    const locale = 'locale' in p.value ? p.value.locale : null;
    const [row] = await tx
      .insert(outboundCatalogRevisions)
      .values({ companyId: p.companyId, ...place, ...slot, ...validity, kind: p.value.kind, locale, value: p.value, digest: digestOf(p.value), createdByKind: p.author.kind, createdById: p.author.id })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict('Someone just proposed this revision. Read the entry and propose again.');
    return proposedOf(row);
  });
}

export async function catalogRow(db: Pick<Db, 'select'>, companyId: string, id: string): Promise<Row> {
  const [row] = await db.select().from(outboundCatalogRevisions).where(and(eq(outboundCatalogRevisions.id, id), eq(outboundCatalogRevisions.companyId, companyId)));
  if (!row) throw noSuch('catalog revision');
  return row;
}

/* The version a screen showed: its number, and the newest one of its entry then. A move by id alone, as a head's tool
   makes one, names its revision exactly and says nothing of the entry. */
export const ShownRevision = z.strictObject({ revision: z.number().int().positive().optional(), newest: z.number().int().positive().optional() });
export type ShownRevision = z.infer<typeof ShownRevision>;
type Moved = Pick<Row, 'id' | 'companyId' | 'entryId' | 'revision'>;

const changed = (move: string) => new ApiError(409, 'conflict', `This entry changed after you looked at it: it has another version now. Look at it again before you ${move}.`, 'outbound_changed');

/* A version of the entry newer than the newest one shown. */
const newerThanShown = (db: Pick<Db, 'select'>, row: Moved, newest: number) =>
  db.select({ one: sql`1` }).from(outboundCatalogRevisions).where(and(eq(outboundCatalogRevisions.companyId, row.companyId), eq(outboundCatalogRevisions.entryId, row.entryId), gt(outboundCatalogRevisions.revision, newest)));

/* In the same statement as the move, so that a version proposed meanwhile stops it. */
const asShown = (db: Pick<Db, 'select'>, row: Moved, shown: ShownRevision) => (shown.newest === undefined ? undefined : notExists(newerThanShown(db, row, shown.newest)));

async function refusal(db: Pick<Db, 'select'>, row: Moved, shown: ShownRevision, move: string, otherwise: ApiError): Promise<ApiError> {
  if (shown.newest === undefined) return otherwise;
  return (await newerThanShown(db, row, shown.newest)).length ? changed(move) : otherwise;
}

/* A person's yes to the revision they were shown. Once only: it goes as it was proposed or not at all. */
export async function publishRevision(db: Pick<Db, 'select' | 'update'>, row: Moved, personId: string, shown: ShownRevision = {}, now = new Date()): Promise<Proposed> {
  if (shown.revision !== undefined && shown.revision !== row.revision) throw changed('publish it');
  const [published] = await db.update(outboundCatalogRevisions).set({ status: 'published', publishedBy: personId, publishedAt: now }).where(and(eq(outboundCatalogRevisions.id, row.id), eq(outboundCatalogRevisions.status, 'proposed'), asShown(db, row, shown))).returning();
  if (!published) throw await refusal(db, row, shown, 'publish it', conflict('This revision is not waiting to be published.'));
  return proposedOf(published);
}

/* Takes back what was published, the version shown: what would use it stops at its last look. */
export async function revokeRevision(db: Pick<Db, 'select' | 'update'>, row: Moved, shown: ShownRevision = {}, now = new Date()): Promise<Proposed> {
  if (shown.revision !== undefined && shown.revision !== row.revision) throw changed('take it back');
  const [revoked] = await db.update(outboundCatalogRevisions).set({ status: 'revoked', revokedAt: now }).where(and(eq(outboundCatalogRevisions.id, row.id), eq(outboundCatalogRevisions.status, 'published'), asShown(db, row, shown))).returning();
  if (!revoked) throw await refusal(db, row, shown, 'take it back', conflict('Only a published revision can be taken back.'));
  return proposedOf(revoked);
}
