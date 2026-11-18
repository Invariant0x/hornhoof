import { headOf } from './failure-recipients.js';
import { passing, passingAttempts, RETRY_MINUTES, type Job } from './failure-records.js';
import type { Failure, FailureKind } from '@hornhoof/protocol';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, jobs, nodes, people, subscriptions, tasks } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { agentState } from '../conversation/state.js';
import { enqueueTurn, insertTurn } from '../conversation/queue.js';
import { limitUntil } from '../conversation/limits.js';
import { onAgent } from '../conversation/line.js';
import { turnAgain } from './again.js';
import { repeatedTurn } from '../conversation/turn-words.js';
import { continuationNote } from './endings.js';
import { operationsWatchers, pickOpsRecipient } from './silent.js';
import { logTurnFact } from './turn-log.js';
import { keptBeforeStart } from '../program-operator/start-holds.js';
import { keepUnheardWords, operatorHandledFailure, sayAgain, tellAgainWentAlong, unheardWords } from '../program-operator/recovery.js';
import { repeatWake } from './wake-state.js';
import { originalPromptOf } from '../conversation/requested-prompt.js';
const UNHEARD_MAX_MINUTES = 240;
type TaskTurn = Parameters<typeof turnAgain>[1];

/* Failures that hold the turn until the plan can take it again: its limit resets, or its owner signs in or passes the
   program's first setup on its machine. */
const HELD = new Set<FailureKind>(['usage_limit', 'auth', 'setup']);
const OWNER_STEP: Partial<Record<FailureKind, string>> = {
  auth: 'The turn waits for the plan owner to sign in on its machine.',
  setup: "The turn waits for the plan owner to pass its program's first setup on its machine, as for a sign-in.",
};

async function alreadySent(ctx: Ctx, caseId: string): Promise<boolean> {
  const [seen] = await ctx.db.select(idOnly(agentEvents)).from(agentEvents).where(sql`${agentEvents.data}->>'failureCase' is not null and ${agentEvents.data}->>'failureCase' = ${caseId}`).limit(1);
  return !!seen;
}

/* Operations hear of a failed turn, a free task watchdog before the head, and the case stays in its message across server restarts. */
export async function notifyFailure(ctx: Ctx, job: Job, text: string, caseId: string, options: { tellHead?: boolean; waitForWatcher?: boolean } = {}): Promise<void> {
  const tellHead = options.tellHead === true;
  if (!job.agentId) return;
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, job.agentId));
  if (!agent) return;
  const head = tellHead ? await headOf(ctx, agent) : null;
  if (head && head.id !== agent.id && !await alreadySent(ctx, `${caseId}:head`)) {
    await sendFailureMessage(ctx, job, head.id, text, `${caseId}:head`);
    await logTurnFact(ctx, job, `${head.name}, the head, was told: ${text}`);
  }
  if (await alreadySent(ctx, caseId)) return;
  const busy = await ctx.db.select({ id: jobs.agentId }).from(jobs).where(and(eq(jobs.status, 'running'), eq(jobs.kind, 'conversation')));
  const to = pickOpsRecipient(await operationsWatchers(ctx, job.companyId), agent.id, new Set(busy.flatMap(j => j.id ? [j.id] : [])));
  if (!to) {
    if (options.waitForWatcher === false) return;
    const [pending] = await ctx.db.select(idOnly(agentEvents)).from(agentEvents).where(sql`${agentEvents.data}->>'operationsPending' is not null and ${agentEvents.data}->>'operationsPending' = ${caseId}`).limit(1);
    if (!pending) await logTurnFact(ctx, job, `No Operations watcher is available. This message waits for one: ${text}`, { operationsPending: caseId, operationsText: text, operationsTellHead: tellHead });
    return;
  }
  if (to.id !== head?.id) await sendFailureMessage(ctx, job, to.id, text, caseId);
  await logTurnFact(ctx, job, `Operations was told: ${text}`, { failureCase: caseId, operations: to.id });
}

