import { and, asc, eq, isNull } from 'drizzle-orm';
import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import type { Ctx } from '../../app.js';
import { agents, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import type { Task, Tx } from './engine.js';
import type { Route } from './echelons-store.js';
import { modelCapability, modelProvider, reviewEligibility, sameChecker, type CheckerIdentity } from './echelons-policy.js';

type Reader = { db: Ctx['db'] | Tx };

export async function departmentHead(db: Reader['db'], task: Task): Promise<string> {
  const [head] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, task.companyId), eq(agents.departmentId, task.departmentId!), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt))).orderBy(asc(agents.createdAt)).limit(1);
  if (!head) throw new ApiError(409, 'conflict', 'The department needs a head to receive this stage result.', 'task_invalid');
  return head.id;
}

export async function agentIdentity(db: Reader['db'], companyId: string, agentId: string): Promise<CheckerIdentity | null> {
  const [row] = await db.select({ id: agents.id, subscriptionId: subscriptions.id, model: agents.model, provider: subscriptions.provider }).from(agents)
    .innerJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), eq(subscriptions.companyId, agents.companyId), isNull(subscriptions.removedAt)))
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!row) return null;
  const capability = modelCapability(row.model, row.provider);
  return capability === null ? null : { agentId: row.id, subscriptionId: row.subscriptionId, model: row.model, provider: modelProvider(row.provider), capability };
}

function canCheckTask(agent: typeof agents.$inferSelect, task: Task, ability: string, named: string | null): boolean {
  return !(named && agent.id !== named) && !(agent.productId && agent.productId !== task.productId) && agent.skills.includes(ability);
}

/* Selection never changes a subscription, model, employee or skill card. */
export async function checkerFor(ctx: Reader, task: Task, producer: CheckerIdentity, ability: string, named: string | null): Promise<CheckerIdentity | null> {
  const staff = await ctx.db.select().from(agents).where(and(eq(agents.companyId, task.companyId), eq(agents.departmentId, task.departmentId!), isNull(agents.teamId), isNull(agents.removedAt), isNull(agents.switchedOffAt))).orderBy(asc(agents.createdAt));
  const eligible: CheckerIdentity[] = [];
  for (const agent of staff) {
    if (!canCheckTask(agent, task, ability, named)) continue;
    const identity = await agentIdentity(ctx.db, task.companyId, agent.id);
    if (identity && !reviewEligibility(producer, identity)) eligible.push(identity);
  }
  return eligible.find(identity => identity.provider !== producer.provider) ?? eligible[0] ?? null;
}

/* A verdict and a repair use the same live assignment, including its ability and subscription. */
export async function checkingIdentity(ctx: Reader, task: Task, route: Route, candidate: EchelonCandidate): Promise<CheckerIdentity> {
  const ability = route.state.stage === 'tests' ? 'dev-test-environment' : route.state.stage === 'review' ? 'dev-review-diff' : route.state.stage === 'security' ? 'dev-security-review' : 'dev-cleanup';
  const identity = await checkerFor(ctx, task, candidate.producedBy, ability, task.assigneeAgentId);
  if (!identity || !sameChecker(identity, route.state.assignment)) throw new ApiError(409, 'conflict', 'The checking assignment changed. Ask the head to assign it again.', 'task_changed');
  return identity;
}

/* Inside the transaction that commits a checker's result: the card is held until it commits, so a model, subscription
   or ability change either lands before this read and refuses the result, or waits until the result is in. */
export async function heldCheckingIdentity(tx: Tx, task: Task, route: Route, candidate: EchelonCandidate): Promise<CheckerIdentity> {
  if (task.assigneeAgentId) await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, task.assigneeAgentId), eq(agents.companyId, task.companyId))).for('share');
  return checkingIdentity({ db: tx }, task, route, candidate);
}
