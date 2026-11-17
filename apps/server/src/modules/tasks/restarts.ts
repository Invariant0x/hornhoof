import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, taskEvents, tasks, type Interruption, type RestartCause } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { enqueueTurn, insertTurn, liveSubscription, NoSubscription, onAgent, turnGoingOn } from '../conversation/queue.js';
import { repeatedTurn as repeatedWords, wordsForTurn } from '../conversation/turn-words.js';
import { turnAgain } from './again.js';
import { when } from './silent.js';
import { logTurnFact } from './turn-log.js';
import { published } from './engine.js';
import { repeatedTurn, type TaskWake } from './wake-state.js';

/* Why a node restarted, in words for the agents and the task's log. */
const CAUSES: Record<RestartCause, string> = {
  server: 'the Hornhoof server started again',
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
type Ended = { job: Job; task: Task; agent: Agent; cut: Cut };

const cutOff = (cut: Cut) => `was cut off at ${when(cut.at)}: ${cut.node.name} restarted, ${CAUSES[cut.cause]}`;

/* Why a turn was cut off as Hornhoof kept it; a node that never said how it came up still names the cause as unknown. */
const keptCut = (job: Job, task: Task): Cut => ({
  ...(job.interruption ?? { cause: 'unknown', at: (job.finishedAt ?? new Date()).toISOString(), node: { id: job.nodeId, name: 'its node' }, task: task.number }),
  job: job.id,
});

/* A turn a node restart cut off on a task, after the node said it: the first runs once more, linked to it, and one that
   was such a retry already is not run a third time: Hornhoof calls Operations' reliability engineer, or its head when the
   engineer is off or missing. The task stays with its agent either way, and its log says what happened. Says whether a
   person in Operations was called, so nothing else runs the turn again. */
export async function afterRestart(ctx: Ctx, jobId: string): Promise<'retried' | 'called' | null> {
  const found = await repeatedTurn(ctx.db, jobId, 'restart');
  if (!found) return null;
  const ended = { ...found, cut: keptCut(found.job, found.task) };
  if (found.job.retryOf) {
    await callOperations(ctx, ended);
    return 'called';
  }
  await retry(ctx, ended);
  return 'retried';
}

async function retry(ctx: Ctx, { job, task, agent, cut, taskWake }: Ended & { taskWake: TaskWake }): Promise<void> {
  const note = `Your last turn on #${task.number} "${task.title}" ${cutOff(cut)}. Hornhoof runs it once more: check what that turn already did, then go on.`;
  /* The recovery of a hold this restart ended may have been first: its turn is the retry. */
  const retried = await onAgent(ctx, agent.id, async () => (await turnGoingOn(ctx, job.id))?.id ?? turnAgain(ctx, { job, task, agent, taskWake }, note, { retryOf: job.id }));
  const again = retried ? `Hornhoof runs it again: retry 1 of ${RETRIES}, turn ${retried}.` : `Hornhoof could not run it again: ${agent.name} has no subscription.`;
  await logCut(ctx, task, agent, cut, `${agent.name}'s turn ${job.id} on #${task.number} ${cutOff(cut)}. ${again}`, { retry: retried ? { job: retried, n: 1, of: RETRIES } : null });
}

/* Operations' reliability engineer who is on and its head who is on, in the order they are called. */
async function operationsOnDuty(ctx: Ctx, companyId: string): Promise<Agent[]> {
  const ops = ctx.db.select(idOnly(departments)).from(departments).where(and(eq(departments.companyId, companyId), eq(departments.templateKey, 'operations')));
  const staff = await ctx.db
    .select()
    .from(agents)
    .where(and(or(inArray(agents.departmentId, ops), inArray(agents.departmentId, ctx.db.select(idOnly(departments)).from(departments).where(inArray(departments.parentId, ops)))), isNull(agents.removedAt), isNull(agents.switchedOffAt)))
    .orderBy(asc(agents.createdAt));
  return [staff.find(a => a.kind === 'worker' && a.roleKey === 'OPS-FIX'), staff.find(a => a.kind === 'head' && a.roleKey === 'OPS-HEAD') ?? staff.find(a => a.kind === 'head')].filter(a => a !== undefined);
}

/* The first on duty with a plan to take the turn. */
async function operationsOnCall(ctx: Ctx, companyId: string): Promise<Agent | null> {
  for (const agent of await operationsOnDuty(ctx, companyId)) if (await liveSubscription(ctx, agent.id)) return agent;
  return null;
}

/* What Operations hears: who, which task, where, both causes and when, and that the work waits for the node. */
function callText(ctx: Ctx, { job, task, agent, cut }: Ended, before: Cut, to: Agent): string {
  const role = agent.roleKey ? ctx.templates.roles.get(agent.roleKey)?.title.en : null;
  const who = role && role !== agent.name ? `${agent.name}, ${role},` : agent.name;
  const where = cut.node.id ? `${cut.node.name} (node ${cut.node.id})` : cut.node.name;
  const next = to.kind === 'head' ? 'tell the orchestrator' : 'tell your head';
  return (
    `Hornhoof: the node under ${agent.name}'s turns restarted twice in a row, so Hornhoof does not run the turn a third time. ` +
    `${who} works on #${task.number} "${task.title}", which stays with them and waits.\n\n` +
    `First, turn ${before.job} ${cutOff(before)}.\nThen its retry, turn ${job.id}, ${cutOff(cut)}.\nNode: ${where}.\n\n` +
    `Find out why the node restarts and set it right. Once it runs steady, ${next} that #${task.number} can go on.`
  );
}

/* The retry was cut off too: no third turn, and Operations hears of it. */
async function callOperations(ctx: Ctx, ended: Ended): Promise<void> {
  const { job, task, agent, cut } = ended;
  const [first] = await ctx.db.select().from(jobs).where(eq(jobs.id, job.retryOf!));
  const before = first ? keptCut(first, task) : { ...cut, cause: 'unknown' as const, job: job.retryOf! };
  const to = await operationsOnCall(ctx, job.companyId);
  if (to) {
    const text = callText(ctx, ended, before, to);
    await enqueueTurn(ctx, { companyId: job.companyId, agentId: to.id, prompt: text, createdBy: null, message: { personId: null, text, notification: { source: 'machine', tasks: [{ id: task.id, number: task.number }], detail: { en: `turn ${job.id}`, ru: `ход ${job.id}` } } } });
  }
  const called = to ? `Hornhoof does not run it a third time and called ${to.name} of Operations to look at the node.` : 'Hornhoof does not run it a third time, and nobody in Operations is on to look at the node.';
  await logCut(ctx, task, agent, cut, `${agent.name}'s turn ${job.id} on #${task.number}, the retry of turn ${before.job}, ${cutOff(cut)}. ${called}`, {
    first: { job: before.job, cause: before.cause, at: before.at },
    called: to ? { id: to.id, name: to.name } : null,
  });
}

/* Whether someone asked for this turn: a person, another agent or the orchestrator. A timer's round and Hornhoof's notices come again by themselves. */
async function someoneAsked(ctx: Ctx, job: Job): Promise<boolean> {
  if (job.createdBy) return true;
  const said = await wordsForTurn(ctx, job.agentId!, job.id);
  return said.some(word => word.personId !== null || ['agent', 'orchestrator'].includes((word.data as { from?: string }).from ?? ''));
}

const cutOffOutsideTask = (job: Job) => `Your last turn ${job.interruption ? `was cut off at ${when(job.interruption.at)}: its node restarted, ${CAUSES[job.interruption.cause]}` : 'was cut off when its node restarted'}. Hornhoof runs it once more: check what that turn already did, then go on.`;

/* A turn someone asked for outside any task goes the same way as one on a task: once more, in its session and as whoever
   asked, and no third time. */
export async function afterRestartOutsideTask(ctx: Ctx, jobId: string): Promise<void> {
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!cutByRestart(job) || !(await someoneAsked(ctx, job))) return;
  if (job.retryOf) return callOperationsOutsideTask(ctx, job);
  const repeated = await repeatedWords(ctx, job);
  await onAgent(ctx, job.agentId, async () => {
    if (!await turnGoingOn(ctx, job.id)) await runOutsideTaskAgain(ctx, job, repeated);
  });
}

