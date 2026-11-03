import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, taskEvents, tasks, type Interruption, type RestartCause } from '../../db/schema.js';
import { enqueueTurn, insertTurn, liveSubscription, NoSubscription, onAgent } from '../conversation/queue.js';
import { appendEvent } from '../events/store.js';
import { published } from './engine.js';

/* Why a node restarted, in words for the agents and the task's log. */
const CAUSES: Record<RestartCause, string> = {
  update: 'Hornhoof updated it',
  machine: 'the machine under it started again',
  container: 'its container was created again, as an update of Hornhoof or a new install does',
  program: 'its program started again in the same container, after a crash or a restart of the container',
  connection: 'the connection to it broke and the turn did not reach it',
  unknown: 'the cause is unknown',
};

const RETRIES = 1;

type Job = typeof jobs.$inferSelect;
type Task = typeof tasks.$inferSelect;
type Agent = typeof agents.$inferSelect;
/* What the task's log keeps of a turn a node restart cut off. */
type Cut = Interruption & { job: string };

const when = (at: string) => `${at.slice(0, 16).replace('T', ' ')} UTC`;
const cutOff = (cut: Cut) => `was cut off at ${when(cut.at)}: ${cut.node.name} restarted, ${CAUSES[cut.cause]}`;

/* A turn a node restart cut off on a task, after the node said it: the first runs once more, linked to it, and one that
   was such a retry already is not run a third time: Hornhoof calls Operations' reliability engineer, or its head when the
   engineer is off or missing. The task stays with its agent either way, and its log says what happened. Says whether a
   person in Operations was called, so nothing else runs the turn again. */
export async function afterRestart(ctx: Ctx, jobId: string): Promise<'retried' | 'called' | null> {
  const [found] = await ctx.db.select({ job: jobs, task: tasks, agent: agents }).from(jobs).innerJoin(tasks, eq(tasks.id, jobs.taskId)).innerJoin(agents, eq(agents.id, jobs.agentId)).where(eq(jobs.id, jobId));
  if (!found || found.job.error !== 'machine_restarted') return null;
  const { job, task, agent } = found;
  /* A node that never said how it came up, or a turn cut off another way, still names the cause as unknown. */
  const cut: Cut = { ...(job.interruption ?? { cause: 'unknown', at: (job.finishedAt ?? new Date()).toISOString(), node: { id: job.nodeId, name: 'its node' }, task: task.number }), job: job.id };
  if (job.retryOf) {
    await callOperations(ctx, { job, task, agent, cut });
    return 'called';
  }
  await retry(ctx, { job, task, agent, cut });
  return 'retried';
}

/* The turn once more, or the turn that already waits on the task, which takes its place. */
async function retry(ctx: Ctx, { job, task, agent, cut }: { job: Job; task: Task; agent: Agent; cut: Cut }): Promise<void> {
  const note = `Your last turn on #${task.number} "${task.title}" ${cutOff(cut)}. Hornhoof runs it once more: check what that turn already did, then go on.`;
  const retried = await onAgent(ctx, agent.id, async () => {
    const [waiting] = await ctx.db.select().from(jobs).where(and(eq(jobs.agentId, agent.id), eq(jobs.taskId, task.id), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt)).limit(1);
    if (waiting) {
      await ctx.db.update(jobs).set({ retryOf: job.id, prompt: `${note}\n\n${waiting.prompt}` }).where(eq(jobs.id, waiting.id));
      return waiting.id;
    }
    const prompt = `${note}\n\n${job.prompt}`;
    const id = await insertTurn(ctx, { companyId: job.companyId, agentId: agent.id, prompt, createdBy: null, taskId: task.id, retryOf: job.id }).catch((err: unknown) => {
      if (err instanceof NoSubscription) return null;
      throw err;
    });
    if (id) await appendEvent(ctx, { companyId: job.companyId, agentId: agent.id, jobId: id, kind: 'message', data: { text: prompt, task: { id: task.id, number: task.number } } });
    return id;
  });
  const again = retried ? `Hornhoof runs it again: retry 1 of ${RETRIES}, turn ${retried}.` : `Hornhoof could not run it again: ${agent.name} has no subscription.`;
  await logCut(ctx, task, agent, cut, `${agent.name}'s turn ${job.id} ${cutOff(cut)}. ${again}`, { retry: retried ? { job: retried, n: 1, of: RETRIES } : null });
}

