import { randomUUID } from 'node:crypto';
import type { OperatorRecoveryState, OperatorServerMessage, ProgramInputResult, ProgramView } from '@hornhoof/protocol/program-operator';
import type { Ctx } from '../../app.js';
import { nodeIdentity, sameNode, type NodeIdentity } from '../nodes/hub.js';

type Channels = Pick<Ctx, 'hub'>;
type Target = { id: string; agentId: string; jobId: string; instance: string; nodeId: string };
/* The agent whose program a request is about, on the node it runs on. */
export type ProgramAt = { agentId: string; node: NodeIdentity };
type Reply = ProgramView | ProgramInputResult | OperatorRecoveryState;
type Waiting = { node: NodeIdentity; agentId: string; target: Target | null; done(reply: Reply | null): void };
const pending = new WeakMap<object, Map<string, Waiting>>();
const WAIT_MS = 3000;
const identity = (target: Target) => ({ agentKey: target.agentId, jobId: target.jobId, instance: target.instance });

/* What an agent's program shows and does right now, from the node it runs on. */
export async function requestProgramView(ctx: Channels, program: ProgramAt): Promise<ProgramView | null> {
  const request = randomUUID();
  const reply = await requestReply(ctx, program, null, `view:${request}`, { type: 'program.view_get', agentKey: program.agentId, request });
  return reply?.type === 'program.view' ? reply : null;
}

/* Words and keys into the program a fresh view showed. A lost answer leaves the result unknown, and nothing sends it again. */
export async function requestProgramInput(ctx: Channels, program: ProgramAt, input: { action: string; snapshot: string; keys: string[]; text: string | null; auditReason: string }): Promise<ProgramInputResult | null> {
  const reply = await requestReply(ctx, program, null, `input:${input.action}`, { type: 'program.input_send', agentKey: program.agentId, ...input });
  return reply?.type === 'program.input_result' ? reply : null;
}

/* What the node sees of the agent's program right now, for a decision that must not rest on what the database last heard. */
export async function requestRecoveryState(ctx: Channels, target: Target): Promise<OperatorRecoveryState | null> {
  const request = randomUUID();
  const reply = await requestReply(ctx, { agentId: target.agentId, node: nodeIdentity(target.nodeId) }, target, `recovery:${request}`, { type: 'program.recovery_state_get', ...identity(target), request, case: target.id });
  return reply?.type === 'program.recovery_state' ? reply : null;
}

function requestReply(ctx: Channels, program: ProgramAt, target: Target | null, ref: string, command: OperatorServerMessage): Promise<Reply | null> {
  const node = program.node;
  if (!ctx.hub.hasProgramOperator(node)) return Promise.resolve(null);
  const waiting = pending.get(ctx.hub) ?? new Map<string, Waiting>();
  pending.set(ctx.hub, waiting);
  if (waiting.has(ref)) return Promise.resolve(null);
  return new Promise<Reply | null>(resolve => {
    const done = (reply: Reply | null) => { clearTimeout(timer); waiting.delete(ref); resolve(reply); };
    const timer = setTimeout(() => done(null), WAIT_MS);
    waiting.set(ref, { node, agentId: program.agentId, target, done });
    try { if (!ctx.hub.send(node, command)) done(null); } catch { done(null); }
  });
}

function replyRef(reply: Reply): string {
  if (reply.type === 'program.view') return `view:${reply.request}`;
  if (reply.type === 'program.recovery_state') return `recovery:${reply.request}`;
  return `input:${reply.action}`;
}

/* Replies bypass the evidence queue, but only the original socket identity and exact target can finish a request. */
export function receiveOperatorReply(ctx: Channels, node: NodeIdentity, reply: Reply): boolean {
  const ref = replyRef(reply);
  const waiting = pending.get(ctx.hub)?.get(ref);
  if (!waiting || !sameNode(node, waiting.node) || reply.agentKey !== waiting.agentId) return false;
  const target = waiting.target;
  if (target && reply.type === 'program.recovery_state' && (reply.jobId !== target.jobId || reply.instance !== target.instance)) return false;
  waiting.done(reply);
  return true;
}
