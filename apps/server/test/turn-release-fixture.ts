import { and, eq } from 'drizzle-orm';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, departments, jobs, tasks, teams, turns } from '../src/db/schema.js';
import { answer, ask, createTask, report, startWork, type Ask } from '../src/modules/tasks/engine.js';
import { uncheckedInRelease } from '../src/modules/tasks/releases.js';
import type { Task } from '../src/modules/tasks/state.js';
import type { Ctx } from '../src/app.js';
import { testsFixture } from './development-echelons-verification.js';
import { BASE } from './development-echelons-fixture.js';
import { listen, mcp } from './helpers.js';
import type { CiAt } from '../src/modules/testruns/github-ci.js';
import type { Dispatched } from '../src/modules/testruns/github-dispatch.js';

/* What a repository says in these tests: where each branch and tag is, and which commit holds which. A commit holds itself
   and whatever holds names for it; the commits between two are what between names. made lists the branches the server made,
   refusing says why the repository takes no new branch, and each push to make one waits at hold first. */
export type Repository = {
  heads: Record<string, string>;
  tags: Record<string, string>;
  holds: Record<string, string[]>;
  between: Record<string, { sha: string; parents: string[] }[]>;
  cut: Set<string>;
  /* Comparisons whose files GitHub capped at 300: they prove the line and its commits, never the files. */
  capped?: Set<string>;
  /* What the repository's CI says of each commit, by default green with three checks, and the commits the server asked it of. */
  ci?: CiAt | ((commit: string) => CiAt);
  asked?: string[];
  /* The release workflow the department's settings named, as each read of CI and each start of it was given it. */
  named?: (string | null)[];
  /* What starting the release workflow answers (started, run 4242, by default), and the branches and commits it was asked on. */
  dispatch?: Dispatched | ((branch: string, commit: string) => Dispatched);
  dispatched?: { branch: string; commit: string }[];
  made?: { branch: string; commit: string }[];
  refusing?: string;
  hold?: () => Promise<void>;
};

const contains = (repo: Repository, head: string, base: string): boolean => head === base || (repo.holds[head] ?? []).includes(base);

/* Serves the readers the server uses from what the test says the repository is. */
export function serve(ctx: Ctx, repo: Repository): void {
  serveEach(ctx, () => repo);
}

