import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { departments, jobs, taskEvents, tasks, testRuns } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { archiveRef } from '../src/modules/repos/prune-run.js';
import { PRUNE_EVERY_MS, pruneCompany, pruneRound } from '../src/modules/repos/prune-job.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { prepareTemplates } from './templates-once.js';
import { serve, serveEach, type Repository } from './turn-release-fixture.js';
import { company, HOLDS, M1, M2, T1, U1, U2, withTask, type Fixture } from './prune-fixture.js';

await prepareSharedDatabase();
prepareTemplates();

const logOf = (f: Fixture, taskId: string) => f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'comment')));
const idOf = async (f: Fixture, number: number) => (await f.db.select().from(tasks).where(and(eq(tasks.companyId, f.task.companyId), eq(tasks.number, number))))[0]!.id;

describe('pruning the repositories of a company by its records', () => {
  it('deletes the branches a turn or main holds, archives what only a closed task holds, touches no other, and logs each on its task', async () => {
    const f = await company();
    const held = await withTask(f, 'In the turn', { status: 'done', closedDaysAgo: 1 });
    const inMain = await withTask(f, 'In main', { status: 'done', closedDaysAgo: 30 });
    const cancelled = await withTask(f, 'Cancelled', { status: 'cancelled', closedDaysAgo: 1 });
    const open = await withTask(f, 'Open', {});
    const paused = await withTask(f, 'Paused', { paused: true });
    Object.assign(f.repo.heads, {
      [`task-${held}`]: T1, [`release-check-${held}`]: T1, [`task-${inMain}`]: M1, [`task-${cancelled}`]: U1, [`task-${open}`]: U2, [`task-${paused}`]: U2,
      'feature/mine': U1, 'task-99999': U1,
    });
    const done = await pruneCompany(f.ctx, { companyId: f.task.companyId, apply: true });
    expect(done).toHaveLength(1);
    expect(done[0]!.result.stopped).toBeNull();
    expect(Object.keys(f.repo.heads).sort()).toEqual(['feature/mine', 'main', f.branch, `task-${open}`, `task-${paused}`, 'task-99999'].sort());
    expect(f.archived).toEqual({ [archiveRef(`task-${cancelled}`)]: U1 });
    const written = (await logOf(f, await idOf(f, held))).filter(e => (e.data as { pruned?: unknown }).pruned);
    expect(written.map(e => (e.data as { pruned: { branch: string } }).pruned.branch).sort()).toEqual([`release-check-${held}`, `task-${held}`]);
    expect(written.find(e => (e.data as { pruned: { branch: string } }).pruned.branch === `task-${held}`)).toMatchObject({ agentId: null, personId: null, data: { pruned: { branch: `task-${held}`, head: T1, action: 'deleted', reason: expect.stringContaining(f.branch) as unknown } } });
    expect((await logOf(f, await idOf(f, cancelled))).find(e => (e.data as { pruned?: unknown }).pruned)?.data).toMatchObject({ pruned: { branch: `task-${cancelled}`, head: U1, action: 'archived', restore: expect.stringContaining(archiveRef(`task-${cancelled}`)) as unknown } });
    expect(await logOf(f, await idOf(f, open))).toEqual([]);
  });

  it('changes and logs nothing on a dry run, and counts what it would do by what each branch is', async () => {
    const f = await company();
    const held = await withTask(f, 'In the turn', { status: 'done', closedDaysAgo: 1 });
    const cancelled = await withTask(f, 'Cancelled', { status: 'cancelled', closedDaysAgo: 1 });
    const open = await withTask(f, 'Open', {});
    Object.assign(f.repo.heads, { [`task-${held}`]: T1, [`task-${cancelled}`]: U1, [`task-${open}`]: U2, 'feature/mine': U1 });
    const before = { ...f.repo.heads };
    const [dry] = await pruneCompany(f.ctx, { companyId: f.task.companyId, apply: false });
    expect(f.pushed).toEqual([]);
    expect(f.repo.heads).toEqual(before);
    expect(dry!.counts).toMatchObject({ main: 1, held: 1, archive: 1, live: 1, foreign: 1, 'turn-kept': 1 });
    expect(dry!.result.verdicts.map(v => v.branch)).toContain('feature/mine');
    expect((await f.db.select().from(taskEvents).where(eq(taskEvents.kind, 'comment'))).filter(e => (e.data as { pruned?: unknown }).pruned)).toEqual([]);
  });

  it('judges a branch of a task only by a task of this repository: another department\'s task of the same number is not it', async () => {
    const f = await company();
    const number = await withTask(f, 'In the turn', { status: 'done', closedDaysAgo: 1 });
    const [other] = await f.db.insert(departments).values({ companyId: f.task.companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/other.git' }).returning();
    await f.db.update(tasks).set({ departmentId: other!.id }).where(eq(tasks.id, await idOf(f, number)));
    f.repo.heads[`task-${number}`] = T1;
    const elsewhere: Repository = { heads: { main: M2 }, tags: {}, holds: HOLDS, between: {}, cut: new Set() };
    serveEach(f.ctx, url => (url.endsWith('other.git') ? elsewhere : f.repo));
    const [first] = (await pruneCompany(f.ctx, { companyId: f.task.companyId, apply: true })).filter(r => r.repository.url.endsWith('shop.git'));
    expect(first!.result.verdicts.find(v => v.branch === `task-${number}`)).toMatchObject({ action: 'keep', category: 'foreign' });
    expect(f.repo.heads[`task-${number}`]).toBe(T1);
  });

  it('knows a test run\'s own branch as a record, and the turns of its department, and keeps a name it has no record of', async () => {
    const f = await company();
    const number = await withTask(f, 'Closed', { status: 'done', closedDaysAgo: 1 });
    const taskId = await idOf(f, number);
    const [job] = await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: f.head.id, subscriptionId: f.head.subscriptionId!, taskId, kind: 'conversation', prompt: 'Run', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken('prune-job-test-token-0123456789abcdef0123') }).returning();
    await f.db.insert(testRuns).values({ companyId: f.task.companyId, number: 9001, taskId, agentId: f.head.id, jobId: job!.id, departmentId: f.task.departmentId!, branch: 'release-checks-x', commitSha: M2, command: 'x', parts: 1, timeoutMs: 1000, status: 'passed', finishedAt: new Date() });
    Object.assign(f.repo.heads, { 'release-checks-x': M1, 'scratch-by-hand': M1 });
    await pruneCompany(f.ctx, { companyId: f.task.companyId, apply: true });
    expect(f.repo.heads['release-checks-x']).toBeUndefined();
    expect(f.repo.heads['scratch-by-hand']).toBe(M1);
    expect(f.repo.heads[f.branch]).toBe(T1);
  });

  it('prunes nothing of a repository it could not read whole, and says why', async () => {
    const f = await company();
    const number = await withTask(f, 'In the turn', { status: 'done', closedDaysAgo: 1 });
    f.repo.heads[`task-${number}`] = T1;
    f.ctx.readTags = async () => ({ problem: 'Hornhoof could not read the tags: it answered 502.' });
    const [run] = await pruneCompany(f.ctx, { companyId: f.task.companyId, apply: true });
    expect(run!.result).toMatchObject({ entries: [], stopped: { why: 'unreadable', problem: expect.stringContaining('502') as unknown } });
    expect(f.pushed).toEqual([]);
    expect(f.repo.heads[`task-${number}`]).toBe(T1);
  });
});

