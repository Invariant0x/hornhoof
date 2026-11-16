import { randomUUID } from 'node:crypto';
import type { Notification, NotificationSource } from '@hornhoof/protocol';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { people, requests, taskEvents, tasks, turns } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { CLOSED, note, refuse, type Actor, type Request, type Task, type Tx } from './engine.js';
import { recordWaitNotice } from './wait-notices.js';
import { lastOfSource, requestSourceKey, type TaskWait } from './wait-state.js';

/* A goal in danger, as a head or the orchestrator says it: one open episode for a goal, on the question that opened it. Neither
   a text nor a date opens one, an answer does not end one, and only someone who may say so records that it is over. Only this
   and the summary of a closed turn reach the CEO by themselves. */

export type GoalImpact = 'at_risk' | 'missed';
export type GoalRef = { kind: 'task' | 'turn'; id: string };
export type NewGoal = { ref: GoalRef; impact: GoalImpact };
type Turn = typeof turns.$inferSelect;

/* What the question that opens an episode keeps of it. */
export const goalColumns = (goal: NewGoal | undefined) => (goal
  ? { goalRefKind: goal.ref.kind, goalRefId: goal.ref.id, goalEpisodeId: randomUUID(), goalImpact: goal.impact, goalRevision: 1, goalState: 'open' as const }
  : {});

export async function openGoal(db: Ctx['db'] | Tx, companyId: string, ref: GoalRef): Promise<Request | null> {
  const [open] = await db.select().from(requests).where(and(eq(requests.companyId, companyId), eq(requests.goalRefKind, ref.kind), eq(requests.goalRefId, ref.id), eq(requests.goalState, 'open')));
  return open ?? null;
}

async function activeCeo(tx: Tx, companyId: string): Promise<string | null> {
  const [ceo] = await tx.select(idOnly(people)).from(people).where(and(eq(people.companyId, companyId), eq(people.isOwner, true), eq(people.status, 'active')));
  return ceo?.id ?? null;
}

const IMPACT_WORDS: Record<GoalImpact, string> = { at_risk: 'at risk', missed: 'missed' };

/* Hornhoof says these itself: no one is named as saying them. */
const ownWords = (source: NotificationSource, text: string, on: Notification['tasks']) => ({ personId: null, text, notification: { source, tasks: on } });

/* The CEO's card for this revision of the episode, in the write that made it. It says where to look, not what was said. */
export async function alertGoal(tx: Tx, task: Task, request: Request, wait: TaskWait): Promise<void> {
  const personId = await activeCeo(tx, task.companyId);
  if (!personId || !request.goalEpisodeId) return;
  const revision = request.goalRevision!;
  const words = `A head or the orchestrator says a goal is ${IMPACT_WORDS[request.goalImpact!]}. See the question on #${task.number}.`;
  await recordWaitNotice(tx, {
    companyId: task.companyId, agentId: null, personId, dedupKey: `goal:${request.goalEpisodeId}:${revision}`,
    waitId: wait.id, generation: wait.generation, level: wait.level, purpose: `goal_risk:${revision}`, routeRevision: wait.routeRevision,
    guard: { tasks: [], goal: { requestId: request.id, episodeId: request.goalEpisodeId, revision } },
    message: ownWords('goal_risk', words, [{ id: task.id, number: task.number }]),
  });
}

/* The episode is reported again. Nothing new is nothing new, and it never gets better by being said again: only at risk becoming
   missed is a new revision, with one new alert. true: it changed. */
export async function reviseGoal(ctx: Pick<Ctx, 'db'>, actor: Actor, episode: Request, impact: GoalImpact): Promise<boolean> {
  return ctx.db.transaction(async tx => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, episode.taskId)).for('update');
    const [request] = await tx.select().from(requests).where(eq(requests.id, episode.id)).for('update');
    const worse = request!.goalState === 'open' && request!.goalImpact === 'at_risk' && impact === 'missed';
    if (!worse) {
      await note(tx, task!, { kind: 'comment', actor, text: 'The goal risk was reported again, with nothing new.', data: { goal: { episodeId: request!.goalEpisodeId, revision: request!.goalRevision } } });
      return false;
    }
    const [revised] = await tx.update(requests).set({ goalImpact: 'missed', goalRevision: request!.goalRevision! + 1 }).where(eq(requests.id, request!.id)).returning();
    await note(tx, task!, { kind: 'comment', actor, text: 'The goal at risk is now missed.', data: { goal: { episodeId: revised!.goalEpisodeId, revision: revised!.goalRevision } } });
    const wait = await lastOfSource(tx, task!, 'person', requestSourceKey(request!.id));
    if (wait) await alertGoal(tx, task!, revised!, wait);
    return true;
  });
}