/* Serves the readers from the repository each address names, as two departments keep two repositories. */
export function serveEach(ctx: Ctx, repoAt: (url: string) => Repository): void {
  ctx.readCommit = async (at, want) => {
    const repo = repoAt(at.url);
    const branch = 'branch' in want ? want.branch : `task-${want.task}`;
    const head = repo.heads[branch];
    if (head) return { branch, commitSha: head };
    /* As git clone --branch takes a tag of the name where there is no such branch, and says so. */
    const tagged = repo.tags[branch];
    return tagged ? { branch, commitSha: tagged, tag: true } : { problem: `The repository has no branch ${branch}.`, missing: true };
  };
  ctx.readCi = async (at, commit) => {
    const repo = repoAt(at.url);
    (repo.asked ??= []).push(commit);
    (repo.named ??= []).push(at.releaseWorkflow ?? null);
    const said = repo.ci ?? { state: 'green' as const, checks: 3 };
    return typeof said === 'function' ? said(commit) : said;
  };
  ctx.dispatchCi = async (at, branch, commit) => {
    const repo = repoAt(at.url);
    (repo.dispatched ??= []).push({ branch, commit });
    (repo.named ??= []).push(at.releaseWorkflow ?? null);
    const said = repo.dispatch ?? { state: 'started' as const, workflow: 'Release (.github/workflows/release.yml)', run: 4242, url: 'https://github.com/acme/shop/actions/runs/4242' };
    return typeof said === 'function' ? said(branch, commit) : said;
  };
  ctx.readCompare = async (at, want) => {
    const repo = repoAt(at.url);
    const key = `${want.base}..${want.head}`;
    const commits = repo.between[key] ?? [];
    if (!contains(repo, want.head, want.base)) return { complete: true, baseSha: want.base, headSha: 'f'.repeat(40), paths: [], diff: '', commits: [] };
    /* A comparison cut short reads as GitHub's: too many commits to page through. */
    if (repo.cut.has(key)) return { complete: false, reason: 'incomplete-comparison' };
    if (repo.capped?.has(key)) return { complete: false, reason: 'too-many-files', lineage: { baseSha: want.base, headSha: want.head, commits } };
    return { complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new', commits };
  };
  ctx.readMerged = async (at, want) => contains(repoAt(at.url), want.base, want.head);
  ctx.readTags = async at => ({ tags: { ...repoAt(at.url).tags } });
  ctx.readBranches = async at => ({ heads: { ...repoAt(at.url).heads } });
  /* As a host takes a push with no old value: only where there is no such branch yet, one push at a time. */
  ctx.createBranch = async (at, branch, commit) => {
    const repo = repoAt(at.url);
    await repo.hold?.();
    if (repo.refusing) return { problem: repo.refusing };
    if (repo.heads[branch]) return { problem: `Hornhoof could not create the branch ${branch} in ${at.url}: it has that branch already.` };
    repo.heads[branch] = commit;
    (repo.made ??= []).push({ branch, commit });
    return { made: true };
  };
}

/* A department in turn 1..N, its open turn, and a checked candidate of one of its tasks ready for its head, the task in no
   turn yet: it joins one only as its result is accepted. */
export async function readyInTurn() {
  const f = await testsFixture();
  const [turn] = await f.db.select().from(turns).where(and(eq(turns.companyId, f.task.companyId), eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open')));
  await f.db.update(tasks).set({ turnId: null }).where(eq(tasks.id, f.task.id));
  const branch = `turn-${turn!.number}`;
  const repo: Repository = { heads: { main: BASE, [branch]: f.finalCommit, 'task-1': f.finalCommit, [`task-${f.task.number}`]: f.finalCommit }, tags: {}, holds: { [f.finalCommit]: [BASE] }, between: {}, cut: new Set() };
  serve(f.ctx, repo);
  await report(f.ctx, f.tester.id, f.task.id, f.verified());
  const route = (await f.detail()).echelons;
  const acceptance = { candidateId: route.candidateId!, revision: route.revision, integrationCommit: f.finalCommit };
  const accept = (changes: Partial<typeof acceptance> = {}) => report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Fast-forwarded the turn to the checked candidate.', acceptance: { ...acceptance, ...changes } });
  const openTurn = async () => (await f.db.select().from(turns).where(and(eq(turns.companyId, f.task.companyId), eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open'))))[0]!;
  return { ...f, turn: turn!, branch, repo, acceptance, accept, openTurn };
}

/* An approval card of a release commit, as ask_person and request_approval open it: Hornhoof names on it, apart from its
   words, what the release brings that no check covers, which the release takes only the approval of a card naming. */
export async function approvalCard(ctx: Ctx, task: Task, question: string, commit: string): Promise<Ask> {
  const unchecked = await uncheckedInRelease(ctx, task, commit);
  return { kind: 'approval', text: question, commit, ...(unchecked?.length ? { unchecked } : {}) };
}

/* The release of the open turn: a task its head holds to release it, what the repository's CI says of the release commit
   (green unless a test sets repo.ci) and the person's approval of it, asked through the release tool of a head. */
export async function releasing() {
  const f = await readyInTurn();
  await f.accept();
  const [release] = [(await createTask(f.ctx, { agentId: f.head.id }, {
    title: 'Release the turn', brief: 'Release the open turn.', body: 'Fast-forward main to the turn and tag it.',
    departmentId: f.task.departmentId!, assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination', small: true, riskClass: 'none',
  })).task];
  const R = f.finalCommit;
  f.repo.between[`${BASE}..${R}`] = [{ sha: R, parents: [BASE] }];
  await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: f.head.id, subscriptionId: f.head.subscriptionId!, taskId: release!.id, kind: 'conversation', prompt: 'Release', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken('release-head-tool-token-0123456789abcdef0123') });
  /* The person approves the card of commit as the release tools open it: naming what it brings that no check covers. */
  const approve = async (commit = R) => {
    const asked = await ask(f.ctx, f.head.id, release!.id, await approvalCard(f.ctx, release!, `Release turn ${f.turn.number}: main to ${commit}.`, commit));
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, asked.request.id, { approve: true });
    return asked.request;
  };
  await listen(f.app);
  const client = await mcp(f.app, 'release-head-tool-token-0123456789abcdef0123');
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text?: string }[] };
    const text = result.content.map(part => part.text ?? '').join('\n');
    return { isError: result.isError === true, text };
  };
  const recordRelease = (args: Record<string, unknown> = {}) => call('release_turn', { task: release!.number, commit: R, ...args });
  const department = async () => (await f.db.select().from(departments).where(eq(departments.id, f.task.departmentId!)))[0]!;
  return { ...f, release: release!, R, approve, client, call, recordRelease, department };
}

