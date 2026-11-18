import type { NodeMessage } from '@hornhoof/protocol';
import { RESTART_AFTER_MS } from '@hornhoof/protocol/map';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, subscriptions } from '../../db/schema.js';
import { conversationOf } from '../conversation/placement.js';
import { onAgent } from '../conversation/line.js';
import { identityOf, ownBuiltin, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { agentProgramState, signInTurn } from './program-state.js';
import { logTurnFact } from './turn-log.js';
import { stopStaleProgram } from './stale-program.js';

type RestartStatus = { allowed: boolean; reason: string | null };
type Job = typeof jobs.$inferSelect;
type Ready = { job: Job; node: NodeIdentity; minutes: number };
type Check = { ready: Ready; reason?: never } | { ready?: never; reason: string; job?: Job };
type Reply = { ok: boolean; reason: string | null; confirmed: boolean };
type Waiting = { node: NodeIdentity; agentId: string; done: (reply: Reply) => void };
const waiting = new WeakMap<Ctx, Map<string, Waiting>>();
const WAIT_MS = 15_000;

async function checkRestart(ctx: Ctx, companyId: string, agentId: string, now: number): Promise<Check> {
  const [found] = await ctx.db.select({ job: jobs, sub: subscriptions }).from(jobs).innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(conversationOf(agentId), eq(jobs.companyId, companyId), eq(jobs.status, 'running'))).limit(1);
  if (!found) return { reason: 'This agent has no running conversation turn.' };
  const { job, sub } = found;
  const refuse = (reason: string): Check => ({ job, reason });
  if (job.restartedAt) return refuse('This turn already had its one program restart. Tell its head if it is still silent.');
  const program = agentProgramState(ctx, job).program;
  if (!program) return refuse('The node has not reported the program state. A safe restart cannot be checked.');
  if (!['thinking', 'retrying'].includes(program.state)) return refuse(`The program is ${program.state}. Only thinking or retrying without a tool or question may be restarted.`);
  if (program.tool) return refuse(`The program has a tool running (${program.tool}). Wait for it to finish.`);
  if (program.signAt === null) return refuse('The node gave no time for the last sign of life. A safe restart cannot be checked.');
  const after = restartAfter(sub.provider);
  if (after === null) return refuse(`Hornhoof never restarts ${sub.provider}; its program must end its own wait. Tell the head if it stays silent.`);
  const quiet = now - signInTurn(program, job)!;
  if (quiet < after) return refuse(`The last sign was ${Math.max(0, Math.floor(quiet / 60_000))} minutes ago. ${sub.provider} needs at least ${after / 60_000} minutes without a sign before a restart.`);
  const node = identityOf(sub, job.nodeId, job.builtinMachine, ownBuiltin(ctx.config));
  if (!node || !ctx.hub.isOnline(node)) return refuse('The turn\'s node is offline. Bring that machine online first.');
  if (!ctx.hub.hasTerminals(node)) return refuse('The turn\'s node has no live terminals. It cannot restart this program.');
  return { ready: { job, node, minutes: Math.floor(quiet / 60_000) } };
}

function restartAfter(provider: string): number | null {
  if (provider === 'claude' || provider === 'codex' || provider === 'kimi' || provider === 'antigravity') return RESTART_AFTER_MS[provider];
  return null;
}

export async function programRestartStatus(ctx: Ctx, companyId: string, agentId: string, now = Date.now()): Promise<RestartStatus> {
  const check = await checkRestart(ctx, companyId, agentId, now);
  return { allowed: !!check.ready, reason: check.reason ?? null };
}

/* The watchdog asks as Operations; an employee of Operations by its name, with whose program. */
const askedBy = (by: string | undefined, whose: string) => (by ? `${by} requested a program restart of ${whose}` : 'Operations requested a program restart');

