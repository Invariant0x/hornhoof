import { OperatorNodeMessage, PROGRAM_OPERATOR_ROLE } from '@hornhoof/protocol/program-operator';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, departments, jobs, programOperatorCases, subscriptions } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { limitUntil } from '../conversation/queue.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { escalateCase, expireOperatorCases, queueEscalation, syncOperatorCases } from './cases.js';
import { callOperationsOnHold } from './hold-watch.js';
import { acceptOperatorRecovery, settleOperatorHold } from './recovery.js';
import { operatorTransaction } from './transactions.js';
import { reconcileOperatorFallbacks } from './requeue.js';

const needsHealth = or(eq(programOperatorCases.status, 'open'), eq(programOperatorCases.recoveryHold, true), and(eq(programOperatorCases.status, 'escalated'), isNull(programOperatorCases.escalationJobId)));

/* Deadlines and missing wake recipients are durable; neither process restart nor an empty outbox loses the case. */
export async function checkOperatorHealth(ctx: Ctx, now = new Date()): Promise<void> {
  await expireOperatorCases(ctx, now);
  await reconcileOperatorFallbacks(ctx, now);
  const entries = await ctx.db.selectDistinct(only(programOperatorCases, 'agentId')).from(programOperatorCases).where(needsHealth);
  for (const { agentId } of entries) {
    await operatorTransaction(ctx, async (tx, inside) => {
      await tx.select(idOnly(agents)).from(agents).where(eq(agents.id, agentId)).for('update');
      const rows = await tx.select().from(programOperatorCases).where(and(eq(programOperatorCases.agentId, agentId), needsHealth)).for('update');
      for (const row of rows) await restoreCase(inside, row, now);
    });
    await syncOperatorCases(ctx, agentId, now);
  }
}

async function restoreCase(ctx: Ctx, row: typeof programOperatorCases.$inferSelect, now: Date): Promise<void> {
  if (row.status === 'open' && !await operatorAvailable(ctx, row)) await escalateCase(ctx, row, 'operator_unavailable', now);
  if (row.status === 'escalated' && !row.escalationJobId) await queueEscalation(ctx, row);
  if (!row.recoveryHold) return;
  const evidence = await ctx.db.select(only(agentEvents, 'data')).from(agentEvents).where(and(eq(agentEvents.agentId, row.agentId), sql`${agentEvents.data}->'operatorEvidence'->>'type' = 'program.recovery_ready'`, sql`${agentEvents.data}->'operatorEvidence'->>'case' = ${row.id}`));
  for (const fact of evidence) {
    const data = fact.data as { operatorEvidence?: unknown };
    const parsed = OperatorNodeMessage.safeParse(data.operatorEvidence);
    if (parsed.success && parsed.data.type === 'program.recovery_ready') await acceptOperatorRecovery(ctx, parsed.data);
  }
  await watchHold(ctx, row.id, now);
}

async function watchHold(ctx: Ctx, id: string, now: Date): Promise<void> {
  const stillHeld = async () => (await ctx.db.select().from(programOperatorCases).where(and(eq(programOperatorCases.id, id), eq(programOperatorCases.recoveryHold, true))))[0];
  const held = await stillHeld();
  if (held) await settleOperatorHold(ctx, held);
  const waiting = await stillHeld();
  if (waiting) await callOperationsOnHold(ctx, waiting, now);
}

async function operatorAvailable(ctx: Ctx, row: typeof programOperatorCases.$inferSelect): Promise<boolean> {
  if (!row.operatorAgentId || !row.operatorJobId) return false;
  const [selected] = await ctx.db.select({ agent: agents, job: jobs, plan: subscriptions }).from(agents)
    .innerJoin(jobs, eq(jobs.id, row.operatorJobId)).innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId))
    .innerJoin(departments, eq(departments.id, agents.departmentId))
    .where(and(eq(agents.id, row.operatorAgentId), eq(departments.companyId, row.companyId), eq(departments.templateKey, 'operations')));
  if (!selected) return false;
  const { agent, job, plan } = selected;
  if (!availableAgent(agent, row.companyId) || !availableTurn(job, agent.id) || !availablePlan(plan, row.companyId)) return false;
  const [stuck] = await ctx.db.select(idOnly(programOperatorCases)).from(programOperatorCases).where(and(eq(programOperatorCases.agentId, agent.id), or(eq(programOperatorCases.status, 'open'), eq(programOperatorCases.recoveryHold, true)))).limit(1);
  return !stuck;
}

function availableAgent(agent: typeof agents.$inferSelect, companyId: string): boolean {
  return agent.roleKey === PROGRAM_OPERATOR_ROLE && !agent.removedAt && !agent.switchedOffAt && agent.companyId === companyId;
}

function availableTurn(job: typeof jobs.$inferSelect, agentId: string): boolean {
  return job.agentId === agentId && (job.status === 'queued' || job.status === 'running');
}

function availablePlan(plan: typeof subscriptions.$inferSelect, companyId: string): boolean {
  return plan.companyId === companyId && !plan.removedAt && plan.status === 'ready' && !limitUntil(plan.limits, plan.limitsUpdatedAt);
}

export async function restoreOperatorNode(ctx: Ctx, node: NodeIdentity): Promise<void> {
  if (node.kind !== 'node') return;
  const entries = await ctx.db.selectDistinct(only(programOperatorCases, 'agentId')).from(programOperatorCases).where(eq(programOperatorCases.nodeId, node.nodeId));
  for (const { agentId } of entries) await syncOperatorCases(ctx, agentId);
}
