import type { Ctx } from '../../app.js';
import { sameChecker } from './echelons-policy.js';
import { agentIdentity } from './echelons-assign.js';
import { currentCandidate } from './echelons-candidates.js';
import { forwardHandoff } from './echelons-handoff.js';
import { changeRoute, routeOf } from './echelons-store.js';
import { loadTask, move, refuse, type Moved } from './engine.js';
import type { ReviewVerdict } from './review-verdict.js';

type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCompare' | 'readCommit'>>;

export async function echelonVerdict(ctx: Reader, agentId: string, taskId: string, verdict: ReviewVerdict & { comment: string }): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  const route = await routeOf(ctx.db, task);
  if (task.assigneeAgentId !== agentId || route.state.phase !== 'active' || !['review', 'security', 'cleanup'].includes(route.state.stage)) {
    throw refuse(403, 'task_not_yours', 'This task is not at your checking stage.');
  }
  if (!verdict.comment.trim()) throw refuse(400, 'task_invalid', 'A verdict needs its reasons.');
  const candidate = await currentCandidate(ctx.db, task, route);
  if (verdict.reviewedCommit !== candidate.commit) throw refuse(409, 'task_changed', 'Name the exact current candidate commit in the verdict.');
  const identity = await agentIdentity(ctx.db, task.companyId, agentId);
  if (!identity || !sameChecker(identity, route.state.assignment)) throw refuse(409, 'task_changed', 'The checking assignment model or provider changed. Ask the head to assign it again.');
  const n = { kind: 'verdict' as const, actor: { agentId }, text: verdict.comment.trim(), data: {
    pass: verdict.pass, stage: route.state.stage, candidateId: candidate.id, reviewedCommit: candidate.commit, routeRevision: route.revision, checker: identity,
  } };
  if (!verdict.pass) {
    const row = await move(ctx, task, { status: 'working' }, n, tx => changeRoute(tx, route, route.state));
    return { task: row, wakes: [] };
  }
  const next = await forwardHandoff(ctx, task, route, candidate);
  const row = await move(ctx, task, next.set, n, tx => changeRoute(tx, route, next.state), next.wakes);
  return { task: row, wakes: next.wakes };
}
