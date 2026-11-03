import type { Boot } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import type { Interruption, RestartCause } from '../../db/schema.js';

/* What a node said of itself in a hello. */
type Said = { version: string | null; boot: Boot | null };

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

/* The built-in node lives in the server's process. Its first hello in this context finds only turns from before that
   process started again; later hellos compare what it said while this server has been running. No machine row is needed. */
const builtinSaid = new WeakMap<Ctx, Said>();

const causeOf = (nodeId: string | null, before: Said | null, now: { version: string; boot?: Boot }): RestartCause =>
  nodeId === null && before === null ? 'server' : restartCause(before, now);

/* What a node's hello tells of the turns it no longer runs: why, as far as Hornhoof can tell, when, and on which node.
   The task's number goes in with each turn. A personal node's last word is in its row; the built-in node's is kept here. */
export function interruptionOf(ctx: Ctx, node: { id: string | null; name: string; said: Said | null }, now: { version: string; boot?: Boot }, at: Date): Omit<Interruption, 'task'> {
  const before = saidBefore(ctx, node, now);
  const cause = causeOf(node.id, before, now);
  return { cause, at: at.toISOString(), node: { id: node.id, name: node.name }, ...versionsOf(cause, before, now) };
}

/* What the node said in its hello before this one. The built-in node's last word is kept here, and this hello takes its
   place. */
function saidBefore(ctx: Ctx, node: { id: string | null; said: Said | null }, now: { version: string; boot?: Boot }): Said | null {
  if (node.id) return node.said;
  const before = builtinSaid.get(ctx) ?? null;
  builtinSaid.set(ctx, { version: now.version, boot: now.boot ?? null });
  return before;
}

/* An update names the versions it went between, when the node said the one before. */
const versionsOf = (cause: RestartCause, before: Said | null, now: { version: string }) =>
  cause === 'update' && before?.version ? { versions: { from: before.version, to: now.version } } : {};

export const BUILTIN_NAME = 'the built-in node';
