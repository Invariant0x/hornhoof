import { issuesForEchelon } from './review-findings.js';
import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import type { Ctx } from '../../app.js';
import { checkingIdentity, departmentHead } from './echelons-assign.js';
import { currentCandidate } from './echelons-candidates.js';
import { forwardHandoff } from './echelons-handoff.js';
import { changeRoute, routeOf, type Route } from './echelons-store.js';
import type { CheckerIdentity } from './echelons-policy.js';
import { loadTask, move, refuse, waitsForPerson, type Moved, type Task, type Wake } from './engine.js';
import { bindReviewEvidence, type ReviewVerdict } from './review-verdict.js';

type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCompare' | 'readCommit'>>;
type Verdict = ReviewVerdict & { comment: string };

function requireCheckingOwner(task: Task, route: Route, agentId: string): void {
  if (task.assigneeAgentId !== agentId || route.state.phase !== 'active' || !['review', 'security', 'cleanup'].includes(route.state.stage ?? '')) {
    throw refuse(403, 'task_not_yours', 'This task is not at your checking stage.');
  }
}

function verdictState(route: Route, verdict: Verdict, agentId: string): Route['state'] {
  if (verdict.escalate && verdict.pass) throw refuse(400, 'task_invalid', 'An escalation cannot certify PASS.');
  const state = route.state;
  if (verdict.security === undefined) return state;
  if (state.stage !== 'review' || !verdict.security.trim()) throw refuse(400, 'task_invalid', 'Only Review adds Security with a concrete risk.');
  return { ...state, security: { required: true, reason: verdict.security.trim(), addedBy: agentId },
    stages: state.stages.map(step => step.stage === 'security' ? { ...step, status: 'pending', reason: null } : step),
  };
}

function verdictData(route: Route, candidate: EchelonCandidate, identity: CheckerIdentity, verdict: Verdict, issues: Awaited<ReturnType<typeof issuesForEchelon>>, state: Route['state']) {
  const evidence = bindReviewEvidence(verdict.evidence ?? [], candidate.commit);
  return { issues, pass: verdict.pass, stage: route.state.stage, candidateId: candidate.id, reviewedCommit: candidate.commit, routeRevision: route.revision, checker: identity,
    ...(evidence.length ? { evidence } : {}), ...(verdict.security ? { addedSecurity: state.security } : {}), ...(verdict.escalate ? { wrongGoal: true } : {}),
  };
}

export async function echelonVerdict(ctx: Reader, agentId: string, taskId: string, verdict: Verdict): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  const route = await routeOf(ctx.db, task);
  requireCheckingOwner(task, route, agentId);
  if (!verdict.comment.trim()) throw refuse(400, 'task_invalid', 'A verdict needs its reasons.');
  const candidate = await currentCandidate(ctx.db, task, route);
  if (verdict.reviewedCommit !== candidate.commit) throw refuse(409, 'task_changed', 'Name the exact current candidate commit in the verdict.');
  const identity = await checkingIdentity(ctx, task, route, candidate);
  if (await waitsForPerson(ctx.db, task.id)) throw refuse(409, 'task_invalid', `#${task.number} waits for a person's answer first.`);
  const state = verdictState(route, verdict, agentId);
  const issues = await issuesForEchelon(ctx.db, task, route, candidate, identity, verdict.issues ?? [], verdict.pass);
  const n = { kind: 'verdict' as const, actor: { agentId }, text: verdict.comment.trim(), data: verdictData(route, candidate, identity, verdict, issues, state) };
  if (verdict.escalate) {
    const wakes: Wake[] = [{ agentId: await departmentHead(ctx.db, task), taskId: task.id, why: 'blocked', text: verdict.comment.trim() }];
    const escalated: typeof state = { ...state, phase: 'escalated', stages: state.stages.map(step => step.stage === state.stage ? { ...step, reason: 'wrong_goal' } : step) };
    const row = await move(ctx, task, { status: 'blocked', assigneeAgentId: null }, n, tx => changeRoute(tx, route, escalated), wakes);
    return { task: row, wakes };
  }
  if (!verdict.pass) {
    const row = await move(ctx, task, { status: 'working' }, n, tx => changeRoute(tx, route, state));
    return { task: row, wakes: [] };
  }
  const next = await forwardHandoff(ctx, task, { ...route, state }, candidate);
  const row = await move(ctx, task, next.set, { ...n, returned: true }, tx => changeRoute(tx, route, next.state), next.wakes);
  return { task: row, wakes: next.wakes };
}
