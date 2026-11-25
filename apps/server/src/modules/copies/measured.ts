import type { MachineReplicas } from '@hornhoof/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { machines } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import type { SavingWait } from '../keeper/led.js';
import { freshState } from '../keeper/state.js';

export type SavingDetail = { waiting: SavingWait; since: string };

/* How fast the leader sends to each machine, as its keeper last measured it, into the machines' rows: each live row
   the keeper names whose value differs gets the new one. A row it does not name keeps what it has, as after a week with
   nothing sent to it or after a change of leader. The rows written. */
export async function storeThroughput(ctx: Ctx, now = Date.now()): Promise<number> {
  const said = freshState(ctx.config.controlDir, now)?.throughput;
  if (!said) return 0;
  let written = 0;
  for (const [id, { mbps }] of Object.entries(said)) {
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    const [row] = await ctx.db.select(only(machines, 'linkMbps')).from(machines).where(and(eq(machines.id, id), isNull(machines.revokedAt)));
    if (!row || row.linkMbps === mbps) continue;
    await ctx.db.update(machines).set({ linkMbps: mbps }).where(eq(machines.id, id));
    written += 1;
  }
  return written;
}

/* A keeper names only the bytes of its own databases. The server supplies the company name from its own records. */
const replicaBytes = new WeakMap<Ctx, Map<string, number>>();

export function noteReplicaBytes(ctx: Ctx, machineId: string, bytes: number | null): void {
  const known = replicaBytes.get(ctx) ?? new Map<string, number>();
  if (bytes === null) known.delete(machineId);
  else known.set(machineId, bytes);
  replicaBytes.set(ctx, known);
}

/* A missing measurement is left out. One replica can occupy the space of its current database and an earlier
   attempt pending merge; both sizes are included. Only this server's company is visible here. */
export function replicasOf(ctx: Ctx, machineId: string, holdsCopy: boolean, company: string): MachineReplicas | undefined {
  const bytes = holdsCopy ? replicaBytes.get(ctx)?.get(machineId) : 0;
  if (bytes === undefined) return undefined;
  return bytes === 0 ? { count: 0, bytes, companies: [] } : { count: 1, bytes, companies: [{ name: company, bytes }] };
}

/* A copy its keeper gave up for good, as it says: since when, after how many attempts in a row, and why: it failed again
   and again, or the path to it is too slow or too late for a copy. */
export type GaveUpDetail = { since: string; attempts: number; why: 'failed' | 'slow' | 'late' };
const gaveUpDetails = new WeakMap<Ctx, Map<string, GaveUpDetail>>();

export function noteGaveUp(ctx: Ctx, machineId: string, gaveUp: GaveUpDetail | null): void {
  const known = gaveUpDetails.get(ctx) ?? new Map<string, GaveUpDetail>();
  if (gaveUp === null) known.delete(machineId);
  else known.set(machineId, gaveUp);
  gaveUpDetails.set(ctx, known);
}

export function gaveUpOf(ctx: Ctx, machineId: string): GaveUpDetail | undefined {
  return gaveUpDetails.get(ctx)?.get(machineId);
}

/* Every copy given up, by its machine's id. */
export function gaveUpAll(ctx: Ctx): [string, GaveUpDetail][] {
  return [...(gaveUpDetails.get(ctx) ?? [])];
}

/* What a former leader's keeper says it waits on while saving what it did, and since when. */
const savingDetails = new WeakMap<Ctx, Map<string, SavingDetail>>();

export function noteSaving(ctx: Ctx, machineId: string, saving: SavingDetail | null): void {
  const known = savingDetails.get(ctx) ?? new Map<string, SavingDetail>();
  if (saving === null) known.delete(machineId);
  else known.set(machineId, saving);
  savingDetails.set(ctx, known);
}

export function savingOf(ctx: Ctx, machineId: string): SavingDetail | undefined {
  return savingDetails.get(ctx)?.get(machineId);
}
