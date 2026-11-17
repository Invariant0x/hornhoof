import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, programOperatorCases } from '../../db/schema.js';
import { insertTurn, liveSubscription } from '../conversation/queue.js';
import { operationsStaff } from './access.js';
import { operatorNotification } from './notifications.js';
import { operatorRecoveryHolds } from './recovery.js';

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

const watchDue = (row: Case, now: Date) => Boolean(row.escalatedAt) && +now - +row.escalatedAt! > HOLD_WATCH_MS && !row.resolution?.holdCall?.operations;

/* What the one who can release a hold is told of it: the words of its turn, and the line people see. */
export type HoldWords = { text: (row: Case, name: string, to: Agent) => string; detail: (name: string) => { en: string; ru: string } };
const wordsOnHold: HoldWords = { text: holdText, detail: name => ({ en: `${name}: words on hold for more than five minutes`, ru: `${name}: слова ждут дольше пяти минут` }) };

/* Called with the agent row locked, once a round for a case on hold. It calls Operations once, and the orchestrator once
   while Operations cannot take it: the turn it queues is no case of its own. */
export async function callOperationsOnHold(ctx: Ctx, row: Case, now: Date, words = wordsOnHold): Promise<void> {
  if (watchDue(row, now)) await callOperations(ctx, row, now, words);
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

async function tellOfHold(ctx: Ctx, row: Case, to: Agent, words: HoldWords): Promise<string> {
  const [target] = await ctx.db.select({ name: agents.name, taskId: jobs.taskId }).from(agents).innerJoin(jobs, eq(jobs.id, row.jobId)).where(eq(agents.id, row.agentId));
  const name = target?.name ?? row.agentId;
  const text = words.text(row, name, to);
  const notification = await operatorNotification(ctx, { companyId: row.companyId, taskId: target?.taskId ?? null }, words.detail(name));
  return insertTurn(ctx, { companyId: row.companyId, agentId: to.id, prompt: text, createdBy: null, message: { personId: null, text, notification } });
}
