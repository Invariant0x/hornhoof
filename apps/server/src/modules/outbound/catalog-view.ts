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

const nameOf = (rows: readonly Named[], id: string | null): Named | null => rows.find(row => row.id === id) ?? null;

async function namesFor(db: Pick<Db, 'select'>, rows: readonly Row[]) {
  const personIds = [...new Set(rows.flatMap(r => [r.createdByKind === 'person' ? r.createdById : null, r.publishedBy].filter((id): id is string => id !== null)))];
  const agentIds = [...new Set(rows.filter(r => r.createdByKind === 'agent').map(r => r.createdById))];
  const channelIds = [...new Set(rows.map(r => r.channelId).filter((id): id is string => id !== null))];
  const [persons, workers, channels] = await Promise.all([
    personIds.length ? db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, personIds)) : [],
    agentIds.length ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [],
    channelIds.length ? db.select({ id: outboundChannels.id, name: outboundChannels.name }).from(outboundChannels).where(inArray(outboundChannels.id, channelIds)) : [],
  ]);
  return { persons, workers, channels };
}

export async function catalogOf(db: Pick<Db, 'select'>, companyId: string, departmentId: string) {
  const rows = await db.select().from(outboundCatalogRevisions).where(and(eq(outboundCatalogRevisions.companyId, companyId), eq(outboundCatalogRevisions.departmentId, departmentId)));
  const [{ persons, workers, channels }, via] = await Promise.all([namesFor(db, rows), publishersOf(db, companyId, rows.filter(r => r.publishedBy !== null).map(r => r.id))]);
  const revisionOf = (row: Row) => ({
    id: row.id, revision: row.revision, status: row.status, value: row.value, summary: summarizeCatalogValue(row.value),
    validFrom: row.validFrom.toISOString(), validUntil: row.validUntil?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
    createdBy: { kind: row.createdByKind, id: row.createdById, name: nameOf(row.createdByKind === 'person' ? persons : workers, row.createdById)?.name ?? null },
    publishedBy: nameOf(persons, row.publishedBy), publishedVia: via.get(row.id) ?? null,
    publishedAt: row.publishedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null,
  });
  const entries = new Map<string, Row[]>();
  for (const row of rows) entries.set(row.entryId, [...(entries.get(row.entryId) ?? []), row]);
  return [...entries.values()]
    .map(revisions => revisions.sort((a, b) => b.revision - a.revision))
    .sort((a, b) => b[0]!.createdAt.getTime() - a[0]!.createdAt.getTime() || a[0]!.entryId.localeCompare(b[0]!.entryId))
    .map(revisions => {
      const newest = revisions[0]!;
      return {
        entryId: newest.entryId, kind: newest.kind, locale: newest.locale, productId: newest.productId, channel: nameOf(channels, newest.channelId),
        current: currentRevision(revisions)?.revision ?? null, revisions: revisions.map(revisionOf),
      };
    });
}
