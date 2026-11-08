import type { Ctx } from '../../app.js';
import { changeRoute, type Route } from './echelons-store.js';
import { move, refuse, type Moved, type Task, type Wake } from './engine.js';

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
