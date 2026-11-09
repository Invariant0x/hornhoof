import { issuesForEchelon } from './review-findings.js';
import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import type { Ctx } from '../../app.js';
import { checkingIdentity, departmentHead, heldCheckingIdentity } from './echelons-assign.js';
import { currentCandidate } from './echelons-candidates.js';
import { forwardHandoff } from './echelons-handoff.js';
import { returnedToAuthor } from './echelons-return.js';
import { changeRoute, routeOf, type Route } from './echelons-store.js';
import { sameChecker, type CheckerIdentity } from './echelons-policy.js';
import { loadTask, move, refuse, waitsForPerson, type Moved, type Task, type Tx, type Wake } from './engine.js';
import { bindReviewEvidence, type ReviewVerdict } from './review-verdict.js';
import { refusePaused } from './pause.js';

type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCompare' | 'readCommit'>>;
type Verdict = ReviewVerdict & { comment: string };

function requireCheckingOwner(task: Task, route: Route, agentId: string): void {
  if (task.assigneeAgentId !== agentId || route.state.phase !== 'active' || !['review', 'security', 'cleanup'].includes(route.state.stage ?? '')) {
    throw refuse(403, 'task_not_yours', 'This task is not at your checking stage.');
  }
}

/* A verdict says one thing: PASS, a defect the checker fixes, an escalation of a wrong goal, or Review's return of the
   work to its author. */
function refuseMixedVerdict(route: Route, verdict: Verdict): void {
  if (verdict.escalate && verdict.pass) throw refuse(400, 'task_invalid', 'An escalation cannot certify PASS.');
  if (!verdict.returnToAuthor) return;
  if (verdict.pass || verdict.escalate) throw refuse(400, 'task_invalid', 'A return to the author is a FAIL verdict, neither a PASS nor an escalation.');
  if (route.state.stage !== 'review') throw refuse(400, 'task_invalid', 'Only Review returns a candidate to its author; fix it yourself or escalate a wrong goal.');
}

function verdictState(route: Route, verdict: Verdict, agentId: string): Route['state'] {
  refuseMixedVerdict(route, verdict);
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
    ...(verdict.returnToAuthor ? { returnedToAuthor: true } : {}),
  };
}

type VerdictNote = { kind: 'verdict'; actor: { agentId: string }; text: string; data: ReturnType<typeof verdictData> };

/* A wrong goal goes to the head, and the route stands escalated at this stage. */
async function escalation(ctx: Reader, task: Task, route: Route, state: Route['state'], n: VerdictNote, held: (tx: Tx) => Promise<void>): Promise<Moved> {
  const wakes: Wake[] = [{ agentId: await departmentHead(ctx.db, task), taskId: task.id, why: 'blocked', text: n.text }];
  const escalated: typeof state = { ...state, phase: 'escalated', stages: state.stages.map(step => step.stage === state.stage ? { ...step, reason: 'wrong_goal' } : step) };
  const row = await move(ctx, task, { status: 'blocked', assigneeAgentId: null }, n, async tx => { await held(tx); await changeRoute(tx, route, escalated); }, wakes);
  return { task: row, wakes };
}

/* Work the author must do goes back to the author on Development; the next candidate is compared with this one. */
async function authorReturn(ctx: Reader, task: Task, route: Route, n: VerdictNote, held: (tx: Tx) => Promise<void>): Promise<Moved> {
  const author = route.state.stages.find(step => step.stage === 'development')?.ownerAgentId;
  if (!author) throw refuse(409, 'task_invalid', 'Development has no author to take the work back. Ask the head to assign it.');
  const wakes: Wake[] = [{ agentId: author, taskId: task.id, why: 'changes', text: n.text }];
  const row = await move(ctx, task, { status: 'open', assigneeAgentId: author, silent: 0 }, n, async tx => { await held(tx); await changeRoute(tx, route, returnedToAuthor(route, 'review_returned')); }, wakes);
  return { task: row, wakes };
}

export async function echelonVerdict(ctx: Reader, agentId: string, taskId: string, verdict: Verdict): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  const route = await routeOf(ctx.db, task);
  requireCheckingOwner(task, route, agentId);
  refusePaused(task);
  if (!verdict.comment.trim()) throw refuse(400, 'task_invalid', 'A verdict needs its reasons.');
  const candidate = await currentCandidate(ctx.db, task, route);
  if (verdict.reviewedCommit !== candidate.commit) throw refuse(409, 'task_changed', 'Name the exact current candidate commit in the verdict.');
  const identity = await checkingIdentity(ctx, task, route, candidate);
  if (await waitsForPerson(ctx.db, task.id)) throw refuse(409, 'task_invalid', `#${task.number} waits for a person's answer first.`);
  const state = verdictState(route, verdict, agentId);
  const issues = await issuesForEchelon(ctx.db, task, route, candidate, identity, verdict.issues ?? [], verdict.pass);
  const n = { kind: 'verdict' as const, actor: { agentId }, text: verdict.comment.trim(), data: verdictData(route, candidate, identity, verdict, issues, state) };
  const held = async (tx: Tx) => { if (!sameChecker(await heldCheckingIdentity(tx, task, route, candidate), identity)) throw refuse(409, 'task_changed', 'The checking assignment changed. Ask the head to assign it again.'); };
  if (verdict.escalate) return escalation(ctx, task, route, state, n, held);
  if (verdict.returnToAuthor) return authorReturn(ctx, task, { ...route, state }, n, held);
  if (!verdict.pass) {
    const row = await move(ctx, task, { status: 'working' }, n, async tx => { await held(tx); await changeRoute(tx, route, state); });
    return { task: row, wakes: [] };
  }
  const next = await forwardHandoff(ctx, task, { ...route, state }, candidate);
  const row = await move(ctx, task, next.set, { ...n, returned: true }, async tx => { await held(tx); await changeRoute(tx, route, next.state); }, next.wakes);
  return { task: row, wakes: next.wakes };
}
