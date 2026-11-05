import { randomUUID } from 'node:crypto';
import { OPERATOR_KEY_MS, type OperatorKey, type OperatorKeyPrepared, type OperatorKeyResult, type OperatorRecoveryState, type OperatorScreen, type OperatorServerMessage } from '@hornhoof/protocol/program-operator';
import type { Ctx } from '../../app.js';
import { nodeIdentity, sameNode, type NodeIdentity } from '../nodes/hub.js';

type Channels = Pick<Ctx, 'hub'>;
type Target = { id: string; agentId: string; jobId: string; instance: string; nodeId: string; capability: string };
type Reply = OperatorScreen | OperatorKeyResult | OperatorKeyPrepared | OperatorRecoveryState;
type Waiting = { node: NodeIdentity; target: Target; done(reply: Reply | null): void };
const pending = new WeakMap<object, Map<string, Waiting>>();
const WAIT_MS = 3000;
const identity = (target: Target) => ({ agentKey: target.agentId, jobId: target.jobId, instance: target.instance });

export async function requestOperatorScreen(ctx: Channels, target: Target): Promise<OperatorScreen | null> {
  const request = randomUUID();
  const reply = await requestReply(ctx, target, `screen:${request}`, { type: 'program.screen_get', ...identity(target), request, case: target.id, capability: target.capability });
  return reply?.type === 'program.screen' ? reply : null;
}

export async function requestOperatorKey(ctx: Channels, target: Target, input: { snapshot: string; generation: number; action: string; key: OperatorKey }): Promise<OperatorKeyResult | null> {
  const prepared = await requestReply(ctx, target, `prepare:${input.action}`, { type: 'program.key_prepare', ...identity(target), case: target.id, capability: target.capability, ...input });
  if (prepared?.type !== 'program.key_prepared' || prepared.result !== 'ok' || !prepared.lease) return { type: 'program.key_result', ...identity(target), action: input.action, result: 'refused', reason: (prepared && 'reason' in prepared ? prepared.reason : null) ?? 'node_unavailable' };
  const reply = await requestReply(ctx, target, `key:${input.action}`, { type: 'program.key_send', ...identity(target), case: target.id, capability: target.capability, ...input, lease: prepared.lease, withinMs: OPERATOR_KEY_MS });
  return reply?.type === 'program.key_result' ? reply : null;
}

/* What the node sees of the agent's program right now, for a decision that must not rest on what the database last heard. */
export async function requestRecoveryState(ctx: Channels, target: Target): Promise<OperatorRecoveryState | null> {
  const request = randomUUID();
  const reply = await requestReply(ctx, target, `recovery:${request}`, { type: 'program.recovery_state_get', ...identity(target), request, case: target.id });
  return reply?.type === 'program.recovery_state' ? reply : null;
}

function requestReply(ctx: Channels, target: Target, ref: string, command: OperatorServerMessage): Promise<Reply | null> {
  const node = nodeIdentity(target.nodeId);
  if (!ctx.hub.hasProgramOperator(node)) return Promise.resolve(null);
  const waiting = pending.get(ctx.hub) ?? new Map<string, Waiting>();
  pending.set(ctx.hub, waiting);
  if (waiting.has(ref)) return Promise.resolve(null);
  return new Promise<Reply | null>(resolve => {
    const done = (reply: Reply | null) => { clearTimeout(timer); waiting.delete(ref); resolve(reply); };
    const timer = setTimeout(() => done(null), WAIT_MS);
    waiting.set(ref, { node, target, done });
    try { if (!ctx.hub.send(node, command)) done(null); } catch { done(null); }
  });
}

function replyRef(reply: Reply): string {
  if (reply.type === 'program.screen') return `screen:${reply.request}`;
  if (reply.type === 'program.recovery_state') return `recovery:${reply.request}`;
  return reply.type === 'program.key_prepared' ? `prepare:${reply.action}` : `key:${reply.action}`;
}

/* Replies bypass the evidence queue, but only the original socket identity and exact target can finish a request. */
export function receiveOperatorReply(ctx: Channels, node: NodeIdentity, reply: Reply): boolean {
  const ref = replyRef(reply);
  const waiting = pending.get(ctx.hub)?.get(ref);
  if (!waiting || !sameNode(node, waiting.node)) return false;
  const target = waiting.target;
  if (reply.agentKey !== target.agentId || reply.jobId !== target.jobId || reply.instance !== target.instance) return false;
  waiting.done(reply);
  return true;
}
