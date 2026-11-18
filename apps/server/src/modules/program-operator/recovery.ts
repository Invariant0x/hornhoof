import { and, eq, exists, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { OperatorEvidence } from '@hornhoof/protocol/program-operator';
import type { Ctx } from '../../app.js';
import { agents, jobs, programDeliveries, programOperatorCases, tasks } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { conversationOf, liveSubscription } from '../conversation/placement.js';
import { insertTurn, NoSubscription, turnGoingOn } from '../conversation/queue.js';
import { GONE_ALONG, STOPPED_ON_PURPOSE } from '../conversation/constants.js';
import { repeatedTurn } from '../conversation/turn-words.js';
import type { MessageParty } from '../events/parties.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { repeatWake, type TaskWake } from '../tasks/wake-state.js';
import { operatorTransaction } from './transactions.js';
import { notStep } from '../tools/steps.js';

type Case = typeof programOperatorCases.$inferSelect;
type Job = typeof jobs.$inferSelect;
/* How a hold ended. A closed case proves a recovery only with its continuation: the outcome says which it was. */
type HoldEnd = { outcome: string; text: string; actor?: MessageParty };
const BY_OWNER: HoldEnd = { outcome: 'owner_recovered', text: 'The owner passed the screen; the original words continue once.' };
const AT_PROMPT: HoldEnd = { outcome: 'went_on', text: 'The program stood ready with an empty input; the original words continue once.' };
const PROGRAM_GONE: HoldEnd = { outcome: 'program_gone', text: 'The program that waited for the words is gone; the original words continue once.' };
const RECORDED: HoldEnd = { outcome: 'recorded', text: 'The program already recorded the original words.' };
const LATE_RECEIPT: HoldEnd = { outcome: 'recorded', text: 'The program recorded the original words; no duplicate was sent.' };
const STOPPED: HoldEnd = { outcome: 'stopped', text: 'The turn was stopped, so its words do not go on.' };
const FINISHED: HoldEnd = { outcome: 'finished', text: 'The turn finished after all; its words do not go again.' };
const OWNER_TURN: HoldEnd = { outcome: 'owner_turn', text: 'The existing owner turn continues recovery. No second assignment was injected; the original assignment remains in the journal.' };
const NOT_AWAITED: HoldEnd = { outcome: 'not_awaited', text: 'The task no longer waits for these words, so they do not go on.' };
const BY_ITSELF = ['went_on', 'program_gone'];
const stoppedOnPurpose = (job: Job) => STOPPED_ON_PURPOSE.includes(job.error ?? '');
const agentRemoved = async (ctx: Ctx, row: Case) => Boolean((await ctx.db.select(only(agents, 'removedAt')).from(agents).where(eq(agents.id, row.agentId)))[0]?.removedAt);
const deliveryOf = async (ctx: Ctx, row: Case) => row.deliveryId ? (await ctx.db.select().from(programDeliveries).where(eq(programDeliveries.id, row.deliveryId)))[0] : undefined;
const programLeft = (delivery: typeof programDeliveries.$inferSelect) => delivery.outcome === 'cancelled' || delivery.outcome === 'not_taken';

export async function runsATurn(ctx: Ctx, agentId: string): Promise<boolean> {
  const [running] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'running'), notStep)).limit(1);
  return Boolean(running);
}

export async function operatorRecoveryHolds(ctx: Ctx, agentId: string): Promise<boolean> {
  return recoveryHolds(ctx, eq(programOperatorCases.agentId, agentId));
}

export async function operatorHandledFailure(ctx: Ctx, jobId: string): Promise<boolean> {
  return recoveryHolds(ctx, eq(programOperatorCases.jobId, jobId));
}

async function recoveryHolds(ctx: Ctx, scope: SQL): Promise<boolean> {
  const [held] = await ctx.db.select(idOnly(programOperatorCases)).from(programOperatorCases).where(and(scope, eq(programOperatorCases.recoveryHold, true))).limit(1);
  return Boolean(held);
}

/* The case of a failed turn whose words the program never recorded, with what they went out by. A stopped turn says nothing
   of words, and one recorded after all has nothing left to deliver. */
export async function unheardWords(ctx: Ctx, job: Pick<Job, 'id' | 'error'>): Promise<{ incident: Case; delivery: typeof programDeliveries.$inferSelect } | null> {
  if (job.error === 'cancelled' || job.error === 'stale') return null;
  const rows = await ctx.db.select({ incident: programOperatorCases, delivery: programDeliveries }).from(programOperatorCases)
    .innerJoin(programDeliveries, eq(programDeliveries.jobId, programOperatorCases.jobId))
    .where(and(eq(programOperatorCases.jobId, job.id), eq(programDeliveries.kind, 'assignment'), isNull(programDeliveries.receiptAt)));
  return rows.find(({ incident }) => incident.reason === 'assignment_unrecorded' || incident.evidence.some(fact => fact.reason === 'assignment_unrecorded')) ?? null;
}

