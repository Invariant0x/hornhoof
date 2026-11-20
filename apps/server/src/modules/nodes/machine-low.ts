import type { DiskReport } from '@hornhoof/protocol';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, companies, machines, people } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { machineNodes, machineState } from '../testruns/load.js';

/* A machine whose node, short of disk space after cleaning up after itself, takes no new checks or builds. All of it is
   read from what the machine's nodes say now, so there is nothing to create or to close: the card is there while a node
   says it is low and goes once it has room again or is off the line. names: the names of the company's employees whose
   work the node keeps because it can't be restored, by the folder it keeps it in; a folder of no employee of the company
   has none. */
export type MachineLow = { id: string; hostname: string; owner: { id: string; name: string } | null; since: string; disk: DiskReport; names: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* The names of the company's employees among the folders a node keeps work in; a folder named otherwise is no employee's. */
async function keptNames(ctx: Pick<Ctx, 'db'>, companyId: string, disks: DiskReport[]): Promise<Map<string, string>> {
  const ids = [...new Set(disks.flatMap(disk => (disk.kept ?? []).map(k => k.agent)))].filter(id => UUID.test(id));
  if (!ids.length) return new Map();
  const rows = await ctx.db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, ids)));
  return new Map(rows.map(row => [row.id, row.name]));
}

/* The company's machines short of disk space, the longest short first. */
export async function machinesLow(ctx: Pick<Ctx, 'db' | 'hub'>, companyId: string): Promise<MachineLow[]> {
  const served = await machineNodes(ctx.db, companyId);
  const rows = await ctx.db
    .select({ id: machines.id, hostname: machines.hostname, ownerId: people.id, ownerName: people.name })
    .from(machines)
    .leftJoin(people, eq(people.id, machines.personId))
    .where(and(eq(machines.companyId, companyId), isNull(machines.revokedAt)));
  const cards = rows.flatMap(row => {
    const { online, load } = machineState(ctx.hub, served.filter(n => n.machineId === row.id).map(n => n.id));
    const disk = online ? load?.disk : undefined;
    if (!disk?.low) return [];
    const owner = row.ownerId && row.ownerName !== null ? { id: row.ownerId, name: row.ownerName } : null;
    return [{ id: row.id, hostname: row.hostname, owner, since: disk.low.since, disk }];
  });
  const names = await keptNames(ctx, companyId, cards.map(card => card.disk));
  const named = (disk: DiskReport) => Object.fromEntries((disk.kept ?? []).flatMap(k => (names.has(k.agent) ? [[k.agent, names.get(k.agent)!]] : [])));
  return cards.map(card => ({ ...card, names: named(card.disk) })).toSorted((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
}

const told = new WeakMap<object, Map<string, string>>();

/* Screens ask again when a card comes or goes. The word holds nothing, so it goes to everyone. */
export async function tellOfMachinesLow(ctx: Pick<Ctx, 'db' | 'hub' | 'bus'>): Promise<void> {
  const last = told.get(ctx) ?? new Map<string, string>();
  told.set(ctx, last);
  for (const { id } of await ctx.db.select(idOnly(companies)).from(companies)) {
    const state = (await machinesLow(ctx, id)).map(card => `${card.id} ${card.since}`).join();
    if ((last.get(id) ?? '') === state) continue;
    last.set(id, state);
    ctx.bus.publish(id, { type: 'requests', machines: true });
  }
}
