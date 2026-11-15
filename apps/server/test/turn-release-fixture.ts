import { and, eq } from 'drizzle-orm';
import { hashToken } from '../src/crypto/tokens.js';
import { departments, jobs, tasks, testParts, testRuns, turns } from '../src/db/schema.js';
import { answer, ask, createTask, report } from '../src/modules/tasks/engine.js';
import type { Ctx } from '../src/app.js';
import { testsFixture } from './development-echelons-verification.js';
import { BASE } from './development-echelons-fixture.js';
import { listen, mcp } from './helpers.js';

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
  ctx.readCommit = async (_at, want) => {
    const branch = 'branch' in want ? want.branch : `task-${want.task}`;
    const commitSha = repo.heads[branch] ?? repo.tags[branch];
    return commitSha ? { branch, commitSha } : { problem: `The repository has no branch ${branch}.` };
  };
  ctx.readCompare = async (_at, want) => {
    const key = `${want.base}..${want.head}`;
    const commits = repo.between[key] ?? [];
    if (!contains(repo, want.head, want.base)) return { complete: true, baseSha: want.base, headSha: 'f'.repeat(40), paths: [], diff: '', commits: [] };
    /* A comparison cut short reads as GitHub's: too many commits to page through. */
    if (repo.cut.has(key)) return { complete: false, reason: 'incomplete-comparison' };
    return { complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new', commits };
  };
  ctx.readMerged = async (_at, want) => contains(repo, want.base, want.head);
  ctx.readTags = async () => ({ tags: { ...repo.tags } });
  ctx.readBranches = async () => ({ heads: { ...repo.heads } });
  /* As a host takes a push with no old value: only where there is no such branch yet, one push at a time. */
  ctx.createBranch = async (at, branch, commit) => {
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
  const run = await f.run();
  await report(f.ctx, f.tester.id, f.task.id, f.verified([run.id]));
  const route = (await f.detail()).echelons;
  const acceptance = { candidateId: route.candidateId!, revision: route.revision, integrationCommit: f.finalCommit };
  const accept = (changes: Partial<typeof acceptance> = {}) => report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Fast-forwarded the turn to the checked candidate.', acceptance: { ...acceptance, ...changes } });
  const openTurn = async () => (await f.db.select().from(turns).where(and(eq(turns.companyId, f.task.companyId), eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open'))))[0]!;
  return { ...f, turn: turn!, branch, repo, acceptance, accept, openTurn };
}

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
  /* A run of the turn's branch, as the machines would have finished it. */
  const fullRun = async (options: { commit?: string; reused?: number; failedPart?: boolean; status?: 'passed' | 'failed'; branch?: string } = {}) => {
    const commit = options.commit ?? R;
    const [run] = await f.db.insert(testRuns).values({
      companyId: f.task.companyId, number: 9000 + ++runs, taskId: release!.id, agentId: f.head.id, jobId: job!.id, departmentId: f.task.departmentId!,
      branch: options.branch ?? f.branch, commitSha: commit, command: 'npm test', parts: 2, timeoutMs: 600000, status: options.status ?? 'passed', finishedAt: new Date(),
      fileCache: options.reused ? { mode: 'cached', turn: f.turn.number, mainLine: true, fingerprints: [], reused: options.reused, preparationReused: false, wouldSkip: [], compared: 0, mismatches: [], notes: [] } : { mode: 'full', turn: f.turn.number, mainLine: true, fingerprints: [], reused: 0, preparationReused: false, wouldSkip: [], compared: 0, mismatches: [], notes: [] },
    }).returning();
    await f.db.insert(testParts).values([1, 2].map(part => ({ companyId: f.task.companyId, runId: run!.id, part, status: options.failedPart && part === 2 ? 'failed' as const : 'passed' as const, commit, exitCode: options.failedPart && part === 2 ? 1 : 0 })));
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