/* The turn that says the unheard words again, for a late receipt to find. */
export async function keepUnheardWords(ctx: Ctx, incident: Case, continuationJobId: string | null): Promise<void> {
  await ctx.db.update(programOperatorCases).set({ continuationJobId }).where(eq(programOperatorCases.id, incident.id));
}

/* A task's wake as it stands now, for going out set the task to work and the wake it went with is out of date. Null when the
   task no longer waits for it. */
async function wakeNow(ctx: Ctx, job: Job): Promise<{ taskWake?: TaskWake } | null> {
  if (!job.taskId) return {};
  const [found] = await ctx.db.select({ task: tasks, agent: agents }).from(tasks).innerJoin(agents, eq(agents.id, job.agentId!)).where(eq(tasks.id, job.taskId));
  const taskWake = found ? await repeatWake(ctx.db, { job, ...found }, 'continue') : null;
  return taskWake ? { taskWake } : null;
}

/* The one turn that says a turn's words again, in a turn of their own and not in one that waits on the task: that one may be
   out of date by its time, and has words of its own to go on with when a late receipt ends this one. None when the task no
   longer waits for them or the agent has no plan. The caller holds the agent. */
export async function sayAgain(ctx: Ctx, job: Job, at: Date, prompt: string, data: object = {}): Promise<string | null> {
  const [existing] = await ctx.db.select(idOnly(jobs)).from(jobs).where(eq(jobs.continueOf, job.id)).limit(1);
  if (existing) return existing.id;
  const wake = await wakeNow(ctx, job);
  if (!wake) return null;
  const repeated = await repeatedTurn(ctx, job);
  repeated.repeated.data = { ...(repeated.repeated.data as object), ...data, ...wake };
  try {
    return await insertTurn(ctx, { companyId: job.companyId, agentId: job.agentId!, prompt, taskId: job.taskId ?? undefined, ...repeated, continueOf: job.id, notBefore: at });
  } catch (err) {
    if (err instanceof NoSubscription) return null;
    throw err;
  }
}

const wentAlong = (ctx: Ctx, job: Job) => job.agentId && job.startedAt && job.finishedAt
  ? ctx.db.select().from(jobs).where(and(conversationOf(job.agentId), eq(jobs.status, 'done'), eq(jobs.result, GONE_ALONG), gte(jobs.startedAt, job.startedAt), lte(jobs.startedAt, job.finishedAt)))
  : Promise.resolve([]);

/* The tasks that went out inside an unheard turn were not heard with it. Each is told again on its own. */
export async function tellAgainWentAlong(ctx: Ctx, job: Job, at: Date, say: (words: string) => string): Promise<void> {
  for (const gone of await wentAlong(ctx, job)) await sayAgain(ctx, gone, at, say(gone.prompt));
}

/* The caller holds the agent row. The old job stays failed; one new owner continuation takes its pending words. */
export async function acceptOperatorRecovery(ctx: Ctx, frame: OperatorEvidence): Promise<void> {
  if (frame.type !== 'program.recovery_ready') return;
  const [row] = await ctx.db.select().from(programOperatorCases).where(and(eq(programOperatorCases.id, frame.case), eq(programOperatorCases.agentId, frame.agentKey), eq(programOperatorCases.jobId, frame.jobId!), eq(programOperatorCases.instance, frame.instance))).for('update');
  if (!row?.recoveryHold) return;
  if (frame.owner !== false) return continueRecovery(ctx, row, BY_OWNER);
  if (!await wentOnBefore(ctx, row)) await continueRecovery(ctx, row, AT_PROMPT);
}

/* Words go on by themselves once, along every turn they went on in since: one let through by hand between counts too, as
   a program that took none of them takes the next no better. When that did not help, a person or Operations looks: the
   hold stays. */
async function wentOnBefore(ctx: Ctx, row: Case): Promise<boolean> {
  const seen = new Set<string>();
  for (let turns = [row.jobId]; turns.length; ) {
    for (const turn of turns) seen.add(turn);
    const made = await ctx.db.select({ jobId: programOperatorCases.jobId, outcome: sql<string | null>`${programOperatorCases.resolution}->>'outcome'` }).from(programOperatorCases).where(inArray(programOperatorCases.continuationJobId, turns));
    if (made.some(({ outcome }) => BY_ITSELF.includes(outcome ?? ''))) return true;
    turns = [...new Set(made.map(({ jobId }) => jobId))].filter(turn => !seen.has(turn));
  }
  return false;
}