const cutByRestart = (job: Job | undefined): job is Job & { agentId: string } => job?.status === 'failed' && job.error === 'machine_restarted' && Boolean(job.agentId && job.prompt);

async function runOutsideTaskAgain(ctx: Ctx, job: Job & { agentId: string }, repeated: Awaited<ReturnType<typeof repeatedWords>>): Promise<void> {
  await insertTurn(ctx, { companyId: job.companyId, agentId: job.agentId, prompt: `${cutOffOutsideTask(job)}\n\n${job.requestedPrompt ?? job.prompt}`, retryOf: job.id, ...repeated }).catch(async (err: unknown) => {
    if (!(err instanceof NoSubscription)) throw err;
    await logTurnFact(ctx, job, 'Hornhoof could not run this turn again: the agent has no plan to continue.');
  });
}

async function callOperationsOutsideTask(ctx: Ctx, job: Job): Promise<void> {
  const to = await operationsOnCall(ctx, job.companyId);
  const [agent] = await ctx.db.select(only(agents, 'name')).from(agents).where(eq(agents.id, job.agentId!));
  if (!to || to.id === job.agentId) return;
  const text = `Hornhoof: the node under ${agent?.name ?? 'an agent'}'s turns restarted twice in a row, so Hornhoof does not run the turn a third time. First turn ${job.retryOf}, then its retry, turn ${job.id}. Find out why the node restarts and set it right.`;
  await enqueueTurn(ctx, { companyId: job.companyId, agentId: to.id, prompt: text, createdBy: null, message: { personId: null, text, notification: { source: 'machine', tasks: [], detail: { en: `turn ${job.id}`, ru: `ход ${job.id}` } } } });
}

/* A line in the task's log; it moves nothing. */
async function logCut(ctx: Ctx, task: Task, agent: Agent, cut: Cut, text: string, more: Record<string, unknown>): Promise<void> {
  const { job, cause, at, node } = cut;
  await ctx.db.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, kind: 'interrupted', agentId: agent.id, text, data: { job, cause, at, node, ...more } });
  published(ctx, task);
}