type Releasing = Awaited<ReturnType<typeof releasing>>;
const MADE = '5'.repeat(40);
const TOP = '6'.repeat(40);

/* Work of task-N after R, as its holder joins it to the turn branch: its commit made on R, then a merge on top. Without stray
   the merge takes task-N into the turn branch, whose head it is, and task-N stays at made. A stray commit pushed straight to the
   turn branch on R comes first: taken, the merge takes the turn branch into task-N and the turn branch goes to it by
   fast-forward; not taken, task-N is made on it and the merge takes task-N into the turn branch as before. own is the commit
   task-N is at, head the turn branch's. */
export function joinedAfterR(f: Releasing, task: number, stray?: { sha: string; taken: boolean }): { own: string; head: string } {
  const under = stray && !stray.taken ? stray.sha : f.R;
  if (stray) f.repo.holds[stray.sha] = [f.R, BASE];
  f.repo.holds[MADE] = [...(stray && !stray.taken ? [stray.sha] : []), f.R, BASE];
  const strayCommit = stray ? [{ sha: stray.sha, parents: [f.R] }] : [];
  if (stray?.taken) {
    f.repo.holds[TOP] = [MADE, stray.sha, f.R, BASE];
    f.repo.between[`${BASE}..${TOP}`] = [{ sha: f.R, parents: [BASE] }, ...strayCommit, { sha: MADE, parents: [f.R] }, { sha: TOP, parents: [MADE, stray.sha] }];
    f.repo.heads[f.branch] = f.repo.heads[`task-${task}`] = TOP;
    return { own: TOP, head: TOP };
  }
  f.repo.holds[TOP] = [MADE, ...(stray ? [stray.sha] : []), f.R, BASE];
  f.repo.between[`${BASE}..${TOP}`] = [{ sha: f.R, parents: [BASE] }, ...strayCommit, { sha: MADE, parents: [under] }, { sha: TOP, parents: [under, MADE] }];
  f.repo.heads[`task-${task}`] = MADE;
  f.repo.heads[f.branch] = TOP;
  return { own: MADE, head: TOP };
}

/* The holder's turn on its task went out, so its work starts: the server notes where the turn branch and main were then. */
export async function startTurnkeyWork(f: Pick<Releasing, 'db' | 'ctx' | 'task'>, holder: { id: string; subscriptionId: string | null }, taskId: string): Promise<void> {
  const [job] = await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: holder.id, subscriptionId: holder.subscriptionId!, taskId, kind: 'conversation', prompt: 'Work', timeoutMs: 900000, status: 'running', startedAt: new Date() }).returning();
  await startWork(f.ctx, job!.id);
}

/* Turnkey work after R: a member of a turnkey team did it whole on task-N with its own review, security check and tests,
   joined it to the turn branch and closed it with report, naming the commit it checked and where task-N started. Without stray
   task-N is made on R and the turn branch goes to it by fast-forward; with one, it joins as joinedAfterR says. */
export async function turnkeyAfterR(f: Releasing, stray?: { sha: string; taken: boolean }) {
  const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
  const holder = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, holder.id));
  const { task } = await f.create({ title: 'Turnkey change', assigneeAgentId: holder.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
  await startTurnkeyWork(f, holder, task.id);
  const joined = stray ? joinedAfterR(f, task.number, stray) : fastForwardedAfterR(f, task.number);
  const start = stray && !stray.taken ? stray.sha : f.R;
  await report(f.ctx, holder.id, task.id, { done: true, summary: 'Joined task-N to the turn branch after my own review, security check and tests.', turnkey: { commit: joined.own, baseCommit: start } });
  return { task, holder, ...joined };
}

/* Work of task-N made on R, and the turn branch fast-forwarded to it. */
function fastForwardedAfterR(f: Releasing, task: number): { own: string; head: string } {
  f.repo.holds[MADE] = [f.R, BASE];
  f.repo.between[`${BASE}..${MADE}`] = [{ sha: f.R, parents: [BASE] }, { sha: MADE, parents: [f.R] }];
  f.repo.heads[`task-${task}`] = f.repo.heads[f.branch] = MADE;
  return { own: MADE, head: MADE };
}
