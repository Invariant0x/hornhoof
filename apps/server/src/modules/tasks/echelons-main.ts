import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import type { Ctx } from '../../app.js';
import { repoAt } from '../departments/repository.js';
import { heldLineage, type CompareResult, type TreeAt } from '../testruns/compare.js';
import type { RepoAddress } from '../testruns/refs.js';
import { checkingIdentity, heldCheckingIdentity } from './echelons-assign.js';
import { currentCandidate, producedCandidate } from './echelons-candidates.js';
import type { Submission, submissionOperation } from './echelons-operations.js';
import { sameChecker, type CheckerIdentity } from './echelons-policy.js';
import { changeRoute, skippedAuthorReview, type Route } from './route-records.js';
import { reviewReplacement } from './echelons-handoff.js';
import { move } from './transitions.js';
import { refuse, type Moved, type Task } from './state.js';
import { captureReview, exactComparison, type Review } from './review-context.js';
import { openTurnOf } from './turn-department.js';

/* A candidate whose own change passed and that only needs the main line, or the open turn of its department, stays at
   Tests: its owner merges that line into the candidate's branch, hands the merge in here and checks it again. The turn
   takes a result only by fast-forward, so a candidate whose turn went on takes the turn in this way before it is accepted. */

type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCompare' | 'readCommit' | 'readTree'>>;
type Repository = { readCompare: NonNullable<Reader['readCompare']>; readCommit: NonNullable<Reader['readCommit']>; readTree: Reader['readTree']; repo: RepoAddress & { branch: string }; turnBranch: string | null };

/* The paths from base to head, when head holds base: null where GitHub listed only part of them, as it does past 300 files,
   which proves the line and no change. Anything else proves nothing. */
async function changedPaths(at: Repository, base: string, head: string): Promise<string[] | null> {
  let compared: CompareResult | null = null;
  try { compared = await at.readCompare(at.repo, { base, head }, 10_000); }
  catch { /* An unreadable comparison is refused below. */ }
  if (!compared || !heldLineage(compared, base, head)) throw refuse(409, 'task_changed', `${head} does not hold ${base}, or the change between them could not be read.`);
  return exactComparison(compared, base, head) ? compared.paths : null;
}

/* Where head holds base, however many files lie between them; an unreadable comparison holds nothing. */
async function holds(at: Repository, base: string, head: string): Promise<boolean> {
  if (base === head) return true;
  try { return !!heldLineage(await at.readCompare(at.repo, { base, head }, 10_000), base, head); }
  catch { return false; }
}

/* What each file and submodule of a commit holds, by path, or the commit where GitHub could not name them all. */
async function filesAt(at: Repository, commit: string): Promise<Map<string, string> | string> {
  let tree: TreeAt | null = null;
  try { tree = at.readTree ? await at.readTree(at.repo, commit, 10_000) : null; }
  catch { /* An unreadable tree names nothing. */ }
  if (!tree?.complete || !tree.entries) return commit;
  return new Map(tree.entries.map(entry => [entry.path, `${entry.type} ${entry.mode} ${entry.sha}`]));
}

/* The paths the merge changes that the line did not bring, from the files of the four commits: what the merge holds other
   than the candidate it replaces, where the new base holds the same as the old one. A tree GitHub cut short proves nothing. */
async function beyondByFiles(at: Repository, parent: EchelonCandidate, candidate: EchelonCandidate, line: string): Promise<string[]> {
  const read = await Promise.all([parent.baseCommit, candidate.baseCommit, parent.commit, candidate.commit].map(commit => filesAt(at, commit)));
  const unread = read.find(files => typeof files === 'string');
  if (unread !== undefined) throw refuse(409, 'task_changed', `GitHub lists at most 300 files of a comparison, and the files of ${unread} could not be read whole, so it cannot be proved that the merge brings only ${line}. Try again.`);
  const [oldBase, newBase, oldCommit, newCommit] = read as [Map<string, string>, Map<string, string>, Map<string, string>, Map<string, string>];
  const paths = [...new Set([...oldCommit.keys(), ...newCommit.keys()])].sort();
  return paths.filter(path => oldCommit.get(path) !== newCommit.get(path) && oldBase.get(path) === newBase.get(path));
}

/* The head of a line as the repository says it now, or null where it cannot say. */
async function headOfLine(at: Repository, branch: string): Promise<string | null> {
  try {
    const head = await at.readCommit(at.repo, { branch }, 5_000);
    return 'problem' in head || head.branch !== branch ? null : head.commitSha;
  } catch { return null; }
}

/* Why neither line holds the base, naming the turn's head where it could be read. */
function offTheLines(at: Repository, base: string, main: string, turn: string | null) {
  const off = `${main} does not hold ${base}, or the change between them could not be read`;
  if (!at.turnBranch) return refuse(409, 'task_changed', `${off}.`);
  const where = turn ? ` at ${turn}` : ', which could not be read';
  return refuse(409, 'task_changed', `${off}; nor does ${at.turnBranch}${where}. Take in the main line or ${at.turnBranch}, and name the commit you took in as review.baseCommit.`);
}

/* The line the merge took in: the main line where it holds the new base, else the open turn of the task's department where
   that holds it. The merge then holds the turn's head as well, as the turn takes the candidate only by fast-forward; a turn
   of another department is no line of this task. */
