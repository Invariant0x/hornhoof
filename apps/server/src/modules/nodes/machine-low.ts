import type { DiskReport } from '@hornhoof/protocol';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, companies, departments, machines, people } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { onAgent } from '../conversation/line.js';
import { liveSubscription } from '../conversation/placement.js';
import { insertTurn, pump } from '../conversation/queue.js';
import { machineNodes, machineState } from '../testruns/load.js';
import { builtinOf, ownBuiltin, type NodeHub } from './hub.js';

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

const told = new WeakMap<object, Map<string, string>>();
const alertedOps = new WeakMap<object, Map<string, Set<string>>>();

const DISK_GB = 1_000_000_000;
const OPS_SIGNAL_ROLES: { role: string; kind: 'worker' | 'head' }[] = [
  { role: 'OPS-FIX', kind: 'worker' },
  { role: 'OPS-PROGRAM', kind: 'worker' },
  { role: 'OPS-HEAD', kind: 'head' },
];

const gbText = (bytes: number) => `${Math.round((bytes / DISK_GB) * 10) / 10} GB`;
const requiredBytes = (disk: DiskReport) => (disk.low && disk.free >= disk.threshold ? Math.ceil(disk.threshold * 1.1) : disk.threshold);

function heldByUnownedSpace(disk: DiskReport): boolean {
  const autoCleanable = (disk.parts.buildCache ?? 0) + (disk.parts.checkTemp ?? 0) + (disk.parts.recordings ?? 0);
  const nonAutoCleaned = Math.max(0, disk.total - disk.free - autoCleanable - (disk.parts.workingCopies ?? 0));
  return nonAutoCleaned > 0 && disk.free + autoCleanable < requiredBytes(disk);
}

async function operationsResponder(ctx: Ctx, companyId: string): Promise<(typeof agents.$inferSelect) | null> {
  const ops = ctx.db.select(idOnly(departments)).from(departments).where(and(eq(departments.companyId, companyId), eq(departments.templateKey, 'operations')));
  const below = ctx.db.select(idOnly(departments)).from(departments).where(and(eq(departments.companyId, companyId), inArray(departments.parentId, ops)));
  const staff = await ctx.db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), or(inArray(agents.departmentId, ops), inArray(agents.departmentId, below)), isNull(agents.removedAt), isNull(agents.switchedOffAt)))
    .orderBy(asc(agents.createdAt));
  for (const { role, kind } of OPS_SIGNAL_ROLES) {
    for (const candidate of staff.filter(agent => agent.roleKey === role && agent.kind === kind)) {
      if (await liveSubscription(ctx, candidate.id)) return candidate;
    }
  }
  return null;
}

type LowTarget = { key: string; label: string; since: string; disk: DiskReport };

async function lowTargets(ctx: Ctx, companyId: string, cards: MachineLow[]): Promise<LowTarget[]> {
  const targets: LowTarget[] = cards.map(card => ({ key: `machine:${card.id}`, label: `machine ${card.hostname}`, since: card.since, disk: card.disk }));
  const own = ownBuiltin(ctx.config);
  const ownDisk = ctx.hub.isOnline(own) ? ctx.hub.loadOf(own)?.disk : undefined;
  if (ownDisk?.low) {
    targets.push({ key: 'builtin:own', label: 'the server machine', since: ownDisk.low.since, disk: ownDisk });
  }
  const cored = await ctx.db
    .select({ id: machines.id, hostname: machines.hostname, networkId: machines.networkId })
    .from(machines)
    .where(and(eq(machines.companyId, companyId), isNull(machines.revokedAt)));
  for (const row of cored) {
    if (!row.networkId || cards.some(card => card.id === row.id)) continue;
    const identity = builtinOf(row.networkId);
    const disk = ctx.hub.isOnline(identity) ? ctx.hub.loadOf(identity)?.disk : undefined;
    if (disk?.low) targets.push({ key: `builtin:${row.networkId}`, label: `machine ${row.hostname}`, since: disk.low.since, disk });
  }
  return targets;
}

async function signalOperationsLow(ctx: Ctx, companyId: string, cards: MachineLow[]): Promise<void> {
  const byCompany = alertedOps.get(ctx) ?? new Map<string, Set<string>>();
  alertedOps.set(ctx, byCompany);
  const sent = byCompany.get(companyId) ?? new Set<string>();
  byCompany.set(companyId, sent);

  const targets = await lowTargets(ctx, companyId, cards);
  const activeSpells = new Set(targets.map(target => `${target.key}@${target.since}`));
  for (const existing of [...sent]) {
    if (!activeSpells.has(existing)) sent.delete(existing);
  }
  const due = targets.filter(target => heldByUnownedSpace(target.disk) && !sent.has(`${target.key}@${target.since}`));
  if (!due.length) return;
  const responder = await operationsResponder(ctx, companyId);
  if (!responder) return;
  for (const target of due) {
    const spell = `${target.key}@${target.since}`;
    const parts = Object.entries(target.disk.parts)
      .filter(([, bytes]) => bytes !== undefined)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([part, bytes]) => `${part} ${gbText(bytes!)}`)
      .join(', ');
    const prompt =
      `Hornhoof: ${target.label} is short of disk space since ${target.since}: ${gbText(target.disk.free)} free of ${gbText(target.disk.total)}, and it needs at least ${gbText(requiredBytes(target.disk))} for checks and builds. ` +
      (parts ? `Measured parts: ${parts}. ` : '') +
      `Space outside Hornhoof's automatic cache cleanup holds the threshold. Inspect the machine with your Operations tools and handle the unowned space directly.`;
    await onAgent(ctx, responder.id, () =>
      insertTurn(ctx, {
        companyId,
        agentId: responder.id,
        prompt,
        createdBy: null,
        message: {
          personId: null,
          text: prompt,
          notification: { source: 'machine', tasks: [], detail: { en: `${target.label}: low on disk space`, ru: `${target.label}: мало места на диске` } },
        },
      }),
    );
    await pump(ctx, responder.id);
    sent.add(spell);
  }
}

/* Screens ask again when a card comes or goes, and Operations hears once per low spell when unowned space holds the threshold. */
export async function tellOfMachinesLow(ctx: Ctx): Promise<void> {
  const last = told.get(ctx) ?? new Map<string, string>();
  told.set(ctx, last);
  for (const { id } of await ctx.db.select(idOnly(companies)).from(companies)) {
    const cards = await machinesLow(ctx, id);
    const state = cards.map(card => `${card.id} ${card.since}`).join();
    if ((last.get(id) ?? '') !== state) {
      last.set(id, state);
      ctx.bus.publish(id, { type: 'requests', machines: true });
    }
    await signalOperationsLow(ctx, id, cards);
  }
}
