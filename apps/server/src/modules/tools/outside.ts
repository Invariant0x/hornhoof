import { MCP_CONNECTING, TOOLS_BODY_MAX, type NodeMessage } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { jobs, subscriptions } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { agentOnNode } from '../conversation/placement.js';
import { TURN_TIMEOUT_MS } from '../conversation/constants.js';
import { appendEvent } from '../events/store.js';
import { holdsMachine } from '../network/follow.js';
import { jobsOf } from '../nodes/jobs.js';
import { identityOf, ownBuiltin, type NodeIdentity } from '../nodes/hub.js';
import { attachmentToken } from '../tasks/attachment-token.js';
import { forgetPrivateTurn } from './private-turns.js';
export { notStep } from './steps.js';

/* An agent's program talks to its tools whenever it likes: as it starts and connects, and when it goes on with work no turn
   of Hornhoof's carries, such as what a person typed while the turn was opening, or its own next step. Its node hands what
   it sends with no turn running to Hornhoof over the node's own link, and Hornhoof answers it through /mcp as ever, in a
   step of the tools that lives for that one request and ends with it. A step answers no person: no decision is taken for
   anyone in it, nor the work of running the company or a department for the last person who asked. Its token never leaves
   this process. */

export type ToolsCall = Extract<NodeMessage, { type: 'tools.call' }>;
type ToolsCheck = Extract<NodeMessage, { type: 'tools.check' }>;
type ToolsChecked = Extract<NodeMessage, { type: 'tools.checked' }>;
type Answer = { status: number; body: string };
type Rpc = { id?: unknown; method?: unknown; params?: { name?: unknown } };

const NOT_HERE = "This employee is not on this machine any more, or not in the company: Hornhoof's tools do not answer its program here.";
const SWITCHED_OFF = 'This employee is switched off: its tools work again once a person switches it on.';
const INSTALLING = 'This machine installs a new build of Hornhoof now. Call again in a few minutes.';
const TOO_LARGE = "Hornhoof's answer to this call is too large to hand on with no turn running. Ask for less at a time.";
const UNREADABLE = 'Hornhoof could not read this message.';
/* What the journal says of a call, which keeps nothing of what it carried or what came back: either may hold a key. */
export const OUTSIDE_SUMMARY = 'Called with no turn running.';
const CHECK_SUMMARY = 'Ran with no turn running.';
/* The name a check command goes by in the journal, as the agent calls it. */
const CHECK = 'hh-check';
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

type Target = NonNullable<Awaited<ReturnType<typeof agentOnNode>>>;

/* A step with a token for /mcp, or with none for a check command, which calls no tool. */
async function openStep(ctx: Ctx, node: NodeIdentity, target: Target, token: string | null): Promise<{ id: string } | null> {
  const nodeId = node.kind === 'node' ? node.nodeId : null;
  /* A machine that installs its build takes no step, as it takes no turn: asked and written in one transaction. */
  return ctx.db.transaction(async tx => {
    if (await holdsMachine(tx, nodeId)) return null;
    const [row] = await tx
      .insert(jobs)
      .values({ companyId: target.agent.companyId, subscriptionId: target.sub.id, nodeId, builtinMachine: node.kind === 'builtin' ? node.machine : null, agentId: target.agent.id, kind: 'tools', status: 'running', startedAt: new Date(), prompt: '', timeoutMs: TURN_TIMEOUT_MS, createdBy: null, toolTokenHash: token === null ? null : hashToken(token) })
      .returning({ id: jobs.id });
    return { id: row!.id };
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
async function inStep(app: FastifyInstance, ctx: Ctx, node: NodeIdentity, call: ToolsCall, target: Target, all: Rpc[]): Promise<Answer> {
  const token = newToken();
  const step = await openStep(ctx, node, target, token);
  if (!step) return refused(all, INSTALLING);
  const calls = all.filter(m => m.method === 'tools/call');
  try {
    await journal(ctx, target, step.id, calls);
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...(call.version ? { 'mcp-protocol-version': call.version } : {}) },
      payload: call.body,
    });
    await journal(ctx, target, step.id, calls, outcomes(calls, res.body));
    if (res.body.length > TOOLS_BODY_MAX) return refused(all, TOO_LARGE);
    return { status: res.statusCode, body: res.body };
  } finally {
    await ctx.db.update(jobs).set({ status: 'done', result: '', finishedAt: new Date() }).where(and(eq(jobs.id, step.id), eq(jobs.status, 'running')));
    forgetPrivateTurn(ctx.db, step.id);
  }
}

