import { MachineDrain } from '@hornhoof/protocol';
import { PROGRAM_OPERATOR_ROLE } from '@hornhoof/protocol/program-operator';
import type { Ctx } from '../../app.js';
import { type NodeIdentity } from '../nodes/hub.js';
/* By the config, which a transaction's copy of the context shares with the context itself. */
export const states = new WeakMap<Ctx['config'], NodeDrainState>();

export const nodeDrain = (ctx: Ctx, node: NodeIdentity): MachineDrain | null => states.get(ctx.config)?.view(node) ?? null;
/* Whether the node waits for an update: it takes no new turn and no test part. */
export const nodeHeld = (ctx: Ctx, node: NodeIdentity): boolean => nodeDrain(ctx, node) !== null;
/* Whether the node restarts for longer than the orchestrator and the heads wait, since an updater was told it is free. */
export const nodeHeldLong = (ctx: Ctx, node: NodeIdentity): boolean => states.get(ctx.config)?.heldLong(node) ?? false;
/* Whether a new turn of this role stays off the node. While the node waits, only a program operator's goes in, since a
   program there may wait for its answer; its case ends within OPERATOR_CASE_MS, so it does not hold the wait longer.
   Every other turn, the orchestrator's and the heads' too, goes to another node or waits for this one to come back, so
   the work on it ends however long it runs. A node that restarts takes nothing once its stop began: a node closes its
   link as it stops, and one that comes back with a new boot ends the restart in its hello. While its link is ready, its
   stop has not begun, as when the updater told it is free went away: the orchestrator and the heads come in past the
   limit then. */
export const nodeHeldFrom = (ctx: Ctx, node: NodeIdentity, role: string | null | undefined, leader = false): boolean => {
  const state = nodeDrain(ctx, node)?.state;
  if (state === 'waiting') return role !== PROGRAM_OPERATOR_ROLE;
  return state === 'restarting' && !(leader && ctx.hub.isReady(node) && nodeHeldLong(ctx, node));
};
export const requestNodeDrain = (ctx: Ctx, node: NodeIdentity): Promise<MachineDrain> => states.get(ctx.config)!.request(node);
export const cancelNodeDrain = (ctx: Ctx, node: NodeIdentity): void => states.get(ctx.config)?.cancel(node);
export const nodeDrainHello = (ctx: Ctx, node: NodeIdentity, boot: string | undefined): void => states.get(ctx.config)?.hello(node, boot);

export function machineDrain(ctx: Ctx, nodes: NodeIdentity[]): MachineDrain | null {
  const views = nodes.map(n => nodeDrain(ctx, n)).filter((v): v is MachineDrain => v !== null);
  const waiting = views.filter(v => v.state === 'waiting');
  if (waiting.length) return { state: 'waiting', turnsLeft: waiting.reduce((n, v) => n + v.turnsLeft, 0), partsLeft: waiting.reduce((n, v) => n + v.partsLeft, 0), since: waiting.map(v => v.since).sort()[0]! };
  return views.find(v => v.state === 'restarting') ?? views[0] ?? null;
}

export interface NodeDrainState {
  view(node: NodeIdentity): MachineDrain | null;
  heldLong(node: NodeIdentity): boolean;
  request(node: NodeIdentity): Promise<MachineDrain>;
  cancel(node: NodeIdentity): void;
  hello(node: NodeIdentity, boot: string | undefined): void;
  all(): { node: NodeIdentity; view: MachineDrain }[];
}
