import { and, asc, desc, eq, isNotNull, isNull, notLike } from 'drizzle-orm';
import type { HandedCandidate } from '@hornhoof/protocol/echelons';
import type { Ctx } from '../../app.js';
import { agentFallbacks, agents, departments, subscriptions, turnTokens } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import type { Task, Tx } from './state.js';
import type { Route } from './route-records.js';
import { checkedProducer, lineageProducers } from './echelons-candidates.js';
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
  const model = row.model || (await ranOn(db, row.id, row.subscriptionId));
  const capability = model ? modelCapability(model, row.provider) : null;
  return capability === null ? null : { agentId: row.id, subscriptionId: row.subscriptionId, model: model!, provider: modelProvider(row.provider), capability };
}

/* An employee on its program's Default runs whatever model that program picks, and its node tells Hornhoof which model each
   turn ran on in the program's own words: the newest turn on the plan it is on now that names one is that model. Claude
   Code names its own notices "<synthetic>", which is no model. None named yet leaves the strength unknown. */
async function ranOn(db: Reader['db'], agentId: string, subscriptionId: string): Promise<string | null> {
  const [turn] = await db.select({ model: turnTokens.model }).from(turnTokens)
    .where(and(eq(turnTokens.agentId, agentId), eq(turnTokens.subscriptionId, subscriptionId), isNotNull(turnTokens.model), notLike(turnTokens.model, '<%>')))
    .orderBy(desc(turnTokens.at)).limit(1);
  return turn?.model ?? null;
}

/* Whoever hands a result in runs a model whose strength is known, so the checker after it can be chosen no weaker. */
export async function producerIdentity(db: Reader['db'], task: Task, agentId: string): Promise<CheckerIdentity> {
  const producer = await agentIdentity(db, task.companyId, agentId);
  if (!producer) throw new ApiError(409, 'conflict', 'The producer model needs a known capability policy before handoff. Select a known model on the employee card; on Default it counts as the model its program last ran on, and none it named yet has one.', 'task_invalid');
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

/* The same available, scoped staff supply initial checkers and replacements for future stages. */
export async function stageStaff(db: Reader['db'], task: Task, named: string | null, roleKey?: string | null): Promise<(typeof agents.$inferSelect)[]> {
  const rows = await db.select({ agent: agents }).from(agents)
    .innerJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), eq(subscriptions.companyId, agents.companyId), isNull(subscriptions.removedAt)))
    .where(and(eq(agents.companyId, task.companyId), eq(agents.departmentId, task.departmentId!), isNull(agents.teamId), isNull(agents.removedAt), isNull(agents.switchedOffAt))).orderBy(asc(agents.createdAt));
  return rows.map(row => row.agent).filter(agent =>
    (named ? agent.id === named : agent.kind === 'worker') &&
    !(agent.productId && agent.productId !== task.productId) &&
    (roleKey === undefined || agent.roleKey === roleKey));
}

const NO_ONE: ReadonlySet<string> = new Set();

/* Review checks the whole change, so nobody who produced a candidate of its lineage takes it, the original developer
   included. The other stages check the producer of what they received. */
export const keptFromReview = (db: Reader['db'], task: Task, stage: string | null, candidate: HandedCandidate | null): Promise<ReadonlySet<string>> =>
  stage === 'review' ? lineageProducers(db, task, candidate) : Promise.resolve(NO_ONE);

export const PRODUCER_REVIEW = 'Whoever produced a candidate of this task cannot review it. The head assigns an independent reviewer.';

/* Selection never changes a subscription, model, employee or skill card. */
export async function checkerFor(ctx: Reader, task: Task, producer: CheckerIdentity, ability: string, named: string | null, roleKey?: string | null, excluded = NO_ONE): Promise<CheckerIdentity | null> {
  const staff = await stageStaff(ctx.db, task, named, roleKey);
  const eligible: CheckerIdentity[] = [];
  for (const agent of staff) {
    if (excluded.has(agent.id) || !canCheckTask(agent, task, ability, named)) continue;
    const identity = await agentIdentity(ctx.db, task.companyId, agent.id);
    if (identity && !reviewEligibility(producer, identity)) eligible.push(identity);
  }
  return eligible.find(identity => identity.provider !== producer.provider) ?? eligible[0] ?? null;
}

async function securityOrigin(db: Reader['db'], task: Task, producer?: CheckerIdentity | null): Promise<CheckerIdentity | null> {
  if (producer) return producer;
  const authorId = task.executorAgentId ?? task.assigneeAgentId;
  return authorId ? agentIdentity(db, task.companyId, authorId) : null;
}

/* Assigns an eligible Security checker as soon as the task's risk requires Security, so it does not wait after submission. */
async function initialSecurityOwner(db: Reader['db'], task: Task, ability: string, producer?: CheckerIdentity | null): Promise<string | null> {
  if (!task.departmentId) return null;
  const origin = await securityOrigin(db, task, producer);
  const checker = origin ? await checkerFor({ db }, task, origin, ability, null) : null;
  return checker ? checker.agentId : null;
}

