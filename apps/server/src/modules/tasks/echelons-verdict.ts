import { issuesForEchelon } from './review-findings.js';
import type { DocumentCandidate, EchelonCandidate } from '@hornhoof/protocol/echelons';
import type { Ctx } from '../../app.js';
import { checkingIdentity, departmentHead, heldCheckingIdentity } from './echelons-assign.js';
import { currentHanded } from './echelons-candidates.js';
import { forwardHandoff } from './echelons-handoff.js';
import { changeRoute, routeOf, type Route, skippedData } from './echelons-store.js';
import { sameChecker, type CheckerIdentity } from './echelons-policy.js';
import { loadTask, move, refuse, waitsForPerson, type Moved, type Task, type Tx, type Wake } from './engine.js';
import type { ReviewVerdict } from './review-verdict.js';
import { refusePaused } from './pause.js';
import { turnkeyWork } from './turnkey.js';

type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCompare' | 'readCommit'>>;
type Verdict = ReviewVerdict & { comment: string };

/* Tests checks with its report: its owner hands a repair in with submit, as Review and Security do after their verdict. */
function requireCheckingOwner(task: Task, route: Route, agentId: string): void {
  if (task.assigneeAgentId === agentId && route.state.phase === 'active' && route.state.stage === 'tests') {
    throw refuse(409, 'task_invalid', 'Tests gives no verdict. Hand a repair in with submit on the candidate\'s branch, naming its base as review.baseCommit, then report done true with the candidateId and revision task.echelons gives; a failed check you do not repair is reported with done false.');
  }
  if (task.assigneeAgentId !== agentId || route.state.phase !== 'active' || !['review', 'security', 'cleanup'].includes(route.state.stage ?? '')) {
    throw refuse(403, 'task_not_yours', 'This task is not at your checking stage.');
  }
}

function verdictState(route: Route, verdict: Verdict, agentId: string): Route['state'] {
  if (verdict.escalate && verdict.pass) throw refuse(400, 'task_invalid', 'An escalation cannot certify PASS.');
  const state = route.state;
  if (verdict.security === undefined) return state;
  if (state.stage !== 'review' || !verdict.security.trim()) throw refuse(400, 'task_invalid', 'Only Review adds Security with a concrete risk.');
  if (!state.stages.some(step => step.stage === 'security')) throw refuse(409, 'task_invalid', 'The route of this department has no Security stage. Escalate the risk to the head.');
  return { ...state, security: { required: true, reason: verdict.security.trim(), addedBy: agentId },
    stages: state.stages.map(step => step.stage === 'security' ? { ...step, status: 'pending', reason: null } : step),
  };
}

type Checked = EchelonCandidate | DocumentCandidate;
const isCommit = (candidate: Checked): candidate is EchelonCandidate => 'commit' in candidate;

/* The checker names what it checked, so a verdict never lands on a candidate handed in after it looked. */
function requireNamedCandidate(candidate: Checked, verdict: Verdict): void {
  if (isCommit(candidate) ? verdict.reviewedCommit !== candidate.commit : verdict.candidateId !== candidate.id) {
    throw refuse(409, 'task_changed', isCommit(candidate) ? 'Name the exact current candidate commit in the verdict.' : 'Name the exact current candidate in the verdict: candidateId, as task.echelons gives it.');
  }
}

/* Findings of a document go in the words of its verdict: a structured finding names a path and a line of a commit. */
async function verdictIssues(ctx: Reader, task: Task, route: Route, candidate: Checked, identity: CheckerIdentity, verdict: Verdict) {
  if (isCommit(candidate)) return issuesForEchelon(ctx.db, task, route, candidate, identity, verdict.issues ?? [], verdict.pass);
  if (verdict.issues?.length) throw refuse(400, 'task_invalid', 'A document has no paths and lines to pin a finding to. Say in the comment what is wrong and where.');
  return [];
}

function verdictData(route: Route, candidate: Checked, identity: CheckerIdentity, verdict: Verdict, issues: Awaited<ReturnType<typeof issuesForEchelon>>, state: Route['state']) {
  return { issues, pass: verdict.pass, stage: route.state.stage, candidateId: candidate.id, ...(isCommit(candidate) ? { reviewedCommit: candidate.commit } : {}), routeRevision: route.revision, checker: identity,
    ...(verdict.security ? { addedSecurity: state.security } : {}), ...(verdict.escalate ? { wrongGoal: true } : {}),
  };
}

export async function echelonVerdict(ctx: Reader, agentId: string, taskId: string, verdict: Verdict): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  const route = await routeOf(ctx.db, task);
  if (route.state.resultKind === 'turnkey') throw turnkeyWork(task);
  requireCheckingOwner(task, route, agentId);
  refusePaused(task);
  if (!verdict.comment.trim()) throw refuse(400, 'task_invalid', 'A verdict needs its reasons.');
  const candidate = await currentHanded(ctx.db, task, route);
  requireNamedCandidate(candidate, verdict);
  const identity = await checkingIdentity(ctx, task, route, candidate);
  if (await waitsForPerson(ctx.db, task.id)) throw refuse(409, 'task_invalid', `#${task.number} waits for a person's answer first.`);
  const state = verdictState(route, verdict, agentId);
  const issues = await verdictIssues(ctx, task, route, candidate, identity, verdict);
  const n = { kind: 'verdict' as const, actor: { agentId }, text: verdict.comment.trim(), data: verdictData(route, candidate, identity, verdict, issues, state) };
  const held = async (tx: Tx) => { if (!sameChecker(await heldCheckingIdentity(tx, task, route, candidate), identity)) throw refuse(409, 'task_changed', 'The checking assignment changed. Ask the head to assign it again.'); };
  if (verdict.escalate) {
    const wakes: Wake[] = [{ agentId: await departmentHead(ctx.db, task), taskId: task.id, why: 'blocked', text: verdict.comment.trim() }];
    const escalated: typeof state = { ...state, phase: 'escalated', stages: state.stages.map(step => step.stage === state.stage ? { ...step, reason: 'wrong_goal' } : step) };
    const row = await move(ctx, task, { status: 'blocked', assigneeAgentId: null }, { ...n, returned: true }, async tx => { await held(tx); await changeRoute(tx, route, escalated); }, wakes);
    return { task: row, wakes };
  }
  if (!verdict.pass) {
    const row = await move(ctx, task, { status: 'working' }, n, async tx => { await held(tx); await changeRoute(tx, route, state); });
    return { task: row, wakes: [] };
  }
  const next = await forwardHandoff(ctx, task, { ...route, state }, candidate);
  const row = await move(ctx, task, next.set, { ...n, data: { ...n.data, ...skippedData(next.skipped) }, returned: true }, async tx => { await held(tx); await changeRoute(tx, route, next.state); }, next.wakes);
  return { task: row, wakes: next.wakes };
}