/* Operations' reliability engineer who is on, or else its head who is on: either needs a plan to take the turn. */
async function operationsOnCall(ctx: Ctx, companyId: string): Promise<Agent | null> {
  const ops = ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.companyId, companyId), eq(departments.templateKey, 'operations')));
  const staff = await ctx.db
    .select()
    .from(agents)
    .where(and(or(inArray(agents.departmentId, ops), inArray(agents.departmentId, ctx.db.select({ id: departments.id }).from(departments).where(inArray(departments.parentId, ops)))), isNull(agents.removedAt), isNull(agents.switchedOffAt)))
    .orderBy(asc(agents.createdAt));
  const able = async (a: Agent | undefined) => (a && (await liveSubscription(ctx, a.id)) ? a : null);
  return (await able(staff.find(a => a.kind === 'worker' && a.roleKey === 'OPS-FIX'))) ?? (await able(staff.find(a => a.kind === 'head')));
}

/* The retry was cut off too: no third turn, and Operations hears who, which task, where, both causes and when. */
async function callOperations(ctx: Ctx, { job, task, agent, cut }: { job: Job; task: Task; agent: Agent; cut: Cut }): Promise<void> {
  const [first] = await ctx.db.select().from(jobs).where(eq(jobs.id, job.retryOf!));
  const before: Cut = { ...(first?.interruption ?? { cause: 'unknown', at: (first?.finishedAt ?? new Date()).toISOString(), node: cut.node, task: task.number }), job: job.retryOf! };
  const target = await operationsOnCall(ctx, job.companyId);
  const role = agent.roleKey ? ctx.templates.roles.get(agent.roleKey)?.title.en : null;
  const next = target?.kind === 'head' ? 'tell the orchestrator' : 'tell your head';
  const text =
    `Hornhoof: the node under ${agent.name}'s turns restarted twice in a row, so Hornhoof does not run the turn a third time. ` +
    `${agent.name}${role && role !== agent.name ? `, ${role},` : ''} works on #${task.number} "${task.title}", which stays with them and waits.\n\n` +
    `First, turn ${before.job} ${cutOff(before)}.\nThen its retry, turn ${job.id}, ${cutOff(cut)}.\n` +
    `Node: ${cut.node.name}${cut.node.id ? ` (node ${cut.node.id})` : ''}.\n\n` +
    `Find out why the node restarts and set it right. Once it runs steady, ${next} that #${task.number} can go on.`;
  if (target) await enqueueTurn(ctx, { companyId: job.companyId, agentId: target.id, prompt: text, createdBy: null, message: { personId: null, text } });
  const called = target ? `Hornhoof does not run it a third time and called ${target.name} of Operations to look at the node.` : 'Hornhoof does not run it a third time, and nobody in Operations is on to look at the node.';
  await logCut(ctx, task, agent, cut, `${agent.name}'s turn ${job.id}, the retry of turn ${before.job}, ${cutOff(cut)}. ${called}`, {
    first: { job: before.job, cause: before.cause, at: before.at },
    called: target ? { id: target.id, name: target.name } : null,
  });
}

/* A line in the task's log; it moves nothing. */
async function logCut(ctx: Ctx, task: Task, agent: Agent, cut: Cut, text: string, more: Record<string, unknown>): Promise<void> {
  const { job, cause, at, node } = cut;
  await ctx.db.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, kind: 'interrupted', agentId: agent.id, text, data: { job, cause, at, node, ...more } });
  published(ctx, task);
}
