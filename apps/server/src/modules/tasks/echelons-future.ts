import type { EchelonStage } from '@hornhoof/protocol/echelons';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents } from '../../db/schema.js';
import { enqueueTurn } from '../conversation/queue.js';
import { agentIdentity, checkerFor, stageStaff } from './echelons-assign.js';
import { currentHanded } from './echelons-candidates.js';
import { reviewEligibility, type CheckerIdentity } from './echelons-policy.js';
import type { Route } from './echelons-store.js';
import { refuse, type Task } from './engine.js';
import { stuckRecipient } from './stuck-route.js';

type Reader = Pick<Ctx, 'db'>;
type Agent = typeof agents.$inferSelect;
export type UnfilledStage = { task: Pick<Task, 'id' | 'number'>; stage: EchelonStage };

/* A future check follows the latest immutable output, or the planned author before any output exists. */
async function futureProducer(ctx: Reader, task: Task, route: Route): Promise<CheckerIdentity | null> {
  if (route.state.candidateId) return (await currentHanded(ctx.db, task, route)).producedBy;
  const authorId = task.executorAgentId ?? route.state.stages.find(step => step.stage === 'development')?.ownerAgentId;
  return authorId ? agentIdentity(ctx.db, task.companyId, authorId) : null;
}

/* Naming an owner narrows the same selection used by an automatic replacement. */
export async function futureOwner(ctx: Reader, task: Task, route: Route, stage: EchelonStage, named: string | null, roleKey?: string | null): Promise<string | null> {
  const ability = route.state.abilities[stage];
  if (!ability) return (await stageStaff(ctx.db, task, named, roleKey))[0]?.id ?? null;
  const producer = await futureProducer(ctx, task, route);
  if (!producer) {
    if (named) throw refuse(409, 'task_invalid', 'The planned producer needs a known model capability before a future checker can be assigned.');
    return null;
  }
  if (named) await requireIndependentChecker(ctx, task, producer, named);
  return (await checkerFor(ctx, task, producer, ability, named, roleKey))?.agentId ?? null;
}

async function requireIndependentChecker(ctx: Reader, task: Task, producer: CheckerIdentity, named: string): Promise<void> {
  const checker = await agentIdentity(ctx.db, task.companyId, named);
  const reason = checker ? reviewEligibility(producer, checker) : null;
  if (reason) throw refuse(409, 'task_invalid', reason === 'self_review' ? 'The producer cannot check its own result.' : 'The checker model is weaker than the producer model.');
}

/* Only pending stages after the current one move; current work and completed history keep their own rules. */
export async function replaceFutureOwners(ctx: Reader, task: Task, route: Route, leaving: Agent): Promise<{ state: Route['state']; set: Partial<Task>; missing: UnfilledStage[] }> {
  const stages = [...route.state.stages];
  const current = stages.findIndex(step => step.stage === route.state.stage);
  const set: Partial<Task> = {}, missing: UnfilledStage[] = [];
  for (let i = current + 1; i < stages.length; i++) {
    const step = stages[i]!;
    if (step.status !== 'pending' || step.ownerAgentId !== leaving.id) continue;
    const ownerAgentId = await futureOwner(ctx, { ...task, ...set }, { ...route, state: { ...route.state, stages } }, step.stage, null, leaving.roleKey);
    stages[i] = { ...step, ownerAgentId, reason: ownerAgentId ? null : 'eligible_owner_required' };
    if (!ownerAgentId) missing.push({ task, stage: step.stage });
    if (step.stage === 'development' && !route.state.candidateId) set.executorAgentId = ownerAgentId;
  }
  return { state: { ...route.state, stages }, set, missing };
}

/* One ordinary letter survives task wake filtering and lists all future stages left without an owner. */
export async function notifyUnfilledStages(ctx: Ctx, leaving: Agent, missing: UnfilledStage[]): Promise<void> {
  if (!missing.length) return;
  const recipient = await stuckRecipient(ctx.db, leaving, leaving);
  if (!recipient) return;
  const text = `${leaving.name} is no longer available. No eligible employee of the same role can take these future stages:\n${missing.map(item => `#${item.task.number}: ${item.stage}`).join('\n')}\nAssign each future stage with update_task, stage and ownerAgentId.`;
  const tasks = [...new Map(missing.map(item => [item.task.id, { id: item.task.id, number: item.task.number }])).values()];
  await enqueueTurn(ctx, { companyId: leaving.companyId, agentId: recipient.id, prompt: text, createdBy: null, message: { personId: null, text, notification: { source: 'switched', tasks } } });
}

export async function removedEmployee(ctx: Reader, companyId: string, agentId: string): Promise<Agent | null> {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId), isNotNull(agents.removedAt)));
  return agent ?? null;
}
