import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, programOperatorCases } from '../../db/schema.js';
import { insertTurn } from '../conversation/queue.js';
import { liveSubscription } from '../conversation/placement.js';
import { appendEvent } from '../events/store.js';
import { operationsStaff } from './staff.js';
import { operatorNotification } from './notifications.js';
import { operatorRecoveryHolds } from './recovery-state.js';

const HOLD_WATCH_MS = 5 * 60_000;

type Case = typeof programOperatorCases.$inferSelect;
type Agent = typeof agents.$inferSelect;

/* Who hears of a hold: never the agent on hold, nor one that waits on a hold of its own and would not hear either. */
async function canHear(ctx: Ctx, row: Case, agent: Agent): Promise<boolean> {
  return agent.id !== row.agentId && Boolean(await liveSubscription(ctx, agent.id)) && !await operatorRecoveryHolds(ctx, agent.id);
}

/* The program operator or the head of Operations, who can release it, or the orchestrator, who can too, when neither can hear. */
async function holdRecipient(ctx: Ctx, row: Case): Promise<Agent | null> {
  for (const agent of await operationsStaff(ctx, row.companyId)) if (await canHear(ctx, row, agent)) return agent;
  const [orchestrator] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, row.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return orchestrator && await canHear(ctx, row, orchestrator) ? orchestrator : null;
}

const holdText = (row: Case, name: string, to: Agent) =>
  `Hornhoof: the saved words of ${name} wait on a recovery hold for more than five minutes. Case ${row.id}, turn ${row.jobId}, program ${row.instance}, node ${row.nodeId}, held since ${row.escalatedAt!.toISOString()}. ` +
  `The program did not take them, and Hornhoof could not go on by itself: it is not at an empty prompt, or this is its second try. ` +
  (to.kind === 'orchestrator' ? `Neither the program operator nor the head of Operations can take this now: they are off, without a plan or on a hold of their own. ` : '') +
  `Look at the program with program_screen for employee ${row.agentId}. If it asks something or stands on words a person typed, answer or clear it with program_keys. ` +
  `Then release the hold with program_recovery_release, this case and your reason: that delivers the saved words once. It refuses while the program asks something, runs a tool or holds words a person typed. Never free a hold any other way.`;

export const holdWatchDue = (row: Case, now: Date): boolean => row.escalatedAt !== null && +now - +row.escalatedAt > HOLD_WATCH_MS;

/* What the one who can release a hold is told of it: the words of its turn, and the line people see. */
export type HoldWords = { text: (row: Case, name: string, to: Agent) => string; detail: (name: string) => { en: string; ru: string } };
const wordsOnHold: HoldWords = { text: holdText, detail: name => ({ en: `${name}: words on hold for more than five minutes`, ru: `${name}: слова ждут дольше пяти минут` }) };

/* Called with the agent row locked, once a round for a case on hold. It calls Operations once, and the orchestrator once
   while Operations cannot take it: the turn it queues is no case of its own. */
export async function callOperationsOnHold(ctx: Ctx, row: Case, now: Date, words = wordsOnHold): Promise<void> {
  if (holdWatchDue(row, now) && !row.resolution?.holdCall?.operations) await callOperations(ctx, row, now, words);
}

/* Tells of a hold the one who can release it, in these words, and notes the call on its case. The turn it queued, or none
   when nobody can hear now. Called with the agent row locked. */
export async function callOperations(ctx: Ctx, row: Case, now: Date, words: HoldWords): Promise<string | null> {
  const to = await holdRecipient(ctx, row);
  if (!to || (row.resolution?.holdCall && to.kind === 'orchestrator')) return null;
  const job = await tellOfHold(ctx, row, to, words);
  await ctx.db.update(programOperatorCases).set({ resolution: { ...(row.resolution ?? { outcome: 'held', text: '', image: row.pictureId }), holdCall: { job, to: to.id, at: now.toISOString(), operations: to.kind !== 'orchestrator' } } }).where(eq(programOperatorCases.id, row.id));
  return job;
}

const unavailableHoldWords: HoldWords = {
  text: (row, name, to) =>
    `Hornhoof: ${name}'s queue has been on hold since ${row.escalatedAt!.toISOString()} (case ${row.id}). The program operator was unavailable and the server could not release the hold safely. ` +
    (to.id === row.agentId ? 'Open the employee window and have another responder check the program. ' : `Use program_screen for employee ${row.agentId} to see what blocks it. `) +
    'If the program needs its owner, ask them to clear the screen. When the screen is ready, use program_recovery_release with the case and your reason.',
  detail: name => ({ en: `${name}: recovery hold needs attention`, ru: `${name}: удержание требует внимания` }),
};

async function activeOrchestrator(ctx: Ctx, companyId: string): Promise<Agent | undefined> {
  const [orchestrator] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return orchestrator;
}

async function operationsHead(ctx: Ctx, companyId: string): Promise<Agent | undefined> {
  const staff = await operationsStaff(ctx, companyId);
  return staff.find(agent => agent.kind === 'head');
}

async function notifyResponder(ctx: Ctx, row: Case, to: Agent | undefined, sent: string | undefined): Promise<string | undefined> {
  if (sent || !to) return sent;
  if (to.id !== row.agentId && !await liveSubscription(ctx, to.id)) return undefined;
  return tellOfHold(ctx, row, to, unavailableHoldWords);
}

/* Keep one visible letter per responder with the held case, including after a restart. The caller holds the employee. */
export async function callRecoveryResponders(ctx: Ctx, row: Case): Promise<void> {
  const resolution = row.resolution!;
  const previous = resolution.holdNoticeJobs ?? {};
  if (previous.orchestrator && previous.operations) return;
  const orchestrator = await notifyResponder(ctx, row, await activeOrchestrator(ctx, row.companyId), previous.orchestrator);
  const operations = await notifyResponder(ctx, row, await operationsHead(ctx, row.companyId), previous.operations);
  if (orchestrator === previous.orchestrator && operations === previous.operations) return;
  await ctx.db.update(programOperatorCases).set({ resolution: { ...resolution, holdNoticeJobs: { orchestrator, operations } } }).where(eq(programOperatorCases.id, row.id));
}

async function tellOfHold(ctx: Ctx, row: Case, to: Agent, words: HoldWords): Promise<string> {
  const [target] = await ctx.db.select({ name: agents.name, taskId: jobs.taskId }).from(agents).innerJoin(jobs, eq(jobs.id, row.jobId)).where(eq(agents.id, row.agentId));
  const name = target?.name ?? row.agentId;
  const text = words.text(row, name, to);
  const notification = await operatorNotification(ctx, { companyId: row.companyId, taskId: target?.taskId ?? null }, words.detail(name));
  if (to.id === row.agentId) {
    await appendEvent(ctx, { companyId: row.companyId, agentId: to.id, jobId: row.jobId, kind: 'message', data: { text, notification, turnFact: true } });
    return row.jobId;
  }
  return insertTurn(ctx, { companyId: row.companyId, agentId: to.id, prompt: text, createdBy: null, message: { personId: null, text, notification } });
}