async function lineTaken(at: Repository, base: string, commit: string): Promise<{ branch: string; turn: boolean }> {
  const main = await headOfLine(at, at.repo.branch);
  if (!main) throw refuse(409, 'repo_invalid', `The main line ${at.repo.branch} could not be read. Try again.`);
  if (await holds(at, base, main)) return { branch: at.repo.branch, turn: false };
  const turn = at.turnBranch ? await headOfLine(at, at.turnBranch) : null;
  if (!at.turnBranch || !turn || !(await holds(at, base, turn))) throw offTheLines(at, base, main, turn);
  if (!(await holds(at, turn, commit))) throw refuse(409, 'task_changed', `${at.turnBranch} went on to ${turn}, which ${commit} does not hold. Take ${at.turnBranch} in again: it takes the candidate only by fast-forward.`);
  return { branch: at.turnBranch, turn: true };
}

/* The open turn of the task's own department, which its results join: none for a product or a part of a department that
   keeps a repository of its own, whose results go to its main line. */
async function turnBranchOf(ctx: Reader, task: Task, department: { id: string; parentId: string | null }): Promise<string | null> {
  if (department.parentId) return null;
  const turn = await openTurnOf(ctx.db, task.companyId, department.id);
  return turn ? `turn-${turn.number}` : null;
}

async function repository(ctx: Reader, task: Task): Promise<Repository> {
  const found = ctx.config ? await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]) : null;
  if (!found || !ctx.readCompare || !ctx.readCommit) throw refuse(409, 'repo_invalid', 'The repository cannot be read here, so taking the main line in cannot be verified.');
  return { readCompare: ctx.readCompare, readCommit: ctx.readCommit, readTree: ctx.readTree, repo: found.repo, turnBranch: await turnBranchOf(ctx, task, found.department) };
}

/* Paths for a message: the first twenty, and how many more. */
const named = (paths: string[]): string => paths.length > 20 ? `${paths.slice(0, 20).join(', ')} and ${paths.length - 20} more` : paths.join(', ');

/* The merge keeps the branch and the candidate it replaces, its base moves along the line it took in, and it changes nothing
   that line did not bring: a base off the line would hide the candidate's own change from the checks. Where GitHub lists
   every file of both comparisons their paths prove it; where it cuts either short, the files of the four commits do. */
async function requireLineTaken(ctx: Reader, task: Task, parent: EchelonCandidate, candidate: EchelonCandidate): Promise<Record<string, unknown>> {
  if (candidate.branch !== parent.branch) throw refuse(409, 'task_changed', 'Taking the main line in keeps the candidate branch.');
  if (candidate.baseCommit === parent.baseCommit) throw refuse(409, 'task_invalid', 'Name the newer main or turn commit you took in as review.baseCommit.');
  const at = await repository(ctx, task);
  const brought = await changedPaths(at, parent.baseCommit, candidate.baseCommit);
  const line = await lineTaken(at, candidate.baseCommit, candidate.commit);
  const merged = await changedPaths(at, parent.commit, candidate.commit);
  const beyond = brought && merged ? merged.filter(path => !brought.includes(path)) : await beyondByFiles(at, parent, candidate, line.branch);
  if (beyond.length) throw refuse(409, 'task_invalid', `The merge changes what ${line.branch} did not bring: ${named(beyond)}. Take in only ${line.branch}; a failed check of the candidate's own change is reported with done false.`);
  const moved = { from: parent.baseCommit, to: candidate.baseCommit };
  return line.turn ? { tookTurn: { branch: line.branch, ...moved } } : { tookMain: moved };
}

export async function keepCandidateAtTests(
  ctx: Reader,
  agentId: string,
  task: Task,
  route: Route,
  parent: EchelonCandidate,
  identity: CheckerIdentity,
  candidate: EchelonCandidate,
  review: Review,
  input: Submission,
  operation: ReturnType<typeof submissionOperation>,
  detail: Record<string, unknown>,
): Promise<Moved> {
  const reviewAgain = skippedAuthorReview(route.state) ? await reviewReplacement(ctx, task, route, candidate) : null;
  const row = await move(ctx, task, reviewAgain?.set ?? { silent: 0 }, {
    kind: 'submitted', actor: { agentId }, text: input.summary,
    data: { evidence: input.evidence, candidate, ...detail, ...(operation ? { operation } : {}), routeRevision: route.revision, review },
  }, async tx => {
    if (!sameChecker(await heldCheckingIdentity(tx, task, route, parent), identity)) throw refuse(409, 'task_changed', 'The checking assignment changed. Ask the head to assign it again.');
    await changeRoute(tx, route, reviewAgain?.state ?? { ...route.state, candidateId: candidate.id });
  }, reviewAgain?.wakes);
  return { task: row, wakes: reviewAgain?.wakes ?? [] };
}

export async function takeMainAtTests(ctx: Reader, agentId: string, task: Task, route: Route, input: Submission, operation: ReturnType<typeof submissionOperation>): Promise<Moved> {
  const parent = await currentCandidate(ctx.db, task, route);
  const identity = await checkingIdentity(ctx, task, route, parent);
  const review = await captureReview(ctx, { ...task, executorAgentId: agentId }, input.review, parent.branch);
  const candidate = producedCandidate(route, identity, review);
  const taken = await requireLineTaken(ctx, task, parent, candidate);
  return keepCandidateAtTests(ctx, agentId, task, route, parent, identity, candidate, review, input, operation, taken);
}
