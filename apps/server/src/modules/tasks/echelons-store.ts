import { type Route } from './route-records.js';
import { turnCleanupDefault } from './cleanup-policy.js';
import type { EchelonStep } from '@hornhoof/protocol/echelons';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { departments, pipelines, taskRoutes } from '../../db/schema.js';
import { catalogRoute, type StageRoute } from '../templates/load.js';
import { refuse, type Task, type Tx } from './state.js';
import { validScopePaths } from './review-schema.js';
import { throughEchelons } from './turnkey.js';
import { NO_DEPARTMENT_CHECKER, populateSecurityOwner, uncheckable } from './echelons-assign.js';
type RouteInput = { resultKind?: 'code' | 'document' | 'coordination'; architectAgentId?: string; reviewerAgentId?: string; securityAgentId?: string; testsAgentId?: string; cleanup?: boolean; paths?: string[] };

export function checkedScopePaths(paths: string[] = []): string[] {
  if (!validScopePaths(paths)) throw refuse(400, 'task_invalid', 'Repository scope contains an invalid path pattern.');
  return paths;
}

function routeStep(name: EchelonStep['stage'], current: EchelonStep['stage'], ownerAgentId: string | null = null): EchelonStep {
  return { stage: name, status: name === current ? 'active' : 'pending', ownerAgentId, reason: null, inputCandidateId: null, candidateId: null };
}

function architectureStep(task: Task, archOwner: string | null, collapsed: boolean, current: EchelonStep['stage']): EchelonStep {
  const step = routeStep('architecture', current, archOwner);
  if (task.small) return { ...step, status: 'skipped', reason: 'small_task', ownerAgentId: null };
  return collapsed ? { ...step, status: 'skipped', reason: 'same_executor', ownerAgentId: null } : step;
}

function securityState(task: Task, input: RouteInput, current: EchelonStep['stage']): { step: EchelonStep; security: Route['state']['security'] } {
  const required = task.riskClass !== null && task.riskClass !== 'none';
  const step = routeStep('security', current, input.securityAgentId ?? null);
  if (!required) Object.assign(step, { status: 'skipped', reason: 'no_declared_risk' });
  return { step, security: { required, reason: required ? task.riskClass : null, addedBy: required ? task.createdByAgentId : null } };
}

const NO_SECURITY: Route['state']['security'] = { required: false, reason: null, addedBy: null };

/* A stage the route of the department lacks takes no owner, and Cleanup cannot be asked for where there is none. */
function requireStages(task: Task, plan: StageRoute, input: RouteInput, cleanup: boolean): void {
  const asked: [EchelonStep['stage'], unknown][] = [['architecture', input.architectAgentId], ['review', input.reviewerAgentId], ['security', input.securityAgentId], ['tests', input.testsAgentId], ['cleanup', cleanup]];
  const missing = asked.find(([stage, wanted]) => wanted && !plan.stages.some(step => step.stage === stage));
  if (missing) throw refuse(409, 'task_invalid', `The route of this department has no ${missing[0]} stage for #${task.number}.`);
}

/* A document has no commit to run or to tidy, so Tests and Cleanup are not among its stages. */
const documentStages = (plan: StageRoute): StageRoute => ({ ...plan, stages: plan.stages.filter(step => step.stage !== 'tests' && step.stage !== 'cleanup') });
/* The skill of the first check a document meets in a department, or null where its route checks none. */
export const documentCheck = (plan: StageRoute): string | null => documentStages(plan).stages.find(step => step.ability)?.ability ?? null;

function initialCodeStage(plan: StageRoute, small: boolean, collapsed: boolean): 'architecture' | 'development' {
  return plan.stages.some(step => step.stage === 'architecture') && !small && !collapsed ? 'architecture' : 'development';
}

function stageAbilities(plan: StageRoute): Route['state']['abilities'] {
  return Object.fromEntries(plan.stages.flatMap(step => step.ability ? [[step.stage, step.ability]] : []));
}

/* The stages the route runs as one-shot calls, kept only where it has some. */
function oneShotStages(plan: StageRoute): Pick<Route['state'], 'oneShot'> {
  const marked = plan.stages.flatMap(step => step.oneShot ? [[step.stage, step.oneShot] as const] : []);
  return marked.length ? { oneShot: Object.fromEntries(marked) } : {};
}

function developmentOwner(task: Task, resultKind: 'code' | 'document'): string | null {
  return resultKind === 'document' ? (task.executorAgentId ?? task.assigneeAgentId) : task.executorAgentId;
}

function stageStepMap(
  task: Task,
  input: RouteInput,
  cleanup: boolean,
  stage: EchelonStep['stage'],
  archOwner: string | null,
  devOwner: string | null,
  collapsed: boolean,
  security: EchelonStep,
): Record<EchelonStep['stage'], EchelonStep | null> {
  return {
    architecture: architectureStep(task, archOwner, collapsed, stage),
    development: routeStep('development', stage, devOwner),
    review: routeStep('review', stage, input.reviewerAgentId ?? null),
    cleanup: cleanup ? routeStep('cleanup', stage) : null,
    security,
    tests: routeStep('tests', stage, input.testsAgentId ?? null),
  };
}

