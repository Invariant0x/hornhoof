import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { taskEvents, tasks } from '../../db/schema.js';
import { currentCandidate } from './echelons-candidates.js';
import type { Ctx } from '../../app.js';
import { changeRoute, routeOf, type Route } from './echelons-store.js';
import { giver, move, note, refuse, type Moved, type Task, type Wake } from './engine.js';

const Acceptance = z.object({ candidateId: z.uuid(), commit: z.string().regex(/^[a-f0-9]{40}$/), routeRevision: z.number().int().positive(), evidence: z.array(z.object({ runId: z.uuid(), commit: z.string().regex(/^[a-f0-9]{40}$/) })).min(1) });

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

/* The aggregate pins existing accepted results. It never manufactures a repository candidate for itself. */
export async function coordinationReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string): Promise<Moved> {
  if (task.assigneeAgentId !== agentId || route.state.phase !== 'active') throw refuse(403, 'task_not_yours', 'Only the current coordination owner can close its report.');
  if (!summary.trim()) throw refuse(400, 'task_invalid', 'A coordination result needs a checked report.');
  if (route.state.candidateId) throw refuse(409, 'task_invalid', 'This task produced code and needs the executable route.');
  const wakes = giver(task, 'reported', agentId, summary.trim());
  const row = await move(ctx, task, { status: 'done', closedAt: new Date(), assigneeAgentId: null, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary.trim(), data: { done: true },
  }, async tx => {
    const children = await tx.select().from(tasks).where(and(eq(tasks.parentId, task.id), eq(tasks.companyId, task.companyId))).orderBy(asc(tasks.id)).for('share');
    const acceptedChildren = [];
    for (const child of children) {
      if (child.status === 'cancelled') continue;
      if (child.status !== 'done') throw refuse(409, 'task_invalid', 'Every child must be accepted before the group closes.');
      const childRoute = await routeOf(tx, child);
      if (childRoute.state.phase !== 'done') throw refuse(409, 'task_invalid', 'A closed child has no completed route.');
      const [report] = await tx.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, child.id), eq(taskEvents.companyId, task.companyId), eq(taskEvents.kind, 'report'))).orderBy(desc(taskEvents.id)).limit(1);
      if (childRoute.state.resultKind === 'coordination') {
        if (!Array.isArray(report?.data.acceptedChildren)) throw refuse(409, 'task_invalid', 'A child group has no checked aggregate.');
        acceptedChildren.push({ taskId: child.id, children: report.data.acceptedChildren });
        continue;
      }
      const candidate = await currentCandidate(tx, child, childRoute);
      const acceptance = Acceptance.safeParse(report?.data.acceptedCandidate);
      const reviewed = childRoute.state.stages.some(step => step.stage === 'review' && step.status === 'complete');
      const complete = childRoute.state.stages.every(step => step.status === 'complete' || step.status === 'skipped');
      if (!reviewed || !complete || !acceptance.success || acceptance.data.candidateId !== candidate.id || acceptance.data.commit !== candidate.commit || acceptance.data.routeRevision !== childRoute.revision || acceptance.data.evidence.some(proof => proof.commit !== candidate.commit)) {
        throw refuse(409, 'task_invalid', 'A child candidate is unreviewed, unaccepted or stale.');
      }
      acceptedChildren.push({ taskId: child.id, candidateId: candidate.id, commit: candidate.commit, evidence: acceptance.data.evidence });
    }
    await changeRoute(tx, route, { ...route.state, phase: 'done' });
    await note(tx, task, { kind: 'report', actor: { agentId }, text: summary.trim(), data: { done: true, acceptedChildren, routeRevision: route.revision + 1 } });
  }, wakes);
  return { task: row, wakes };
}