export async function restartProgram(ctx: Ctx, companyId: string, agentId: string, by?: string): Promise<{ ok: boolean; text: string }> {
  const [target] = await ctx.db.select({ kind: agents.kind, name: agents.name }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  if (target?.kind === 'assistant') return { ok: false, text: "This is a person's own assistant, not an employee of the company: only its owner restarts it." };
  const checked = await onAgent(ctx, agentId, async (): Promise<Check> => {
    const check = await taskRestart(ctx, companyId, agentId, Date.now());
    if (!check.ready) return check;
    const [claimed] = await ctx.db.update(jobs).set({ restartedAt: new Date() }).where(and(eq(jobs.id, check.ready.job.id), eq(jobs.status, 'running'), isNull(jobs.restartedAt))).returning({ id: jobs.id });
    return claimed ? check : { job: check.ready.job, reason: 'This turn already had its one restart or has ended.' };
  });
  if (!checked.ready) {
    if (checked.job) await logTurnFact(ctx, checked.job, `Program restart refused: ${checked.reason}`);
    return { ok: false, text: checked.reason };
  }
  const { job, node, minutes } = checked.ready;
  const note = `Your program was restarted after ${minutes} minutes without a sign from the model. Go on from where you were.`;
  await logTurnFact(ctx, job, `${askedBy(by, target!.name)} after ${minutes} minutes without a sign from the model. Hornhoof waits up to 15 seconds for the node.`);
  const reply = await waitForRestart(ctx, node, job, note);
  const text = await recordRestartReply(ctx, job, reply);
  return { ok: reply.ok, text };
}

async function taskRestart(ctx: Ctx, companyId: string, agentId: string, now: number): Promise<Check> {
  const [job] = await ctx.db.select().from(jobs).where(and(conversationOf(agentId), eq(jobs.companyId, companyId), eq(jobs.status, 'running'))).limit(1);
  if (job && await stopStaleProgram(ctx, job, 'program_restart')) return { reason: 'This task turn is stale and has been stopped.' };
  return checkRestart(ctx, companyId, agentId, now);
}

async function recordRestartReply(ctx: Ctx, job: Job, reply: Reply): Promise<string> {
  if (!reply.ok && reply.confirmed) await ctx.db.update(jobs).set({ restartedAt: null }).where(eq(jobs.id, job.id));
  const text = reply.ok ? `The node restarted the program in the same session.${reply.reason ? ` ${reply.reason}` : ''}` : reply.reason ?? 'The node refused the program restart.';
  await logTurnFact(ctx, job, text, { restart: { ok: reply.ok, confirmed: reply.confirmed, reason: reply.reason } });
  return text;
}

function waitForRestart(ctx: Ctx, node: NodeIdentity, job: Job, note: string): Promise<Reply> {
  const map = waiting.get(ctx) ?? new Map<string, Waiting>();
  waiting.set(ctx, map);
  return new Promise<Reply>(done => {
    const timer = setTimeout(() => end({ ok: false, confirmed: false, reason: 'The node did not answer the restart within 15 seconds. The restart stays counted because it may have happened. Tell the head if the program stays silent.' }), WAIT_MS);
    const end = (reply: Reply) => { clearTimeout(timer); done(reply); };
    map.set(job.id, { node, agentId: job.agentId!, done: end });
    try {
      if (!ctx.hub.send(node, { type: 'agent.restart', agentKey: job.agentId!, jobId: job.id, note })) end({ ok: false, confirmed: true, reason: 'The node could not be reached, so no restart was sent.' });
    } catch {
      end({ ok: false, confirmed: true, reason: 'The restart could not be sent to the node.' });
    }
  }).finally(() => map.delete(job.id));
}

export async function programRestarted(ctx: Ctx, node: NodeIdentity, msg: Extract<NodeMessage, { type: 'agent.restarted' }>): Promise<void> {
  const request = waiting.get(ctx)?.get(msg.jobId);
  const reply = { ok: msg.ok, reason: msg.reason, confirmed: true };
  if (request) {
    if (request.agentId === msg.agentKey && sameNode(request.node, node)) request.done(reply);
    return;
  }
  const [found] = await ctx.db.select({ job: jobs, sub: subscriptions }).from(jobs).innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(eq(jobs.id, msg.jobId), eq(jobs.agentId, msg.agentKey), eq(jobs.kind, 'conversation'), isNotNull(jobs.restartedAt))).limit(1);
  const owner = found && identityOf(found.sub, found.job.nodeId, found.job.builtinMachine, ownBuiltin(ctx.config));
  if (owner && sameNode(owner, node)) await recordRestartReply(ctx, found.job, reply);
}