/* What ends a hold with nobody looking: a stop, a turn that finished after all, or a program that is gone, whose words no
   question or tool of it can stand in the way of. The caller holds the agent row. */
export async function settleOperatorHold(ctx: Ctx, row: Case): Promise<void> {
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
  if (!job) return;
  if (stoppedOnPurpose(job) || await agentRemoved(ctx, row)) return finishRecovery(ctx, row, null, STOPPED);
  if (job.status === 'done') return finishRecovery(ctx, row, null, FINISHED);
  const delivery = await deliveryOf(ctx, row);
  if (delivery && programLeft(delivery) && !await wentOnBefore(ctx, row)) await continueRecovery(ctx, row, PROGRAM_GONE);
}

/* The node says the program of these words ended. */
export async function settleDeliveryHolds(ctx: Ctx, deliveryId: string): Promise<void> {
  const rows = await ctx.db.select().from(programOperatorCases).where(and(eq(programOperatorCases.deliveryId, deliveryId), eq(programOperatorCases.recoveryHold, true)));
  for (const row of rows) await settleOperatorHold(ctx, row);
}

/* agent.start is emitted only by an owner opening a view whose physical program is gone. */
export async function resumeOperatorProcess(ctx: Ctx, agentId: string, nodeId: string): Promise<boolean> {
  return operatorTransaction(ctx, async (tx, inside) => {
    await tx.select(idOnly(agents)).from(agents).where(eq(agents.id, agentId)).for('update');
    const rows = await tx.select().from(programOperatorCases).where(and(eq(programOperatorCases.agentId, agentId), eq(programOperatorCases.nodeId, nodeId), eq(programOperatorCases.recoveryHold, true))).for('update');
    if (!rows.length) return false;
    for (const row of rows) await continueRecovery(inside, row, BY_OWNER);
    const [continued] = await tx.select({ id: programOperatorCases.continuationJobId }).from(programOperatorCases).where(and(inArray(programOperatorCases.id, rows.map(row => row.id)), eq(programOperatorCases.recoveryHold, false), isNotNull(programOperatorCases.continuationJobId)));
    return Boolean(continued?.id);
  });
}

export async function continueRecovery(ctx: Ctx, row: Case, end: HoldEnd): Promise<void> {
  const [original] = await ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
  const delivery = await deliveryOf(ctx, row);
  if (!original || !recoverableJob(original) || !delivery) return;
  if (await agentRemoved(ctx, row)) return finishRecovery(ctx, row, null, STOPPED);
  if (delivery.receiptAt) return finishRecovery(ctx, row, null, RECORDED);
  if (!await runsATurn(ctx, row.agentId)) await wordsGoOn(ctx, row, original, delivery, end);
}

/* A retry a node restart queued takes these words on already, as the same words must not run twice; one somebody stopped
   leaves them stopped. The tasks that went out inside the unheard turn were not heard either way, and a retry says only the
   turn's own words. With no turn to take them on, a hold stays while the agent has no plan, as the watch then calls
   Operations, and ends when the task no longer waits for them. */
async function wordsGoOn(ctx: Ctx, row: Case, original: Job, delivery: typeof programDeliveries.$inferSelect, end: HoldEnd): Promise<void> {
  const next = await turnGoingOn(ctx, original.id);
  if (next?.error === 'cancelled') return finishRecovery(ctx, row, null, STOPPED);
  const at = new Date();
  const continuationJobId = next?.id ?? await sayAgain(ctx, original, at, original.requestedPrompt ?? original.prompt, { operatorDelivery: { id: delivery.id, ordinal: delivery.ordinal }, operatorRecovery: row.id });
  await tellAgainWentAlong(ctx, original, at, words => words);
  if (continuationJobId) return finishRecovery(ctx, row, continuationJobId, end);
  if (await liveSubscription(ctx, row.agentId)) await finishRecovery(ctx, row, null, NOT_AWAITED);
}

function recoverableJob(job: Job): boolean {
  return job.status === 'failed' && !stoppedOnPurpose(job);
}

