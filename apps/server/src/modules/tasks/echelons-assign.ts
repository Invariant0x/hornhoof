import { and, asc, eq, isNull } from 'drizzle-orm';
import type { HandedCandidate } from '@hornhoof/protocol/echelons';
import type { Ctx } from '../../app.js';
import { agents, departments, subscriptions } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import type { Task, Tx } from './engine.js';
import type { Route } from './echelons-store.js';
import { checkedProducer } from './echelons-candidates.js';
import { modelCapability, modelProvider, reviewEligibility, sameChecker, type CheckerIdentity } from './echelons-policy.js';

type Reader = { db: Ctx['db'] | Tx };

export async function departmentHead(db: Reader['db'], task: Task): Promise<string> {
  const [head] = await db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, task.companyId), eq(agents.departmentId, task.departmentId!), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt))).orderBy(asc(agents.createdAt)).limit(1);
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

/* Whoever hands a result in runs a model whose strength is known, so the checker after it can be chosen no weaker. */
export async function producerIdentity(db: Reader['db'], task: Task, agentId: string): Promise<CheckerIdentity> {
  const producer = await agentIdentity(db, task.companyId, agentId);
  if (!producer) throw new ApiError(409, 'conflict', 'The producer model needs a known capability policy before handoff. Select a known model on the employee card; Default has no verified runtime identity.', 'task_invalid');
  return producer;
}

/* Whether the department has somebody to check after the author at a stage that asks for the ability: an employee at
   work outside its teams, as the stages take nobody from a team, and not its head, who checks only where named. */
export async function hasChecker(db: Reader['db'], author: Pick<typeof agents.$inferSelect, 'id' | 'companyId' | 'departmentId'>, ability: string): Promise<boolean> {
  const staff = await db.select({ id: agents.id, kind: agents.kind, skills: agents.skills }).from(agents)
    .where(and(eq(agents.companyId, author.companyId), eq(agents.departmentId, author.departmentId!), isNull(agents.teamId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return staff.some(agent => agent.id !== author.id && agent.kind !== 'head' && agent.skills.includes(ability));
}

/* Why a check is skipped where nobody in its department can do it. */
export const NO_DEPARTMENT_CHECKER = 'no_department_checker';

/* Whether a check of a department other than Development is skipped, as nobody there carries its skill, and the head
   accepts the result in its place. Development keeps every check, a Security the task's risk asks for waits for its
   checker, and so does work its head wrote, as a head accepts no work of its own. */
export async function uncheckable(db: Reader['db'], task: Pick<Task, 'companyId' | 'departmentId' | 'executorAgentId' | 'assigneeAgentId'>, stage: string, ability: string, security: Route['state']['security']): Promise<boolean> {
  if (stage === 'security' && security.required) return false;
  const authorId = task.executorAgentId ?? task.assigneeAgentId;
  if (!task.departmentId || !authorId) return false;
  const [department] = await db.select({ key: departments.templateKey }).from(departments).where(and(eq(departments.id, task.departmentId), eq(departments.companyId, task.companyId)));
  if (!department?.key || department.key === 'development') return false;
  const [author] = await db.select(only(agents, 'kind')).from(agents).where(and(eq(agents.id, authorId), eq(agents.companyId, task.companyId)));
  if (!author || author.kind === 'head') return false;
  return !(await hasChecker(db, { id: authorId, companyId: task.companyId, departmentId: task.departmentId }, ability));
}

/* A head checks only where it is named: picked by itself, it would take a stage from its department's employees. */
function canCheckTask(agent: typeof agents.$inferSelect, task: Task, ability: string, named: string | null): boolean {
  if (named ? agent.id !== named : agent.kind === 'head') return false;
  return !(agent.productId && agent.productId !== task.productId) && agent.skills.includes(ability);
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
export async function checkingIdentity(ctx: Reader, task: Task, route: Route, candidate: HandedCandidate): Promise<CheckerIdentity> {
  const ability = route.state.stage ? route.state.abilities[route.state.stage] : undefined;
  const identity = ability ? await checkerFor(ctx, task, await checkedProducer(ctx.db, task, route, candidate), ability, task.assigneeAgentId) : null;
  if (!identity || !sameChecker(identity, route.state.assignment)) throw new ApiError(409, 'conflict', 'The checking assignment changed. Ask the head to assign it again.', 'task_changed');
  return identity;
}

/* Inside the transaction that commits a checker's result: the card is held until it commits, so a model, subscription
   or ability change either lands before this read and refuses the result, or waits until the result is in. */
export async function heldCheckingIdentity(tx: Tx, task: Task, route: Route, candidate: HandedCandidate): Promise<CheckerIdentity> {
  if (task.assigneeAgentId) await tx.select(idOnly(agents)).from(agents).where(and(eq(agents.id, task.assigneeAgentId), eq(agents.companyId, task.companyId))).for('share');
  return checkingIdentity({ db: tx }, task, route, candidate);
}