/* Someone who may say so records that the goal is out of danger. A later threat opens a new episode. */
export async function resolveGoal(ctx: Pick<Ctx, 'db'>, actor: Actor, companyId: string, ref: GoalRef, why: string): Promise<Request> {
  return ctx.db.transaction(async tx => {
    const episode = await openGoal(tx, companyId, ref);
    if (!episode) throw refuse(409, 'task_invalid', 'No goal risk is open on this.');
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, episode.taskId)).for('update');
    const [resolved] = await tx.update(requests).set({ goalState: 'resolved', goalRevision: episode.goalRevision! + 1 }).where(and(eq(requests.id, episode.id), eq(requests.goalState, 'open'))).returning();
    if (!resolved) throw refuse(409, 'task_changed', 'This goal risk changed meanwhile.');
    await note(tx, task!, { kind: 'comment', actor, text: `The goal is out of danger: ${why}`, data: { goal: { episodeId: resolved.goalEpisodeId, revision: resolved.goalRevision, state: 'resolved' } } });
    return resolved;
  });
}

const SHOWN = 50;

/* What a task's own record says came of it. A task closed with no word on it is not called a success. */
function resultLine(task: Task, recorded: Set<string>): string {
  const status = CLOSED.includes(task.status) ? task.status : `left ${task.status}`;
  return `#${task.number} ${status}: ${recorded.has(task.id) ? 'result recorded' : 'no result recorded'}`;
}

async function summaryWords(tx: Tx, turn: Turn, roots: Task[]): Promise<string> {
  const reports = await tx.select({ taskId: taskEvents.taskId }).from(taskEvents).where(and(inArray(taskEvents.taskId, roots.map(t => t.id)), inArray(taskEvents.kind, ['report', 'submitted'])));
  const recorded = new Set(reports.map(r => r.taskId));
  /* Of the work the release took in, and of the release itself, as a goal about the turn is said on work going into it. */
  const danger = await tx.select({ number: tasks.number, impact: requests.goalImpact }).from(requests).innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(and(eq(requests.goalState, 'open'), or(eq(tasks.turnId, turn.id), and(eq(requests.goalRefKind, 'turn'), eq(requests.goalRefId, turn.id)))));
  const more = roots.length > SHOWN ? [`and ${roots.length - SHOWN} more`] : [];
  return [
    `Turn ${turn.number} is over. Its goal: ${turn.goal}`,
    [...roots.slice(0, SHOWN).map(t => resultLine(t, recorded)), ...more].join('\n'),
    danger.length ? `Goal risks still open: ${danger.map(d => `#${d.number} ${IMPACT_WORDS[d.impact!]}`).join(', ')}.` : 'No goal risk is open.',
  ].join('\n\n');
}

/* What the CEO hears of a turn that ran, once for each closing: what is on record of its work, and nothing guessed. */
export async function recordTurnSummary(tx: Tx, turn: Turn): Promise<void> {
  const personId = await activeCeo(tx, turn.companyId);
  const all = await tx.select().from(tasks).where(eq(tasks.turnId, turn.id)).orderBy(asc(tasks.number));
  const roots = all.filter(t => t.parentId === null);
  if (!personId || !roots.length) return;
  await recordWaitNotice(tx, {
    companyId: turn.companyId, agentId: null, personId, dedupKey: `turn_summary:${turn.id}:${turn.closedAt!.getTime()}`,
    guard: { tasks: [], turn: { id: turn.id, taskId: roots[0]!.id } },
    message: ownWords('turn_summary', await summaryWords(tx, turn, roots), roots.slice(0, SHOWN).map(t => ({ id: t.id, number: t.number }))),
  });
}
