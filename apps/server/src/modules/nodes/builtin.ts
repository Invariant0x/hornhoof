import { and, eq, exists, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agents, jobs, machines, subscriptions, testParts } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { heldBuiltins } from '../network/follow.js';
import { builtinOf, ownMachine, UNNAMED_BUILTIN } from './hub.js';

type Reader = Pick<Db, 'select'>;

/* The built-in node an API key's agent runs on: the one its program is on while that node is ready, so its folder and
   session go on there; else the one of the machine this server runs on; else the ready one whose machine stands first
   in the server order. A machine that installs its build now, or is next to, takes nothing new. The machine's network
   id, or null when no built-in node is ready. */
export async function pickBuiltin(ctx: Ctx, db: Reader, current: string | null, accepts?: (machine: string) => boolean): Promise<string | null> {
  const own = ownMachine(ctx.config);
  const there = (machine: string): boolean => (accepts?.(machine) ?? true) && ctx.hub.isReady(builtinOf(machine));
  /* The machine this server runs on follows nobody's build, so its node is never held for an install. */
  if (current === own || current === null) {
    if (there(own)) return own;
  }
  const installing = await heldBuiltins(ctx, db);
  if (current && current !== own && there(current) && !installing.has(current)) return current;
  if (there(own)) return own;
  const ready = ctx.hub.builtins().filter(machine => machine !== own && (accepts?.(machine) ?? true) && !installing.has(machine));
  if (ready.length === 0) return null;
  const rows = await db.select({ networkId: machines.networkId, order: machines.serverOrder }).from(machines).where(and(inArray(machines.networkId, ready), isNull(machines.revokedAt)));
  const orderOf = (machine: string): number => rows.find(row => row.networkId === machine)?.order ?? Infinity;
  return [...ready].sort((a, b) => orderOf(a) - orderOf(b) || (a < b ? -1 : 1))[0] ?? null;
}

export const BUILTIN_NAME = 'the built-in node';

/* What a built-in node is called where its work is listed: the server's own by its bare name, another by its machine's. */
export async function builtinName(ctx: Ctx, db: Reader, machine: string): Promise<string> {
  if (machine === ownMachine(ctx.config)) return BUILTIN_NAME;
  const [row] = await db.select(only(machines, 'hostname')).from(machines).where(and(eq(machines.networkId, machine), isNull(machines.revokedAt)));
  return row?.hostname ? `${BUILTIN_NAME} on ${row.hostname}` : BUILTIN_NAME;
}

/* Work from before each machine's built-in node was told apart ran on the one of the machine this server runs on. It is
   given that machine's id while the server still leads there, so that it stays that node's when the server moves:
   every open job of an API key, the agents whose program is there, and the parts of test runs it takes. An install
   that runs under no machine id has one built-in node and nothing to tell apart. */
export async function nameBuiltinWork(ctx: Ctx): Promise<void> {
  const own = ownMachine(ctx.config);
  if (own === UNNAMED_BUILTIN) return;
  const { db } = ctx;
  const keys = db.select(idOnly(subscriptions)).from(subscriptions).where(eq(subscriptions.kind, 'api_key'));
  await db.update(jobs).set({ builtinMachine: own }).where(and(isNull(jobs.builtinMachine), isNull(jobs.nodeId), inArray(jobs.status, ['queued', 'running']), inArray(jobs.subscriptionId, keys)));
  const ran = db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, agents.id), eq(jobs.subscriptionId, agents.subscriptionId), isNotNull(jobs.startedAt)));
  await db.update(agents).set({ builtinMachine: own }).where(and(isNull(agents.builtinMachine), isNull(agents.nodeId), inArray(agents.subscriptionId, keys), exists(ran)));
  await db.update(testParts).set({ builtinMachine: own }).where(and(isNull(testParts.builtinMachine), eq(testParts.builtin, true), inArray(testParts.status, ['queued', 'running'])));
}
