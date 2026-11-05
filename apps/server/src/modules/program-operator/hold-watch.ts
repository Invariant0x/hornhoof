import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, programOperatorCases } from '../../db/schema.js';
import { insertTurn, liveSubscription } from '../conversation/queue.js';
import { operationsOnDuty } from '../tasks/restarts.js';
import { operatorNotification } from './notifications.js';
import { operatorRecoveryHolds } from './recovery.js';

export const HOLD_WATCH_MS = 5 * 60_000;

type Case = typeof programOperatorCases.$inferSelect;
type Agent = typeof agents.$inferSelect;

/* Who hears of a hold: never the agent on hold, nor one that waits on a hold of its own and would not hear either. */
async function holdRecipient(ctx: Ctx, row: Case): Promise<Agent | null> {
  const [orchestrator] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, row.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  for (const agent of [...await operationsOnDuty(ctx, row.companyId), ...(orchestrator ? [orchestrator] : [])]) {
    if (agent.id !== row.agentId && await liveSubscription(ctx, agent.id) && !await operatorRecoveryHolds(ctx, agent.id)) return agent;
  }
  return null;
}

const holdText = (row: Case, name: string) =>
  `Hornhoof: the saved words of ${name} wait on a recovery hold for more than five minutes. Case ${row.id}, turn ${row.jobId}, program ${row.instance}, node ${row.nodeId}, held since ${row.escalatedAt!.toISOString()}. ` +
  `The program did not take them, and Hornhoof could not go on by itself: it is not at an empty prompt, or this is its second try. If it is ready, release the hold with program_recovery_release, this case and your reason: that delivers the saved words once. It refuses while the program asks something, runs a tool or holds other words, and those stay with its owner.`;

/* Called with the agent row locked, once a round for a case on hold. It calls once: the turn it queues is no case of its own. */
export async function callOperationsOnHold(ctx: Ctx, row: Case, now: Date): Promise<void> {
  if (!row.escalatedAt || +now - +row.escalatedAt <= HOLD_WATCH_MS || row.resolution?.holdCall) return;
  const to = await holdRecipient(ctx, row);
  if (!to) return;
  const [target] = await ctx.db.select({ name: agents.name, taskId: jobs.taskId }).from(agents).innerJoin(jobs, eq(jobs.id, row.jobId)).where(eq(agents.id, row.agentId));
  const name = target?.name ?? row.agentId;
  const text = holdText(row, name);
  const notification = await operatorNotification(ctx, { companyId: row.companyId, taskId: target?.taskId ?? null }, { en: `${name}: words on hold for more than five minutes`, ru: `${name}: слова ждут дольше пяти минут` });
  const job = await insertTurn(ctx, { companyId: row.companyId, agentId: to.id, prompt: text, createdBy: null, message: { personId: null, text, notification } });
  await ctx.db.update(programOperatorCases).set({ resolution: { ...(row.resolution ?? { outcome: 'held', text: '', image: row.pictureId }), holdCall: { job, to: to.id, at: now.toISOString() } } }).where(eq(programOperatorCases.id, row.id));
}