describe('the round that prunes by itself', () => {
  const on = (f: Fixture) => { f.ctx.config = { ...f.ctx.config, branchPrune: true }; };

  it('does nothing unless it was switched on', async () => {
    const f = await company();
    const number = await withTask(f, 'In the turn', { status: 'done', closedDaysAgo: 1 });
    f.repo.heads[`task-${number}`] = T1;
    await pruneRound(f.ctx, new Date());
    expect(f.repo.heads[`task-${number}`]).toBe(T1);
    expect(f.pushed).toEqual([]);
  });

  it('prunes one repository in a round, not again before its time, and again after it', async () => {
    const f = await company();
    on(f);
    const first = await withTask(f, 'One', { status: 'done', closedDaysAgo: 1 });
    f.repo.heads[`task-${first}`] = T1;
    const start = new Date('2026-11-23T12:00:00Z');
    await pruneRound(f.ctx, start);
    expect(f.repo.heads[`task-${first}`]).toBeUndefined();
    const second = await withTask(f, 'Two', { status: 'done', closedDaysAgo: 1 });
    f.repo.heads[`task-${second}`] = T1;
    await pruneRound(f.ctx, new Date(start.getTime() + PRUNE_EVERY_MS - 1));
    expect(f.repo.heads[`task-${second}`]).toBe(T1);
    await pruneRound(f.ctx, new Date(start.getTime() + PRUNE_EVERY_MS));
    expect(f.repo.heads[`task-${second}`]).toBeUndefined();
  });

  it('waits out GitHub\'s limit as the reset time says, and goes on after it', async () => {
    const f = await company();
    on(f);
    const number = await withTask(f, 'In the turn', { status: 'done', closedDaysAgo: 1 });
    f.repo.heads[`task-${number}`] = T1;
    const start = new Date('2026-11-23T12:00:00Z');
    const { GitHubRateLimited } = await import('../src/modules/testruns/github-limit.js');
    const resetAt = start.getTime() + 40 * 60_000;
    f.ctx.readMerged = async () => { throw new GitHubRateLimited({ remaining: 0, resetAt }); };
    await pruneRound(f.ctx, start);
    expect(f.repo.heads[`task-${number}`]).toBe(T1);
    serve(f.ctx, f.repo);
    await pruneRound(f.ctx, new Date(start.getTime() + PRUNE_EVERY_MS));
    expect(f.repo.heads[`task-${number}`]).toBe(T1);
    await pruneRound(f.ctx, new Date(resetAt + 1));
    expect(f.repo.heads[`task-${number}`]).toBeUndefined();
  });
});