async function answerOf(app: FastifyInstance, ctx: Ctx, node: NodeIdentity, call: ToolsCall): Promise<Answer> {
  const all = messagesOf(call.body);
  if (!all) return refused(null, UNREADABLE, -32700);
  const target = await agentOnNode(ctx, node, call.agentKey);
  if (!target) return refused(all, NOT_HERE);
  /* A program connects and lists its tools at any time of its life; it calls them only while its employee is on. */
  if (!connecting(all) && target.agent.switchedOffAt) return refused(all, SWITCHED_OFF);
  if (all.length === 1 && all[0]!.method === 'attachments/token') {
    return attachmentPermission(ctx, node, target.agent.id, all);
  }
  return inStep(app, ctx, node, call, target, all);
}

async function attachmentPermission(ctx: Ctx, node: NodeIdentity, agentId: string, all: Rpc[]): Promise<Answer> {
  if (await holdsMachine(ctx.db, node.kind === 'node' ? node.nodeId : null)) return refused(all, INSTALLING);
  const token = await attachmentToken(ctx, node, agentId);
  return token ? { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: all[0]!.id, result: { token } }) } : refused(all, 'No Hornhoof turn is running for this agent.');
}

/* Hornhoof's answer to what a program sent with no turn running, to the node that handed it on. */
export async function answerOutside(app: FastifyInstance, ctx: Ctx, node: NodeIdentity, call: ToolsCall): Promise<void> {
  const answer = await answerOf(app, ctx, node, call).catch((err: unknown) => {
    ctx.log.warn({ error: loggable(err) }, 'Could not answer an agent that called its tools with no turn running.');
    return refused(messagesOf(call.body), 'Hornhoof could not answer this call. Try again.');
  });
  ctx.hub.send(node, { type: 'tools.answer', agentKey: call.agentKey, ref: call.ref, ...answer });
}

/* A check command the agent's program runs with no turn running: it runs in a step of its own, open until the node says
   it ended or Hornhoof stops it, which the machine's check slot goes to as to a turn. It may run on the same terms as a
   tool call, and calls no tool, so the step has no token. Null with the words its program gets when it may not run. */
async function checkStep(ctx: Ctx, node: NodeIdentity, msg: ToolsCheck): Promise<{ jobId: string | null; refused?: string }> {
  const target = await agentOnNode(ctx, node, msg.agentKey);
  if (!target) return { jobId: null, refused: NOT_HERE };
  if (target.agent.switchedOffAt) return { jobId: null, refused: SWITCHED_OFF };
  const step = await openStep(ctx, node, target, null);
  if (!step) return { jobId: null, refused: INSTALLING };
  await appendEvent(ctx, { companyId: target.agent.companyId, agentId: target.agent.id, jobId: step.id, kind: 'tool', data: { name: CHECK, input: '' } });
  return { jobId: step.id };
}

export async function openCheck(ctx: Ctx, node: NodeIdentity, msg: ToolsCheck): Promise<void> {
  const answer = await checkStep(ctx, node, msg).catch((err: unknown) => {
    ctx.log.warn({ error: loggable(err) }, 'Could not open a step for a check command with no turn running.');
    return { jobId: null, refused: 'Hornhoof could not start this check. Try again.' };
  });
  ctx.hub.send(node, { type: 'tools.checking', agentKey: msg.agentKey, ref: msg.ref, ...answer });
}

/* The node says the check command of a step of its own ended. */
export async function closeCheck(ctx: Ctx, node: NodeIdentity, msg: ToolsChecked): Promise<void> {
  const [step] = await ctx.db
    .update(jobs)
    .set({ status: 'done', result: '', finishedAt: new Date() })
    .where(and(eq(jobs.id, msg.jobId), eq(jobs.agentId, msg.agentKey), eq(jobs.kind, 'tools'), eq(jobs.status, 'running'), jobsOf(node, ctx)))
    .returning({ companyId: jobs.companyId });
  if (step) await appendEvent(ctx, { companyId: step.companyId, agentId: msg.agentKey, jobId: msg.jobId, kind: 'tool_result', data: { ok: msg.ok, summary: CHECK_SUMMARY } });
}

/* Steps Hornhoof ended while their node may still run a check command in them: the node hears to stop it now. */
export async function stopSteps(ctx: Ctx, steps: { id: string; subscriptionId: string; nodeId: string | null; builtinMachine: string | null }[]): Promise<void> {
  for (const step of steps) {
    forgetPrivateTurn(ctx.db, step.id);
    const [sub] = await ctx.db.select(only(subscriptions, 'kind')).from(subscriptions).where(eq(subscriptions.id, step.subscriptionId));
    const node = sub ? identityOf(sub, step.nodeId, step.builtinMachine, ownBuiltin(ctx.config)) : null;
    if (node) ctx.hub.send(node, { type: 'job.cancel', jobId: step.id });
  }
}
