import { and, eq } from 'drizzle-orm';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, departments, jobs, tasks, teams, testParts, testRuns, turns } from '../src/db/schema.js';
import { answer, ask, createTask, report } from '../src/modules/tasks/engine.js';
import type { Ctx } from '../src/app.js';
import { testsFixture } from './development-echelons-verification.js';
import { BASE } from './development-echelons-fixture.js';
import { listen, mcp } from './helpers.js';
import { PRODUCT_FILES, partReceipt, partSelection, productSnapshot } from './product-run.js';

/* What a repository says in these tests: where each branch and tag is, and which commit holds which. A commit holds itself
   and whatever holds names for it; the commits between two are what between names. made lists the branches the server made,
   refusing says why the repository takes no new branch, and each push to make one waits at hold first. */
export type Repository = {
  heads: Record<string, string>;
  tags: Record<string, string>;
  holds: Record<string, string[]>;
  between: Record<string, { sha: string; parents: string[] }[]>;
  cut: Set<string>;
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
    const commitSha = repo.heads[branch] ?? repo.tags[branch];
    return commitSha ? { branch, commitSha } : { problem: `The repository has no branch ${branch}.`, missing: true };
  };
  ctx.readCompare = async (at, want) => {
    const repo = repoAt(at.url);
    const key = `${want.base}..${want.head}`;
    const commits = repo.between[key] ?? [];
    if (!contains(repo, want.head, want.base)) return { complete: true, baseSha: want.base, headSha: 'f'.repeat(40), paths: [], diff: '', commits: [] };
    /* A comparison cut short reads as GitHub's: too many commits to page through. */
    if (repo.cut.has(key)) return { complete: false, reason: 'incomplete-comparison' };
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

type RunOf = { departmentId: string; taskId: string; agentId: string; jobId: string };

/* The release of the open turn: a task its head holds to release it, the full run on the release commit and the person's
   approval of it, asked through the release tool of a head. */
export async function releasing() {
  const f = await readyInTurn();
  await f.accept();
  const [release] = [(await createTask(f.ctx, { agentId: f.head.id }, {
    title: 'Release the turn', brief: 'Release the open turn.', body: 'Fast-forward main to the turn and tag it.',
    departmentId: f.task.departmentId!, assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination', small: true, riskClass: 'none',
  })).task];
  const R = f.finalCommit;
  f.repo.between[`${BASE}..${R}`] = [{ sha: R, parents: [BASE] }];
  const [job] = await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: f.head.id, subscriptionId: f.head.subscriptionId!, taskId: release!.id, kind: 'conversation', prompt: 'Release', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken('release-head-tool-token-0123456789abcdef0123') }).returning();
  let runs = 0;
  const scope = { companyId: f.task.companyId, repositoryOwnerId: f.task.departmentId!, repoUrlHash: 'a'.repeat(64) };
  /* A run of the turn's branch, as the machines would have finished it: of the product's full profile, each part with its receipt
     on the commit, unless it ran a command of its own (command), which leaves neither.
     reused: green results it took, of its release unless it is from before releases were kept (ofRelease false).
     of: the department of another repository whose release it checks, with its release task, the agent who asked and its job. */
  const fullRun = async (options: { commit?: string; reused?: number; ofRelease?: boolean; suite?: string; failedPart?: boolean; status?: 'passed' | 'failed'; branch?: string; parts?: number; command?: string; of?: RunOf } = {}) => {
    const commit = options.commit ?? R, manual = options.command !== undefined;
    const of = options.of ?? { departmentId: f.task.departmentId!, taskId: release!.id, agentId: f.head.id, jobId: job!.id };
    const repositoryScope = { ...scope, repositoryOwnerId: of.departmentId };
    const snapshot = await productSnapshot(repositoryScope, commit);
    const [run] = await f.db.insert(testRuns).values({
      companyId: f.task.companyId, number: 9000 + ++runs, taskId: of.taskId, agentId: of.agentId, jobId: of.jobId, departmentId: of.departmentId,
      branch: options.branch ?? f.branch, commitSha: commit, command: options.command ?? '', parts: options.parts ?? 2, timeoutMs: 600000, status: options.status ?? 'passed', finishedAt: new Date(),
      ...(manual ? {} : {
        environmentRequest: { version: 1 as const, repositoryScope, ...(options.suite ? { suite: options.suite } : {}), requestId: null, nodeId: null, builtin: false, sentAt: null, attempts: 0, problem: null },
        environmentSnapshot: snapshot, environmentHash: snapshot.description.manifestHash,
        fileCache: { mode: options.reused ? 'cached' as const : 'full' as const, ...(options.ofRelease === false ? {} : { release: options.branch ?? f.branch }), fingerprints: [], reused: options.reused ?? 0, preparationReused: false, wouldSkip: [], compared: 0, mismatches: [], notes: [] },
      }),
    }).returning();
    const failed = (part: number) => options.failedPart === true && part === 2;
    if (options.parts !== 0) await f.db.insert(testParts).values(PRODUCT_FILES.map((file, index) => {
      const part = index + 1, selection = partSelection(commit, file);
      return { companyId: f.task.companyId, runId: run!.id, part, status: failed(part) ? 'failed' as const : 'passed' as const, commit, exitCode: failed(part) ? 1 : 0, finishedAt: new Date(),
        ...(manual ? {} : { environmentSelection: { selection, after: [] }, environmentReceipt: partReceipt(snapshot, selection, !failed(part)) }) };
    }));
    return run!;
  };
  const approve = async (commit = R) => {
    const asked = await ask(f.ctx, f.head.id, release!.id, { kind: 'approval', text: `Release turn ${f.turn.number}: main to ${commit}.`, commit });
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
  return { ...f, release: release!, R, fullRun, approve, client, call, recordRelease, department };
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

/* Turnkey work after R: a member of a turnkey team did it whole on task-N with its own review, security check and tests,
   joined it to the turn branch and closed it with report. */
export async function turnkeyAfterR(f: Releasing, stray?: { sha: string; taken: boolean }) {
  const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
  const holder = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, holder.id));
  const { task } = await f.create({ title: 'Turnkey change', assigneeAgentId: holder.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
  const joined = joinedAfterR(f, task.number, stray);
  await report(f.ctx, holder.id, task.id, { done: true, summary: 'Merged task-N into the turn branch after my own review, security check and tests.' });
  return { task, holder, ...joined };
}