async function sendFailureMessage(ctx: Ctx, job: Job, agentId: string, text: string, caseId: string): Promise<void> {
  await enqueueTurn(ctx, { companyId: job.companyId, agentId, prompt: text, createdBy: null, message: { personId: null, text, failureCase: caseId, notification: { source: 'failure', tasks: [], detail: { en: `turn ${job.id}`, ru: `ход ${job.id}` } } } });
}

/* What a retry says of a failure: its first line. A program's screen, which older nodes gave as the reason, says none: a
   line drawn with boxes or blocks, or one that starts with no word, number, bracket or quote. */
export function shortReason(text: string): string {
  const line = text.trim().split('\n', 1)[0]!.replace(/\s+/g, ' ').trim();
  if (!/^[\p{L}\p{N}[{("'`]/u.test(line) || /[\u2500-\u259f]/u.test(line)) return 'the program gave no reason';
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

const failedWhy = (job: Job) => `The last try failed (${job.failure!.kind}): ${shortReason(job.failure!.text)}`;

async function retryTurn(ctx: Ctx, job: Job, at: Date | null, next: string, taskTurn?: TaskTurn): Promise<void> {
  if (!job.agentId) return;
  const [agent] = taskTurn ? [taskTurn.agent] : await ctx.db.select().from(agents).where(eq(agents.id, job.agentId));
  const task = taskTurn?.task;
  if (!agent) return;
  const why = failedWhy(job);
  const note = task ? `${continuationNote(job, task)}\n${why}` : why;
  const prompt = task ? note : `${note}\n\n${await originalPromptOf(ctx, job)}`;
  const id = await onAgent(ctx, agent.id, async () => {
    const [existing] = await ctx.db.select(idOnly(jobs)).from(jobs).where(eq(jobs.continueOf, job.id)).limit(1);
    if (existing) return existing.id;
    const repeated = await repeatedTurn(ctx, job);
    return taskTurn ? turnAgain(ctx, taskTurn, note, { continueOf: job.id }, prompt, at, repeated) : insertTurn(ctx, {
      companyId: job.companyId, agentId: agent.id, prompt, ...repeated, continueOf: job.id, notBefore: at,
    });
  });
  await logTurnFact(ctx, job, `${why}. ${id ? next : 'The agent has no plan to continue.'}`, { continuation: id, at: at?.toISOString() ?? null });
}

const unheardNote = (why: string, words: string) => `${why}. Your program did not record these words, so here they are again:\n\n${words}`;

/* The program never recorded these words, so nothing was lost but time: they go on, whatever the node said of retrying, and
   a turn on a task says them again, for its program knows nothing of them. The wait grows, twice as long after the last
   listed one and up to UNHEARD_MAX_MINUTES, so a program that stays stuck costs a try now and then. A turn of a task that
   no longer waits for it was stopped before this. */
async function retryUnheardWords(ctx: Ctx, job: Job, failure: Failure): Promise<boolean> {
  if (passing(failure) || HELD.has(failure.kind)) return false;
  const unheard = await unheardWords(ctx, job);
  if (!unheard) return false;
  const attempt = await passingAttempts(ctx, job, undefined, f => !passing(f));
  const minutes = RETRY_MINUTES[attempt - 1] ?? Math.min(UNHEARD_MAX_MINUTES, RETRY_MINUTES.at(-1)! * 2 ** (attempt - RETRY_MINUTES.length));
  const at = new Date(+(job.finishedAt ?? new Date()) + minutes * 60_000);
  const why = failedWhy(job);
  const kept = { operatorDelivery: { id: unheard.delivery.id, ordinal: unheard.delivery.ordinal }, operatorRecovery: unheard.incident.id };
  const said = await originalPromptOf(ctx, job);
  const id = await onAgent(ctx, job.agentId!, async () => {
    await tellAgainWentAlong(ctx, job, at, words => unheardNote(why, words));
    return sayAgain(ctx, job, at, unheardNote(why, said), kept);
  });
  await keepUnheardWords(ctx, unheard.incident, id);
  await logTurnFact(ctx, job, id ? `${why}. The program did not record these words. They go with its next turn, not before ${at.toISOString()}.` : `${why}. The program did not record these words, and the agent has no plan to say them again.`, { continuation: id, at: at.toISOString() });
  return true;
}

/* True means this named failure decided the follow-up. Old nodes and crashes on tasks keep the existing path. */
export async function afterFailure(ctx: Ctx, jobId: string): Promise<boolean> {
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, jobId));
  if (job?.status === 'failed' && await keptBeforeStart(ctx, jobId)) return true;
  if (job?.status !== 'failed' || !job.failure || !job.agentId) return false;
  if (await operatorHandledFailure(ctx, jobId)) return true;
  const taskTurn = await failureTaskTurn(ctx, job);
  if (taskTurn === null) return true;
  return decideFailure(ctx, job, job.failure, taskTurn);
}

const decideFailure = async (ctx: Ctx, job: Job, failure: Failure, taskTurn?: TaskTurn): Promise<boolean> =>
  (await retryUnheardWords(ctx, job, failure)) || applyFailure(ctx, job, failure, taskTurn);

async function applyFailure(ctx: Ctx, job: Job, failure: Failure, taskTurn?: TaskTurn): Promise<boolean> {
  if (passing(failure)) await retryPassingFailure(ctx, job, taskTurn);
  else if (HELD.has(failure.kind)) await holdFailedTurn(ctx, job, taskTurn);
  else if (failure.kind === 'crash') {
    await logTurnFact(ctx, job, `The program crashed: ${failure.text}. Hornhoof checks whether it can go on once.`);
    if (job.taskId) return false;
    await continueConversation(ctx, job);
  } else await stopFailedTurn(ctx, job);
  return true;
}

/* Named failures use the same task policy as restart/legacy continuations before any retry or Operations notice. */
async function failureTaskTurn(ctx: Ctx, job: Job): Promise<TaskTurn | null | undefined> {
  if (!job.taskId) return undefined;
  const [found] = await ctx.db.select({ task: tasks, agent: agents }).from(tasks).innerJoin(agents, eq(agents.id, job.agentId!)).where(eq(tasks.id, job.taskId));
  if (!found) return null;
  const taskWake = await repeatWake(ctx.db, { job, ...found }, 'continue');
  return taskWake ? { job, ...found, taskWake } : null;
}

async function retryPassingFailure(ctx: Ctx, job: Job, taskTurn?: TaskTurn): Promise<void> {
  const attempt = await passingAttempts(ctx, job);
  const minutes = RETRY_MINUTES[attempt - 1];
  if (minutes !== undefined) {
    const at = new Date(+(job.finishedAt ?? new Date()) + minutes * 60_000);
    return retryTurn(ctx, job, at, `Retry ${attempt} of 4 waits until ${at.toISOString()}, in the same session.`, taskTurn);
  }
  await logTurnFact(ctx, job, `The turn failed (${job.failure!.kind}): ${job.failure!.text}. All 4 retries were used. The task stays where it is. Ask Operations to find the cause.`);
  await notifyFailure(ctx, job, await failureFacts(ctx, job, 'All 4 retries were used. Find the cause and tell the head when the work can go on.'), `retries:${job.id}`);
}

async function holdFailedTurn(ctx: Ctx, job: Job, taskTurn?: TaskTurn): Promise<void> {
  const [plan] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, job.subscriptionId));
  const reset = limitUntil(plan?.limits ?? null, plan?.limitsUpdatedAt ?? null);
  const next = OWNER_STEP[job.failure!.kind] ?? `The plan holds its turns until its usage limit resets${reset ? ` at ${reset}` : ''}, then this turn goes on.`;
  await retryTurn(ctx, job, null, next, taskTurn);
}

async function continueConversation(ctx: Ctx, job: Job): Promise<void> {
  if (!job.continueOf) return retryTurn(ctx, job, null, 'Hornhoof continues this conversation once in its session.');
  await notifyFailure(ctx, job, await failureFacts(ctx, job, 'The continuation crashed too. Check the program and tell the head how this conversation can go on.'), `crash:${job.id}`, { tellHead: true });
}

async function stopFailedTurn(ctx: Ctx, job: Job): Promise<void> {
  await logTurnFact(ctx, job, `The turn failed (${job.failure!.kind}): ${job.failure!.text}. No retry will run. The head and Operations need to decide how to go on.`);
  await notifyFailure(ctx, job, await failureFacts(ctx, job, 'No retry will run. Check the provider refusal or reduce the work with the head before trying again.'), `failure:${job.id}`, { tellHead: true });
}

async function failureFacts(ctx: Ctx, job: Job, next: string): Promise<string> {
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, job.agentId!));
  const [task] = job.taskId ? await ctx.db.select().from(tasks).where(eq(tasks.id, job.taskId)) : [];
  return `Hornhoof: ${agent?.name}'s turn ${job.id} failed at ${(job.finishedAt ?? job.createdAt).toISOString()} (${job.failure!.kind}): ${job.failure!.text}. ${task ? `Task #${task.number} "${task.title}" stays with its agent.` : 'This conversation has no task.'} ${next}`;
}