function stagedState(task: Task, input: RouteInput, cleanup: boolean, plan: StageRoute, resultKind: 'code' | 'document'): Route['state'] {
  requireStages(task, plan, input, cleanup);
  const archOwner = input.architectAgentId ?? task.assigneeAgentId;
  const devOwner = developmentOwner(task, resultKind);
  const collapsed = !task.small && archOwner !== null && archOwner === devOwner;
  const stage = initialCodeStage(plan, task.small, collapsed);
  const { step: security, security: policy } = securityState(task, input, stage);
  const steps = stageStepMap(task, input, cleanup, stage, archOwner, devOwner, collapsed, security);
  const hasSecurity = plan.stages.some(step => step.stage === 'security');
  return {
    kind: 'development_echelons', version: 1, resultKind, stage, phase: 'active', candidateId: null, assignment: null,
    stages: plan.stages.flatMap(step => steps[step.stage] ?? []), abilities: stageAbilities(plan), ...oneShotStages(plan),
    security: hasSecurity ? policy : NO_SECURITY,
  };
}

/* Work done end to end by its holder alone: no stage, no candidate and nobody else called onto it, even when checkers are named. */
async function turnkeyRoute(tx: Tx, task: Task, paths: string[]): Promise<void> {
  await tx.insert(taskRoutes).values({ taskId: task.id, companyId: task.companyId, paths, state: {
    kind: 'development_echelons', version: 1, resultKind: 'turnkey', stage: null, phase: 'active', candidateId: null, assignment: null, stages: [], abilities: {}, security: NO_SECURITY,
  } });
}

/* The stages the work of a department goes through, as its template lays them out. */
export async function departmentStages(ctx: Pick<Ctx, 'db' | 'templates'>, departmentId: string | null, pipelineId?: string | null): Promise<StageRoute> {
  const [department] = departmentId ? await ctx.db.select({ key: departments.templateKey }).from(departments).where(eq(departments.id, departmentId)) : [];
  const [pipeline] = pipelineId && departmentId
    ? await ctx.db.select({ catalogKey: pipelines.catalogKey }).from(pipelines).where(and(eq(pipelines.id, pipelineId), eq(pipelines.departmentId, departmentId)))
    : [];
  return catalogRoute(ctx.templates, department?.key ?? null, pipeline?.catalogKey ?? null);
}

/* A result made of the accepted results under it: no stage and no candidate of its own. */
export async function createCoordinationRoute(tx: Tx, task: Task): Promise<void> {
  await tx.insert(taskRoutes).values({ taskId: task.id, companyId: task.companyId, paths: [], state: {
    kind: 'development_echelons', version: 1, resultKind: 'coordination', stage: null, phase: 'active', candidateId: null, assignment: null, stages: [], abilities: {}, security: NO_SECURITY,
  } });
}

/* The checks of a new route nobody in its department can do, skipped: the head accepts the result in their place. A
   checker named for the task keeps its check. */
async function withoutUncheckable(tx: Tx, task: Task, state: Route['state']): Promise<{ state: Route['state']; skipped: EchelonStep['stage'][] }> {
  const skipped: EchelonStep['stage'][] = [];
  const stages: EchelonStep[] = [];
  for (const step of state.stages) {
    const ability = state.abilities[step.stage];
    const skip = step.status === 'pending' && !step.ownerAgentId && ability && await uncheckable(tx, task, step.stage, ability, state.security);
    if (skip) skipped.push(step.stage);
    stages.push(skip ? { ...step, status: 'skipped', reason: NO_DEPARTMENT_CHECKER } : step);
  }
  return { state: { ...state, stages }, skipped };
}

/* Lays the route of a new task out and says which of its checks were skipped, as nobody in its department can do them. */
export async function createRoute(tx: Tx, task: Task, input: RouteInput, plan: StageRoute): Promise<EchelonStep['stage'][]> {
  const resultKind = input.resultKind ?? (task.executorAgentId ? 'code' : 'coordination');
  if (resultKind === 'coordination') return createCoordinationRoute(tx, task).then(() => []);
  const paths = resultKind === 'document' ? [] : checkedScopePaths(input.paths);
  if (!(await throughEchelons(tx, task))) return turnkeyRoute(tx, task, paths).then(() => []);
  /* The head's Cleanup for a whole turn reaches only the departments whose route has it. */
  const cleanup = resultKind === 'document' ? input.cleanup ?? false : input.cleanup ?? (plan.stages.some(step => step.stage === 'cleanup') && await turnCleanupDefault(tx, task));
  const staged = resultKind === 'document' ? stagedState(task, input, cleanup, documentStages(plan), 'document') : stagedState(task, input, cleanup, plan, 'code');
  const withSecurity = await populateSecurityOwner(tx, task, staged);
  const { state, skipped } = await withoutUncheckable(tx, task, withSecurity);
  await tx.insert(taskRoutes).values({ taskId: task.id, companyId: task.companyId, paths, state });
  return skipped;
}

/* What the log keeps of the checks a route skipped, with why, so the head and the people see why the result came
   straight to the head. */
export const skippedData = (skipped: EchelonStep['stage'][]) =>
  skipped.length ? { skipped: skipped.map(stage => ({ stage, reason: NO_DEPARTMENT_CHECKER, why: `Nobody in this department carries the skill of ${stage}, so the head accepts the result.` })) } : {};
export { routeOf, routeSnapshot, routeSnapshots, endRoutes, cancelRoutes, changeRoute } from './route-records.js';
export type { Route } from './route-records.js';
