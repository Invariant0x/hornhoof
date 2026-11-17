import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { agents, taskEvents, tasks } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { repoAt } from '../departments/repository.js';
import { requireTestsReport } from './echelons-tests.js';
import { currentCandidate } from './echelons-candidates.js';
import { acceptedDocument } from './echelons-document.js';
import type { Ctx } from '../../app.js';
import { requiredStagesComplete } from './echelons-accept.js';
import { changeRoute, routeOf, type Route } from './echelons-store.js';
import { giver, move, note, refuse, type Moved, type Task, type Tx, type Wake } from './engine.js';

/* Acceptances and aggregates made before checks went local also name test runs, which are left out. */
const Acceptance = z.object({ candidateId: z.uuid(), commit: z.string().regex(/^[a-f0-9]{40}$/), routeRevision: z.number().int().positive() });

type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCompare' | 'readCommit'>>;

export async function architectureReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string): Promise<Moved> {
  if (task.assigneeAgentId !== agentId || route.state.phase !== 'active') throw refuse(403, 'task_not_yours', 'Only the current Architecture owner can hand over its plan.');
  if (!summary.trim()) throw refuse(400, 'task_invalid', 'Architecture needs a concrete plan.');
  const owner = route.state.stages.find(step => step.stage === 'development')?.ownerAgentId;
  if (!owner) throw refuse(409, 'task_invalid', 'The head must assign Development before the plan is handed over.');
  const state: Route['state'] = { ...route.state, stage: 'development', stages: route.state.stages.map(step => {
    if (step.stage === 'architecture') return { ...step, status: 'complete' };
    if (step.stage === 'development') return { ...step, status: 'active' };
    return step;
  }) };
  const wakes: Wake[] = [{ agentId: owner, taskId: task.id, why: 'assigned' }];
  const row = await move(ctx, task, { status: 'open', assigneeAgentId: owner, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary.trim(), data: { architecturePlan: summary.trim(), routeRevision: route.revision },
  }, tx => changeRoute(tx, route, state), wakes);
  return { task: row, wakes };
}

type AcceptedChild = { taskId: string; candidateId: string; commit: string } | { taskId: string; children: AcceptedChild[] } | { taskId: string; turnkey: true } | { taskId: string; candidateId: string; digest: string };
const ChildReference: z.ZodType<AcceptedChild> = z.lazy(() => z.union([
  z.object({ taskId: z.uuid(), candidateId: z.uuid(), commit: z.string() }),
  z.object({ taskId: z.uuid(), children: z.array(ChildReference) }),
  z.object({ taskId: z.uuid(), turnkey: z.literal(true) }),
  z.object({ taskId: z.uuid(), candidateId: z.uuid(), digest: z.string() }),
]));

async function acceptedUnder(tx: Tx, task: Task, ancestors = new Set<string>()): Promise<AcceptedChild[]> {
  if (ancestors.has(task.id)) throw refuse(409, 'task_invalid', 'The aggregate contains a task cycle.');
  const path = new Set([...ancestors, task.id]);
  const children = await tx.select().from(tasks).where(and(eq(tasks.parentId, task.id), eq(tasks.companyId, task.companyId))).orderBy(asc(tasks.id)).for('share');
  const acceptedChildren: AcceptedChild[] = [];
  for (const child of children) {
    if (child.status === 'cancelled') continue;
    acceptedChildren.push(await acceptedChild(tx, child, path));
  }
  return acceptedChildren;
}

type ReportData = typeof taskEvents.$inferSelect.data | undefined;

async function acceptedChild(tx: Tx, child: Task, path: Set<string>): Promise<AcceptedChild> {
  if (child.status !== 'done') throw refuse(409, 'task_invalid', 'Every child must be accepted before the group closes.');
  const route = await routeOf(tx, child);
  if (route.state.phase !== 'done') throw refuse(409, 'task_invalid', 'A closed child has no completed route.');
  const [report] = await tx.select(only(taskEvents, 'data')).from(taskEvents).where(and(eq(taskEvents.taskId, child.id), eq(taskEvents.companyId, child.companyId), eq(taskEvents.kind, 'report'))).orderBy(desc(taskEvents.id)).limit(1);
  /* Turnkey work has no candidate and no stages: its holder closed it alone, and nobody checks it after. */
  if (route.state.resultKind === 'turnkey') return { taskId: child.id, turnkey: true };
  if (route.state.resultKind === 'document') return acceptedDocument(tx, child, route, report?.data);
  return route.state.resultKind === 'coordination' ? acceptedAggregate(tx, child, route, report?.data, path) : acceptedCode(tx, child, route, report?.data);
}