/* A sign-in that has not healed while turns wait deserves one message, naming the person who can renew it. */
export async function checkSignInFailures(ctx: Ctx, now = new Date()): Promise<void> {
  const failed = await ctx.db.select({ job: jobs, owner: people.name, plan: subscriptions.label })
    .from(jobs).innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId)).innerJoin(people, eq(people.id, subscriptions.ownerPersonId))
    .innerJoin(nodes, eq(nodes.id, jobs.nodeId)).where(and(eq(jobs.error, 'not_logged_in'), eq(nodes.status, 'needs_login'))).orderBy(desc(jobs.finishedAt));
  const seen = new Set<string>();
  for (const { job, owner, plan } of failed) {
    if (!job.nodeId || seen.has(job.nodeId)) continue;
    seen.add(job.nodeId);
    if (!job.finishedAt || +now - +job.finishedAt < 3_600_000) continue;
    if (await waitsForSignIn(ctx, job.subscriptionId)) await notifyFailure(ctx, job, `Hornhoof: plan "${plan}", owned by ${owner}, still needs a sign-in on node ${job.nodeId} since ${job.finishedAt.toISOString()}. Turns have waited for an hour. Ask ${owner} to sign in on that machine.`, `login:${job.id}`, { waitForWatcher: false });
  }
}