export async function populateSecurityOwner(db: Reader['db'], task: Task, state: Route['state'], producer?: CheckerIdentity | null): Promise<Route['state']> {
  const step = state.security.required ? state.stages.find(item => item.stage === 'security') : undefined;
  if (!step || step.ownerAgentId || !state.abilities.security) return state;
  const ownerAgentId = await initialSecurityOwner(db, task, state.abilities.security, producer);
  return ownerAgentId ? { ...state, stages: state.stages.map(item => item.stage === 'security' ? { ...item, ownerAgentId } : item) } : state;
}

const CHANGED_ASSIGNMENT = 'The checking assignment changed. Ask the head to assign it again.';

function pinnedChecker(task: Task, route: Route): { identity: CheckerIdentity; ability: string } {
  const { stage, phase, assignment } = route.state;
  const ability = stage ? route.state.abilities[stage] : undefined;
  const step = route.state.stages.find(item => item.stage === stage);
  if (!assignment || !ability || phase !== 'active' || step?.status !== 'active'
    || step.ownerAgentId !== assignment.agentId || task.assigneeAgentId !== assignment.agentId) {
    throw new ApiError(409, 'conflict', CHANGED_ASSIGNMENT, 'task_changed');
  }
  return { identity: assignment, ability };
}

/* The fallback row and the card are written together. A move by hand has no such proof. */
async function fellBack(db: Reader['db'], task: Task, pinned: CheckerIdentity, live: CheckerIdentity): Promise<boolean> {
  if (pinned.subscriptionId === live.subscriptionId) return false;
  const [fallback] = await db.select({ homeModel: agentFallbacks.homeModel }).from(agentFallbacks)
    .where(and(eq(agentFallbacks.companyId, task.companyId), eq(agentFallbacks.agentId, pinned.agentId),
      eq(agentFallbacks.homeSubscriptionId, pinned.subscriptionId), eq(agentFallbacks.subscriptionId, live.subscriptionId)));
  /* Default is stored as an empty setting. The pin holds the model reported by its previous turn. */
  return fallback !== undefined && (fallback.homeModel === '' || fallback.homeModel === pinned.model);
}

function requireIndependentChecker(task: Task, route: Route, agentId: string): void {
  if (agentId === task.executorAgentId) throw new ApiError(409, 'conflict', 'The original producer cannot check this task.', 'task_invalid');
  const at = route.state.stages.findIndex(step => step.stage === route.state.stage);
  const earlier = route.state.stages.slice(0, at).some(step => step.status === 'complete' && step.ownerAgentId === agentId
    && ['review', 'cleanup', 'security', 'tests'].includes(step.stage));
  if (earlier) throw new ApiError(409, 'conflict', 'This employee already checked an earlier stage of the task. The head must assign another checker.', 'task_invalid');
}

async function requireEligiblePlan(db: Reader['db'], task: Task, pinned: CheckerIdentity, live: CheckerIdentity, producer: CheckerIdentity): Promise<void> {
  const rule = reviewEligibility(producer, live);
  if (!rule && sameChecker(live, pinned)) return;
  if (!(await fellBack(db, task, pinned, live))) throw new ApiError(409, 'conflict', CHANGED_ASSIGNMENT, 'task_changed');
  if (rule === 'weaker_model') throw new ApiError(409, 'conflict', 'The checker fell back to a weaker model than the producer. The head must assign another checker.', 'task_changed');
  if (rule) throw new ApiError(409, 'conflict', CHANGED_ASSIGNMENT, 'task_changed');
}

/* A verdict and a repair use the live identity of the same checking owner. A saved automatic fallback may outlive its pin. */
export async function checkingIdentity(ctx: Reader, task: Task, route: Route, candidate: HandedCandidate): Promise<CheckerIdentity> {
  const { identity: assignment, ability } = pinnedChecker(task, route);
  const owner = assignment.agentId;
  if ((await keptFromReview(ctx.db, task, route.state.stage, candidate)).has(owner)) throw new ApiError(409, 'conflict', PRODUCER_REVIEW, 'task_invalid');
  requireIndependentChecker(task, route, owner);
  const [member] = await stageStaff(ctx.db, task, owner);
  const identity = member && canCheckTask(member, task, ability, owner) ? await agentIdentity(ctx.db, task.companyId, owner) : null;
  if (!identity) throw new ApiError(409, 'conflict', CHANGED_ASSIGNMENT, 'task_changed');
  await requireEligiblePlan(ctx.db, task, assignment, identity, await checkedProducer(ctx.db, task, route, candidate));
  return identity;
}

/* Hold the card until the result commits, so a concurrent change cannot invalidate the checked identity. */
export async function heldCheckingIdentity(tx: Tx, task: Task, route: Route, candidate: HandedCandidate, expected?: CheckerIdentity): Promise<CheckerIdentity> {
  if (task.assigneeAgentId) await tx.select(idOnly(agents)).from(agents).where(and(eq(agents.id, task.assigneeAgentId), eq(agents.companyId, task.companyId))).for('share');
  const live = await checkingIdentity({ db: tx }, task, route, candidate);
  if (expected && !sameChecker(live, expected)) throw new ApiError(409, 'conflict', CHANGED_ASSIGNMENT, 'task_changed');
  return live;
}
