import type { NodeMessage } from '@hornhoof/protocol';
import { SIGNIN_ERRORS, type SigninStep } from '@hornhoof/protocol/signin';
import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { machines, nodes, subscriptions } from '../../db/schema.js';
import { liveNode } from '../nodes/nodes.js';

/* How often the server looks whether a connection takes longer than usual or went past its deadline. */
export const CONNECT_ROUND_MS = 1000;

type State = 'connecting' | 'failed' | 'too_long';

/* A plan's connection after its sign-in code, as its owner sees it: on which machine, how far it got and since when, until
   when it may take, and why it failed. */
export type ConnectingView = {
  nodeId: string;
  hostname: string;
  state: State;
  step: SigninStep;
  since: string;
  until: string;
  error: string | null;
  code: number | null;
  line: string | null;
};

/* stepAtMs: when its node said its last step; readyBefore: the plan was ready when its connection began, as when its owner
   signs it in again; signedIn: its program took the new sign-in. */
type Connection = ConnectingView & { plan: string; companyId: string; owner: string; untilMs: number; stepAtMs: number; readyBefore: boolean; signedIn: boolean };

/* The connections of this server's plans by plan. They live as long as the server: after a restart the plan shows its
   state, and its node says the next step. */
const kept = new WeakMap<Ctx, Map<string, Connection>>();

function connections(ctx: Ctx): Map<string, Connection> {
  let all = kept.get(ctx);
  if (!all) kept.set(ctx, (all = new Map()));
  return all;
}

const viewOf = ({ nodeId, hostname, state, step, since, until, error, code, line }: Connection): ConnectingView => ({ nodeId, hostname, state, step, since, until, error, code, line });

function tell(ctx: Ctx, c: { plan: string; companyId: string; owner: string }, connecting: ConnectingView | null): void {
  ctx.bus.publish(c.companyId, { type: 'subscription.connecting', subscriptionId: c.plan, connecting, owner: c.owner });
}

/* The personal plan a live node runs, with its machine's name. */
async function planOf(ctx: Ctx, nodeId: string) {
  const [row] = await ctx.db
    .select({ plan: subscriptions.id, companyId: subscriptions.companyId, owner: subscriptions.ownerPersonId, status: subscriptions.status, hostname: machines.hostname })
    .from(nodes)
    .innerJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
    .innerJoin(machines, eq(machines.id, nodes.machineId))
    .where(and(eq(nodes.id, nodeId), liveNode, eq(subscriptions.kind, 'personal'), isNull(subscriptions.removedAt)));
  return row ?? null;
}

type StepMessage = Extract<NodeMessage, { type: 'login.step' }>;

/* A node said where its plan's connection is. The first step after the code starts it, and its deadline, which is of the
   whole connection: later steps do not move it. Each step starts over the time after which the connection takes longer
   than usual, and one that took longer goes on. A step after a failure starts a new connection. */
export async function connectionStep(ctx: Ctx, nodeId: string, msg: StepMessage): Promise<void> {
  const node = await planOf(ctx, nodeId);
  if (!node) return;
  const all = connections(ctx);
  const was = all.get(node.plan);
  if (msg.step === 'failed') return failed(ctx, was, msg.error ?? null, null, msg.line ?? null);
  let c = was && was.state !== 'failed' ? was : undefined;
  if (!c) {
    const now = ctx.clock();
    const untilMs = now + ctx.config.signinConnectMs;
    c = { plan: node.plan, companyId: node.companyId, owner: node.owner, nodeId, hostname: node.hostname, state: 'connecting', step: msg.step, since: new Date(now).toISOString(), until: new Date(untilMs).toISOString(), untilMs, stepAtMs: now, error: null, code: null, line: null, readyBefore: node.status === 'ready', signedIn: false };
    all.set(node.plan, c);
  }
  c.state = 'connecting';
  c.stepAtMs = ctx.clock();
  c.step = msg.step;
  c.nodeId = nodeId;
  c.hostname = node.hostname;
  if (msg.step === 'signed_in') c.signedIn = true;
  tell(ctx, c, viewOf(c));
}

function failed(ctx: Ctx, c: Connection | undefined, error: string | null, code: number | null, line: string | null): void {
  if (!c || c.state === 'failed') return;
  Object.assign(c, { state: 'failed', error, code, line });
  tell(ctx, c, viewOf(c));
}

/* How the sign-in Hornhoof started on a node ended: kept, so the connection ends once the plan is ready, or not, so it
   failed with why. A sign-in that ended before its code had no connection, and says why in its own window. */
export async function connectionEnded(ctx: Ctx, nodeId: string, ok: boolean, error: string | null, early: { code: number | null; line: string | null }): Promise<void> {
  const node = await planOf(ctx, nodeId);
  const c = node ? connections(ctx).get(node.plan) : undefined;
  if (!c) return;
  if (!ok) return failed(ctx, c, error, early.code, early.line);
  c.signedIn = true;
  await connectionSettled(ctx, nodeId);
}

/* A connection ends once the plan is ready on its machines, and the ready card shows; one that waits for the program's first
   setup ends too, and the card says what to do. A plan that was ready before waits for its new sign-in, kept or failed. */
export async function connectionSettled(ctx: Ctx, nodeId: string): Promise<void> {
  const node = await planOf(ctx, nodeId);
  const c = node ? connections(ctx).get(node.plan) : undefined;
  if (!node || !c || (c.readyBefore && !c.signedIn)) return;
  if (node.status !== 'ready' && node.status !== 'needs_setup') return;
  connections(ctx).delete(node.plan);
  tell(ctx, c, null);
}

/* The owner stopped the connection, tries it again, or signs in anew: it is gone, and the plan shows its state. */
export function connectionCleared(ctx: Ctx, plan: string): Connection | null {
  const c = connections(ctx).get(plan) ?? null;
  if (!c) return null;
  connections(ctx).delete(plan);
  tell(ctx, c, null);
  return c;
}

/* A connection whose node said no step for a while takes longer than usual: its owner hears it, and it still ends if its plan
   gets ready. One past its deadline failed, as its machine stopped answering in time. */
export function connectionRound(ctx: Ctx): void {
  const now = ctx.clock();
  for (const c of connections(ctx).values()) {
    if (c.state === 'failed') continue;
    if (now >= c.untilMs) failed(ctx, c, SIGNIN_ERRORS.noAnswer, null, null);
    else if (c.state === 'connecting' && now >= c.stepAtMs + ctx.config.signinSlowMs) {
      c.state = 'too_long';
      tell(ctx, c, viewOf(c));
    }
  }
}

/* The plan's connection, for its owner alone. */
export function connectingFor(ctx: Ctx, plan: string, viewerId: string | undefined): ConnectingView | null {
  const c = connections(ctx).get(plan);
  return c && c.owner === viewerId ? viewOf(c) : null;
}