/* An unavailable watcher must not lose a case that will not produce another failed turn. */
export async function sendWaitingFailureAlarms(ctx: Ctx): Promise<void> {
  const pending = await ctx.db.select({ job: jobs, caseId: sql<string>`${agentEvents.data}->>'operationsPending'`, text: sql<string>`${agentEvents.data}->>'operationsText'`, tellHead: sql<boolean>`(${agentEvents.data}->>'operationsTellHead')::boolean` })
    .from(agentEvents).innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
    .where(and(eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->>'operationsPending' is not null`, sql`not exists (select 1 from agent_events sent where sent.data->>'failureCase' is not null and sent.data->>'failureCase' = ${agentEvents.data}->>'operationsPending')`));
  for (const alarm of pending) {
    if (await failureTaskTurn(ctx, alarm.job) === null) {
      await logTurnFact(ctx, alarm.job, 'The delayed Operations notice was skipped because the task no longer waits for this turn.', { failureCase: alarm.caseId, failureSkipped: true });
      continue;
    }
    await notifyFailure(ctx, alarm.job, alarm.text, alarm.caseId, { tellHead: alarm.tellHead });
  }
}

async function waitsForSignIn(ctx: Ctx, subscriptionId: string): Promise<boolean> {
  const waiting = await ctx.db.selectDistinct(only(jobs, 'agentId')).from(jobs).where(and(eq(jobs.subscriptionId, subscriptionId), eq(jobs.status, 'queued')));
  for (const turn of waiting) if (turn.agentId && (await agentState(ctx, turn.agentId)).reason === 'needs_login') return true;
  return false;
}
export { agentFailureState, agentFailureStates } from './failure-records.js';
export type { LastFailure, LastObsolete, FailureState } from './failure-records.js';
export { headOf } from './failure-recipients.js';
