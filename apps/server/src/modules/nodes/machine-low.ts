import type { DiskReport } from '@hornhoof/protocol';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, machines, people } from '../../db/schema.js';
import { machineNodes, machineState } from '../testruns/load.js';
import type { NodeHub } from './hub.js';

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

type Machine = { id: string; hostname: string; ownerId: string | null; ownerName: string | null };

/* What a machine's nodes say of its disk while one of them is online; nothing while none is. */
function saidDisk(hub: NodeHub, ids: string[]): DiskReport | undefined {
  const { online, load } = machineState(hub, ids);
  return online ? load?.disk : undefined;
}

/* The card of a machine whose disk is low, the names still to come; none while it has room. */
function lowCard(machine: Machine, disk: DiskReport | undefined): Omit<MachineLow, 'names'>[] {
  if (!disk?.low) return [];
  const owner = machine.ownerId && machine.ownerName !== null ? { id: machine.ownerId, name: machine.ownerName } : null;
  return [{ id: machine.id, hostname: machine.hostname, owner, since: disk.low.since, disk }];
}

/* The names of the employees among the folders a disk keeps work in. */
const keptBy = (names: Map<string, string>, disk: DiskReport) => Object.fromEntries((disk.kept ?? []).flatMap(k => (names.has(k.agent) ? [[k.agent, names.get(k.agent)!]] : [])));

const longestShortFirst = (a: MachineLow, b: MachineLow) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id);

/* The company's machines short of disk space, the longest short first. */
export async function machinesLow(ctx: Pick<Ctx, 'db' | 'hub'>, companyId: string): Promise<MachineLow[]> {
  const served = await machineNodes(ctx.db, companyId);
  const rows = await ctx.db
    .select({ id: machines.id, hostname: machines.hostname, ownerId: people.id, ownerName: people.name })
    .from(machines)
    .leftJoin(people, eq(people.id, machines.personId))
    .where(and(eq(machines.companyId, companyId), isNull(machines.revokedAt)));
  const cards = rows.flatMap(row => lowCard(row, saidDisk(ctx.hub, served.filter(n => n.machineId === row.id).map(n => n.id))));
  const names = await keptNames(ctx, companyId, cards.map(card => card.disk));
  return cards.map(card => ({ ...card, names: keptBy(names, card.disk) })).toSorted(longestShortFirst);
}