async function acceptedAggregate(tx: Tx, child: Task, route: Route, report: ReportData, path: Set<string>): Promise<AcceptedChild> {
  const snapshot = z.array(ChildReference).safeParse(report?.acceptedChildren);
  const nested = await acceptedUnder(tx, child, path);
  if (!snapshot.success || report?.routeRevision !== route.revision || JSON.stringify(snapshot.data) !== JSON.stringify(nested)) throw refuse(409, 'task_changed', 'The child aggregate is missing or its accepted results changed.');
  return { taskId: child.id, children: nested };
}

function acceptedIdentity(acceptance: z.infer<typeof Acceptance>, route: Route, candidate: Awaited<ReturnType<typeof currentCandidate>>): boolean {
  return acceptance.candidateId === candidate.id && acceptance.commit === candidate.commit && acceptance.routeRevision === route.revision;
}

async function acceptedCode(tx: Tx, child: Task, route: Route, report: ReportData): Promise<AcceptedChild> {
  const candidate = await currentCandidate(tx, child, route);
  const acceptance = Acceptance.safeParse(report?.acceptedCandidate);
  if (!requiredStagesComplete(route) || !acceptance.success || !acceptedIdentity(acceptance.data, route, candidate)) throw refuse(409, 'task_invalid', 'A child candidate is unreviewed, unaccepted or stale.');
  await requireTestsReport(tx, child, route, candidate, route.revision - 1);
  return { taskId: child.id, candidateId: candidate.id, commit: candidate.commit };
}

/* Where the department keeps code, a worker's own report would hand in work no Review saw: a worker closes a coordination task
   there only on accepted results of its subtasks. A head or the orchestrator still closes a finding that has no code. */
async function closableBy(ctx: Reader, tx: Tx, task: Task, agentId: string, children: unknown[]): Promise<void> {
  if (children.length || !ctx.config) return;
  const [agent] = await tx.select(only(agents, 'kind')).from(agents).where(eq(agents.id, agentId));
  if (agent?.kind !== 'worker' || !(await repoAt({ db: tx, config: ctx.config }, [task.productId, task.departmentId]))) return;
  throw refuse(409, 'task_invalid', `#${task.number} closes only on accepted results of its subtasks, as its department keeps code: hand in code through submit on a code task, or tell whoever gave you #${task.number} what you found with comment, and they close it.`);
}

/* The aggregate pins existing accepted results. It never manufactures a repository candidate for itself. */
export async function coordinationReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string): Promise<Moved> {
  if (task.assigneeAgentId !== agentId || route.state.phase !== 'active') throw refuse(403, 'task_not_yours', 'Only the current coordination owner can close its report.');
  if (!summary.trim()) throw refuse(400, 'task_invalid', 'A coordination result needs a checked report.');
  if (route.state.candidateId) throw refuse(409, 'task_invalid', 'This task produced code and needs the executable route.');
  const wakes = giver(task, 'reported', agentId, summary.trim());
  const row = await move(ctx, task, { status: 'done', closedAt: new Date(), assigneeAgentId: null, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary.trim(), data: { done: true }, returned: true,
  }, async tx => {
    const acceptedChildren = await acceptedUnder(tx, task);
    await closableBy(ctx, tx, task, agentId, acceptedChildren);
    await changeRoute(tx, route, { ...route.state, phase: 'done' });
    await note(tx, task, { kind: 'report', actor: { agentId }, text: summary.trim(), data: { done: true, acceptedChildren, routeRevision: route.revision + 1 } });
  }, wakes);
  return { task: row, wakes };
}