async function finishRecovery(ctx: Ctx, row: Case, continuationJobId: string | null, { outcome, text, actor }: HoldEnd): Promise<void> {
  await ctx.db.update(programOperatorCases).set({ status: 'resolved', recoveryHold: false, continuationJobId, revision: row.revision + 1, resolution: { outcome, text, image: row.pictureId, ...(actor ? { actor } : {}) } }).where(eq(programOperatorCases.id, row.id));
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
  await logTurnFact(ctx, job!, text, { notification: { source: 'program_operator', tasks: [] }, operatorRecovery: row.id, continuation: continuationJobId });
}

/* The words a case is about were recorded: those of its own delivery, or, for a case first opened for something else, those
   of its turn. */
const wordsRecorded = (ctx: Ctx) => exists(ctx.db.select(idOnly(programDeliveries)).from(programDeliveries).where(and(isNotNull(programDeliveries.receiptAt),
  or(eq(programDeliveries.id, programOperatorCases.deliveryId), and(eq(programDeliveries.jobId, programOperatorCases.jobId), eq(programDeliveries.kind, 'assignment'))))));

/* A late receipt always wins over an unsent child, including after readiness already resolved its case. */
export async function reconcileRecoveryReceipts(ctx: Ctx, agentId: string): Promise<void> {
  const recorded = await ctx.db.select().from(programOperatorCases).where(and(eq(programOperatorCases.agentId, agentId), wordsRecorded(ctx)));
  const [waiting] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'queued'), isNotNull(jobs.continueOf))).limit(1);
  for (const incident of recorded) {
    if (waiting) await cancelRepeats(ctx, incident);
    if (incident.recoveryHold) await finishRecovery(ctx, incident, incident.continuationJobId, LATE_RECEIPT);
  }
}

/* What the program recorded late includes the tasks that went out inside that turn, whatever became of the turn's own repeat.
   Only an unheard turn repeats a task that went along, so a turn that merely goes on from recorded words stays. */
async function cancelRepeats(ctx: Ctx, incident: Case): Promise<void> {
  const [carrier] = await ctx.db.select().from(jobs).where(eq(jobs.id, incident.jobId));
  const along = carrier ? await wentAlong(ctx, carrier) : [];
  const repeats = along.length ? await ctx.db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, incident.agentId), inArray(jobs.continueOf, along.map(gone => gone.id)))) : [];
  const first = [...(incident.continuationJobId ? [incident.continuationJobId] : []), ...repeats.map(repeat => repeat.id)];
  if (first.length) await cancelContinuations(ctx, incident.agentId, first);
}

/* The words may be on a later retry by the time the first try's receipt comes, and retries do not stop: whatever still waits
   to repeat them ends, all in one walk. It meets each turn once, so a chain that loops ends too. The retry of a cut turn stays:
   that the program recorded the words does not mean it did them before the node went. */
async function cancelContinuations(ctx: Ctx, agentId: string, first: string[]): Promise<void> {
  const chain = sql`with recursive repeats(id) as (select id from jobs where ${inArray(jobs.id, first)} union select j.id from jobs j join repeats r on j.continue_of = r.id where j.agent_id = ${agentId}) select id from repeats`;
  await ctx.db.update(jobs).set({ status: 'failed', error: 'cancelled', result: 'The program already recorded these words.', finishedAt: new Date() }).where(and(eq(jobs.status, 'queued'), isNotNull(jobs.continueOf), sql`${jobs.id} in (${chain})`));
}

export async function adoptOperatorOwnerTurn(ctx: Ctx, agentId: string, jobId: string, nodeId: string): Promise<void> {
  await operatorTransaction(ctx, async (tx, inside) => {
    await tx.select(idOnly(agents)).from(agents).where(eq(agents.id, agentId)).for('update');
    const [typed] = await tx.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.agentId, agentId), eq(jobs.nodeId, nodeId), eq(jobs.status, 'running')));
    if (!typed) return;
    const rows = await tx.select().from(programOperatorCases).where(and(eq(programOperatorCases.agentId, agentId), eq(programOperatorCases.nodeId, nodeId)));
    for (const row of rows) {
      const [child] = row.continuationJobId ? await tx.select().from(jobs).where(eq(jobs.id, row.continuationJobId)) : [];
      if (!row.recoveryHold && child?.status !== 'queued') continue;
      /* The retry of a cut turn stays: the owner's own words do not do what that turn was to do. */
      if (child) await tx.update(jobs).set({ status: 'failed', error: 'cancelled', result: 'The owner already started a turn.', finishedAt: new Date() }).where(and(eq(jobs.id, child.id), eq(jobs.status, 'queued'), isNull(jobs.retryOf)));
      await tx.update(jobs).set({ continueOf: row.jobId }).where(eq(jobs.id, typed.id));
      await finishRecovery(inside, row, typed.id, OWNER_TURN);
    }
  });
}
