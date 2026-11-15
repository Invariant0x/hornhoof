import { MCP_CONNECTING, TOOLS_BODY_MAX, type NodeMessage } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { jobs } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { agentOnNode, TURN_TIMEOUT_MS } from '../conversation/queue.js';
import { appendEvent } from '../events/store.js';
import { holdsMachine } from '../network/follow.js';
import type { NodeIdentity } from '../nodes/hub.js';
export { notStep } from './steps.js';

/* An agent's program talks to its tools whenever it likes: as it starts and connects, and when it goes on with work no turn
   of Hornhoof's carries, such as what a person typed while the turn was opening, or its own next step. Its node hands what
   it sends with no turn running to Hornhoof over the node's own link, and Hornhoof answers it through /mcp as ever, in a
   step of the tools that lives for that one request and ends with it. A step answers no person: no decision is taken for
   anyone in it, nor the work of running the company or a department for the last person who asked. Its token never leaves
   this process. */

export type ToolsCall = Extract<NodeMessage, { type: 'tools.call' }>;
type Answer = { status: number; body: string };
type Rpc = { id?: unknown; method?: unknown; params?: { name?: unknown } };

const NOT_HERE = "This employee is not on this machine any more, or not in the company: Hornhoof's tools do not answer its program here.";
const SWITCHED_OFF = 'This employee is switched off: its tools work again once a person switches it on.';
const INSTALLING = 'This machine installs a new build of Hornhoof now. Call again in a few minutes.';
const TOO_LARGE = "Hornhoof's answer to this call is too large to hand on with no turn running. Ask for less at a time.";
const UNREADABLE = 'Hornhoof could not read this message.';
/* What the journal says of a call, which keeps nothing of what it carried or what came back: either may hold a key. */
export const OUTSIDE_SUMMARY = 'Called with no turn running.';
/* The one code Hornhoof answers a refusal with, which an MCP client hands its agent as words. */
const REFUSED = -32001;

function messagesOf(body: string): Rpc[] | null {
  try {
    const value: unknown = JSON.parse(body);
    const all = Array.isArray(value) ? value : [value];
    return all.every(m => m !== null && typeof m === 'object') ? (all as Rpc[]) : null;
  } catch {
    return null;
  }
}

const connecting = (all: Rpc[]) => all.length > 0 && all.every(m => typeof m.method === 'string' && MCP_CONNECTING.includes(m.method));

/* A JSON-RPC error for each request of the message, which a client reads as words; a notification wants no answer. */
function refused(all: Rpc[] | null, text: string, code = REFUSED): Answer {
  const asked = (all ?? [{ id: null }]).filter(m => m.id !== undefined);
  if (asked.length === 0) return { status: 202, body: '' };
  const errors = asked.map(m => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message: text } }));
  return { status: 200, body: JSON.stringify(all && all.length > 1 ? errors : errors[0]) };
}

/* Whether each call of the message came back as a result that is no error, by its id. */
function outcomes(all: Rpc[], answer: string): Map<unknown, boolean> {
  const answered = messagesOf(answer) ?? [];
  const ok = new Map<unknown, boolean>();
  for (const a of answered as { id?: unknown; result?: { isError?: unknown }; error?: unknown }[]) ok.set(a.id, a.error === undefined && a.result !== undefined && a.result.isError !== true);
  return new Map(all.map(m => [m.id, ok.get(m.id) ?? false]));
}

async function openStep(ctx: Ctx, node: NodeIdentity, target: NonNullable<Awaited<ReturnType<typeof agentOnNode>>>): Promise<{ id: string; token: string } | null> {
  const token = newToken();
  const nodeId = node.kind === 'node' ? node.nodeId : null;
  /* A machine that installs its build takes no step, as it takes no turn: asked and written in one transaction. */
  return ctx.db.transaction(async tx => {
    if (await holdsMachine(tx, nodeId)) return null;
    const [row] = await tx
      .insert(jobs)
      .values({ companyId: target.agent.companyId, subscriptionId: target.sub.id, nodeId, agentId: target.agent.id, kind: 'tools', status: 'running', startedAt: new Date(), prompt: '', timeoutMs: TURN_TIMEOUT_MS, createdBy: null, toolTokenHash: hashToken(token) })
      .returning({ id: jobs.id });
    return { id: row!.id, token };
  });
}

async function journal(ctx: Ctx, target: { agent: { id: string; companyId: string } }, stepId: string, calls: Rpc[], ok?: Map<unknown, boolean>): Promise<void> {
  for (const call of calls) {
    const name = String(call.params?.name ?? '').slice(0, 100);
    const at = { companyId: target.agent.companyId, agentId: target.agent.id, jobId: stepId };
    if (!ok) await appendEvent(ctx, { ...at, kind: 'tool', data: { name, input: '' } });
    else await appendEvent(ctx, { ...at, kind: 'tool_result', data: { ok: ok.get(call.id) ?? false, summary: OUTSIDE_SUMMARY } });
  }
}

/* Runs the message through /mcp in a step of the agent's, which ends with it. */
async function inStep(app: FastifyInstance, ctx: Ctx, node: NodeIdentity, call: ToolsCall, target: NonNullable<Awaited<ReturnType<typeof agentOnNode>>>, all: Rpc[]): Promise<Answer> {
  const step = await openStep(ctx, node, target);
  if (!step) return refused(all, INSTALLING);
  const calls = all.filter(m => m.method === 'tools/call');
  try {
    await journal(ctx, target, step.id, calls);
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${step.token}`, ...(call.version ? { 'mcp-protocol-version': call.version } : {}) },
      payload: call.body,
    });
    await journal(ctx, target, step.id, calls, outcomes(calls, res.body));
    if (res.body.length > TOOLS_BODY_MAX) return refused(all, TOO_LARGE);
    return { status: res.statusCode, body: res.body };
  } finally {
    await ctx.db.update(jobs).set({ status: 'done', result: '', finishedAt: new Date() }).where(and(eq(jobs.id, step.id), eq(jobs.status, 'running')));
  }
}

async function answerOf(app: FastifyInstance, ctx: Ctx, node: NodeIdentity, call: ToolsCall): Promise<Answer> {
  const all = messagesOf(call.body);
  if (!all) return refused(null, UNREADABLE, -32700);
  const target = await agentOnNode(ctx, node, call.agentKey);
  if (!target) return refused(all, NOT_HERE);
  /* A program connects and lists its tools at any time of its life; it calls them only while its employee is on. */
  if (!connecting(all) && target.agent.switchedOffAt) return refused(all, SWITCHED_OFF);
  return inStep(app, ctx, node, call, target, all);
}

/* Hornhoof's answer to what a program sent with no turn running, to the node that handed it on. */
export async function answerOutside(app: FastifyInstance, ctx: Ctx, node: NodeIdentity, call: ToolsCall): Promise<void> {
  const answer = await answerOf(app, ctx, node, call).catch((err: unknown) => {
    ctx.log.warn({ error: loggable(err) }, 'Could not answer an agent that called its tools with no turn running.');
    return refused(messagesOf(call.body), 'Hornhoof could not answer this call. Try again.');
  });
  ctx.hub.send(node, { type: 'tools.answer', agentKey: call.agentKey, ref: call.ref, ...answer });
}
