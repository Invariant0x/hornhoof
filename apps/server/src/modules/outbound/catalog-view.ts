import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, outboundCatalogRevisions, outboundChannels, people } from '../../db/schema.js';
import { currentRevision } from './checks.js';
import { publishersOf } from './setup-log.js';
import { summarizeCatalogValue } from './views.js';

/* A department's catalog as the people who run it read it: each entry with every revision, proposed, published or taken
   back, who wrote and who published each, and which one a message may use now. Words only: nothing in it is a secret. */

type Row = typeof outboundCatalogRevisions.$inferSelect;
type Named = { id: string; name: string };
type Names = { persons: Named[]; workers: Named[]; channels: Named[]; via: Map<string, Named> };

const nameOf = (rows: readonly Named[], id: string | null): Named | null => rows.find(row => row.id === id) ?? null;
const present = (ids: readonly (string | null)[]): string[] => [...new Set(ids.filter((id): id is string => id !== null))];
const iso = (at: Date | null): string | null => at?.toISOString() ?? null;

async function namedIn(db: Pick<Db, 'select'>, table: typeof people | typeof agents | typeof outboundChannels, ids: string[]): Promise<Named[]> {
  return ids.length ? db.select({ id: table.id, name: table.name }).from(table).where(inArray(table.id, ids)) : [];
}

async function namesFor(db: Pick<Db, 'select'>, companyId: string, rows: readonly Row[]): Promise<Names> {
  const byPerson = rows.filter(r => r.createdByKind === 'person').map(r => r.createdById);
  const [persons, workers, channels, via] = await Promise.all([
    namedIn(db, people, present([...byPerson, ...rows.map(r => r.publishedBy)])),
    namedIn(db, agents, present(rows.filter(r => r.createdByKind === 'agent').map(r => r.createdById))),
    namedIn(db, outboundChannels, present(rows.map(r => r.channelId))),
    publishersOf(db, companyId, rows.filter(r => r.publishedBy !== null).map(r => r.id)),
  ]);
  return { persons, workers, channels, via };
}

function authorOf(row: Row, names: Names) {
  const among = row.createdByKind === 'person' ? names.persons : names.workers;
  return { kind: row.createdByKind, id: row.createdById, name: nameOf(among, row.createdById)?.name ?? null };
}

function revisionOf(row: Row, names: Names) {
  return {
    id: row.id, revision: row.revision, status: row.status, value: row.value, summary: summarizeCatalogValue(row.value),
    validFrom: row.validFrom.toISOString(), validUntil: iso(row.validUntil), createdAt: row.createdAt.toISOString(),
    createdBy: authorOf(row, names), publishedBy: nameOf(names.persons, row.publishedBy), publishedVia: names.via.get(row.id) ?? null,
    publishedAt: iso(row.publishedAt), revokedAt: iso(row.revokedAt),
  };
}

/* Each entry's revisions, newest first, and the entries with the newest change first. */
function entriesOf(rows: readonly Row[]): Row[][] {
  const entries = new Map<string, Row[]>();
  for (const row of rows) entries.set(row.entryId, [...(entries.get(row.entryId) ?? []), row]);
  const newestFirst = [...entries.values()].map(revisions => revisions.sort((a, b) => b.revision - a.revision));
  return newestFirst.sort((a, b) => b[0]!.createdAt.getTime() - a[0]!.createdAt.getTime() || a[0]!.entryId.localeCompare(b[0]!.entryId));
}

function entryOf(revisions: Row[], names: Names) {
  const newest = revisions[0]!;
  return {
    entryId: newest.entryId, kind: newest.kind, locale: newest.locale, productId: newest.productId, channel: nameOf(names.channels, newest.channelId),
    current: currentRevision(revisions)?.revision ?? null, revisions: revisions.map(row => revisionOf(row, names)),
  };
}

export async function catalogOf(db: Pick<Db, 'select'>, companyId: string, departmentId: string) {
  const rows = await db.select().from(outboundCatalogRevisions).where(and(eq(outboundCatalogRevisions.companyId, companyId), eq(outboundCatalogRevisions.departmentId, departmentId)));
  const names = await namesFor(db, companyId, rows);
  return entriesOf(rows).map(revisions => entryOf(revisions, names));
}
