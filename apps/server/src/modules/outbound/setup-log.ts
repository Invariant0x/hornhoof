import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agents, outboundChannels, outboundSetupEvents, people, type OutboundSetupKind } from '../../db/schema.js';

/* What was set up for a department's messages and by whom, for its owner to read: the person whose word it was, and the
   head or the orchestrator that carried it out. Ids and numbers only, never a setting, an address or a secret. */

type Detail = Record<string, string | number | boolean | null>;
export type SetupEntry = { companyId: string; departmentId: string; channelId: string | null; kind: OutboundSetupKind; subjectId?: string | null; detail?: Detail };

const SHOWN = 200;

export async function logSetup(db: Pick<Db, 'insert'>, me: Person, entry: SetupEntry): Promise<void> {
  await db.insert(outboundSetupEvents).values({ ...entry, subjectId: entry.subjectId ?? null, detail: entry.detail ?? {}, personId: me.id, agentId: me.via ?? null });
}

/* Whether a policy turns sending without a person's yes on or off, against the one before it. */
export const autoSendKind = (before: boolean, after: boolean): OutboundSetupKind => (before === after ? 'policy_set' : after ? 'auto_send_on' : 'auto_send_off');

const named = (rows: readonly { id: string; name: string }[], id: string | null) => {
  const found = id === null ? undefined : rows.find(row => row.id === id);
  return found ? { id: found.id, name: found.name } : null;
};

/* The newest entries of a department, newest first, with the names of who did them. */
export async function setupLogOf(db: Pick<Db, 'select'>, companyId: string, departmentId: string) {
  const rows = await db.select().from(outboundSetupEvents).where(and(eq(outboundSetupEvents.companyId, companyId), eq(outboundSetupEvents.departmentId, departmentId))).orderBy(desc(outboundSetupEvents.createdAt)).limit(SHOWN);
  const ids = (pick: (row: (typeof rows)[number]) => string | null) => [...new Set(rows.map(pick).filter((id): id is string => id !== null))];
  const [persons, workers, channels] = await Promise.all([
    rows.length ? db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, ids(r => r.personId))) : [],
    ids(r => r.agentId).length ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids(r => r.agentId))) : [],
    ids(r => r.channelId).length ? db.select({ id: outboundChannels.id, name: outboundChannels.name }).from(outboundChannels).where(inArray(outboundChannels.id, ids(r => r.channelId))) : [],
  ]);
  return rows.map(row => ({
    id: row.id, kind: row.kind, channel: named(channels, row.channelId), subjectId: row.subjectId, detail: row.detail,
    person: named(persons, row.personId), agent: named(workers, row.agentId), at: row.createdAt.toISOString(),
  }));
}

type Named = { id: string; name: string } | null;

/* Who added each of these permissions, as the setup log has it: the person whose word it was, and the agent that carried
   it out, where one did. A permission from before the log kept this has none. */
export async function addersOf(db: Pick<Db, 'select'>, companyId: string, permissionIds: readonly string[]): Promise<Map<string, { person: Named; agent: Named }>> {
  if (!permissionIds.length) return new Map();
  const rows = await db
    .select({ subjectId: outboundSetupEvents.subjectId, personId: people.id, personName: people.name, agentId: agents.id, agentName: agents.name })
    .from(outboundSetupEvents)
    .innerJoin(people, eq(people.id, outboundSetupEvents.personId))
    .leftJoin(agents, eq(agents.id, outboundSetupEvents.agentId))
    .where(and(eq(outboundSetupEvents.companyId, companyId), eq(outboundSetupEvents.kind, 'contact_added'), inArray(outboundSetupEvents.subjectId, [...permissionIds])));
  return new Map(rows.map(row => [row.subjectId!, { person: { id: row.personId, name: row.personName }, agent: row.agentId ? { id: row.agentId, name: row.agentName! } : null }]));
}

/* Who carried out the publishing of each of these revisions for a person, where an agent did. */
export async function publishersOf(db: Pick<Db, 'select'>, companyId: string, revisionIds: readonly string[]): Promise<Map<string, { id: string; name: string }>> {
  if (!revisionIds.length) return new Map();
  const rows = await db
    .select({ subjectId: outboundSetupEvents.subjectId, id: agents.id, name: agents.name })
    .from(outboundSetupEvents)
    .innerJoin(agents, eq(agents.id, outboundSetupEvents.agentId))
    .where(and(eq(outboundSetupEvents.companyId, companyId), eq(outboundSetupEvents.kind, 'catalog_published'), inArray(outboundSetupEvents.subjectId, [...revisionIds])));
  return new Map(rows.map(row => [row.subjectId!, { id: row.id, name: row.name }]));
}
