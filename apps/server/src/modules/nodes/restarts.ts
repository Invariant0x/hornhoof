import type { Boot, NodeExit } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { companies, type RestartCause } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ownMachine } from './hub.js';
import { builtinMachine } from './nodes.js';
import { restartDetails, type Hello, type NodeBoot, type RestartCut } from './restart-evidence.js';

/* What a node said of itself in a hello. */
type Said = { version: string | null; boot: NodeBoot | null };

/* A node works out when its machine started from the machine's uptime, which moves by a few seconds between two hellos.
   A machine start later than the node's last program start by more than this means the machine started again since. */
const CLOCK_SLACK_MS = 60_000;

/* Why the turns a node ran are gone, from how it came up before and how it came up now. A node that never said is a cause
   Hornhoof does not know. */
export function restartCause(before: Said | null, now: { version: string; boot?: Boot }): RestartCause {
  if (!before?.boot || !now.boot) return 'unknown';
  if (before.version && before.version !== now.version) return 'update';
  if (Date.parse(now.boot.machineUpAt) > Date.parse(before.boot.startedAt) + CLOCK_SLACK_MS) return 'machine';
  if (now.boot.container !== before.boot.container) return 'container';
  if (now.boot.startedAt !== before.boot.startedAt) return 'program';
  /* The same program, which never got the turn or lost it while the connection was down. */
  return 'connection';
}

/* A built-in node's first hello in this context follows the server's start. Later hellos compare its own boots: each
   machine that holds the data runs one, and what one said is kept under its machine. */
const builtinSaid = new WeakMap<Ctx, Map<string, Said>>();
const saidOf = (ctx: Ctx): Map<string, Said> => {
  const known = builtinSaid.get(ctx) ?? new Map<string, Said>();
  builtinSaid.set(ctx, known);
  return known;
};

const causeOf = (nodeId: string | null, before: Said | null, now: { version: string; boot?: Boot }): RestartCause =>
  nodeId === null && before === null ? 'server' : restartCause(before, now);

/* What a node's hello tells of the turns it no longer runs: why, as far as Hornhoof can tell, when, and on which node.
   The task's number goes in with each turn. A personal node's last word is in its row; the built-in node's is kept here. */
export function interruptionOf(ctx: Ctx, node: { id: string | null; builtin?: string; name: string; said: Said | null; machine: { id: string | null; name: string | null } }, now: Hello, at: Date): RestartCut {
  const before = saidBefore(ctx, node, now);
  const cause = causeOf(node.id, before, now);
  return { cause, at: at.toISOString(), node: { id: node.id, name: node.name }, machine: node.machine, ...versionsOf(cause, before, now), ...restartDetails(before, now, cause, at) };
}

/* machine: the machine whose built-in node said hello, by its network id. */
export async function builtinInterruption(ctx: Ctx, machine: string, now: Hello, at: Date): Promise<RestartCut> {
  const [company] = await ctx.db.select(idOnly(companies)).from(companies).where(eq(companies.singleton, true));
  const own = machine === ownMachine(ctx.config);
  const row = !company ? null : own ? await builtinMachine(ctx.db, ctx.config.hostId, company.id, ctx.config.machineId) : await builtinMachine(ctx.db, null, company.id, machine);
  return interruptionOf(ctx, { id: null, builtin: machine, name: BUILTIN_NAME, said: null, machine: { id: row?.id ?? null, name: row?.hostname ?? null } }, now, at);
}

export function rememberBuiltinStop(ctx: Ctx, machine: string, startedAt: string, exit: NodeExit): void {
  const before = saidOf(ctx).get(machine);
  if (before?.boot?.startedAt !== startedAt) return;
  if (before.boot.stopped) return;
  saidOf(ctx).set(machine, { ...before, boot: { ...before.boot, stopped: exit } });
}

/* What the node said in its hello before this one. The built-in node's last word is kept here, and this hello takes its
   place. */
function saidBefore(ctx: Ctx, node: { id: string | null; builtin?: string; said: Said | null }, now: { version: string; boot?: Boot }): Said | null {
  if (node.id) return node.said;
  const machine = node.builtin ?? ownMachine(ctx.config);
  const before = saidOf(ctx).get(machine) ?? null;
  saidOf(ctx).set(machine, { version: now.version, boot: now.boot ?? null });
  return before;
}

/* An update names the versions it went between, when the node said the one before. */
const versionsOf = (cause: RestartCause, before: Said | null, now: { version: string }) =>
  cause === 'update' && before?.version ? { versions: { from: before.version, to: now.version } } : {};

export const BUILTIN_NAME = 'the built-in node';
