import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, testParts, testRuns } from '../src/db/schema.js';
import { evidenceOf, freshnessOf } from '../src/modules/testruns/evidence.js';
import { pumpTests } from '../src/modules/testruns/runs.js';
import { TEST_COMMIT, until } from './helpers.js';
import { company, done, gets, idle, nextOf } from './test-runs-company.js';

const MOVED = 'b'.repeat(40);

const atCommit = (commitSha: string, branch = 'release-checkout') => () => Promise.resolve({ branch, commitSha });

describe('one commit for a whole run', () => {
  it('pins the commit before any part goes out, so a branch that moves between parts changes nothing', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const asked: unknown[] = [];
    c.app.ctx.readCommit = async (repo, want) => {
      asked.push({ url: repo.url, token: repo.token, want });
      return { branch: 'release-checkout', commitSha: TEST_COMMIT };
    };
    const { call } = await c.turn(c.bruno);
    const started = await call('run_tests', { branch: 'release-checkout', command: 'make test -- {part}', parts: 2 });
    expect(started.error).toBe(false);
    expect(started.text).toContain(TEST_COMMIT);
    expect(started.text).toContain('release-checkout');
    expect(asked).toEqual([{ url: 'https://github.com/acme/shop.git', token: 'ghp_shop0123456789', want: { branch: 'release-checkout' } }]);
    const first = await nextOf(ivan.node, 'tests.run');
    expect(first).toMatchObject({ branch: 'release-checkout', commitSha: TEST_COMMIT });

    c.app.ctx.readCommit = atCommit(MOVED);
    ivan.node.send(done(first));
    const second = await nextOf(ivan.node, 'tests.run');
    expect(second).toMatchObject({ part: 2, branch: 'release-checkout', commitSha: TEST_COMMIT });
    ivan.node.send(done(second));
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);

    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toContain('Test run 1 passed');
    expect(prompt).toContain(TEST_COMMIT);
    expect(prompt).not.toContain(MOVED);
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'passed', branch: 'release-checkout', commitSha: TEST_COMMIT, parts: [{ commit: TEST_COMMIT }, { commit: TEST_COMMIT }] });
    expect((await c.db.select({ commitSha: testRuns.commitSha }).from(testRuns))).toEqual([{ commitSha: TEST_COMMIT }]);
  });

  it('reads the branch an agent names', async () => {
    const c = await company();
    const asked: unknown[] = [];
    c.app.ctx.readCommit = async (_repo, want) => {
      asked.push(want);
      return { branch: 'release-other', commitSha: TEST_COMMIT };
    };
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test', branch: 'release-other' });
    expect(asked).toEqual([{ branch: 'release-other' }]);
  });

  it('fails the whole run when one part checked another commit, and names both', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test -- {part}', parts: 2 });
    const one = await nextOf(ann.node, 'tests.run');
    const two = await nextOf(ivan.node, 'tests.run');
    ann.node.send(done(one));
    await nextOf(ann.node, 'tests.ack');
    ivan.node.send(done(two, { commit: MOVED }));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);

    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toContain('Test run 1 failed');
    expect(prompt).toMatch(new RegExp(`part 2 of 2 failed on dev-mac[^\\n]*it checked ${MOVED}, not the pinned commit ${TEST_COMMIT}`, 'i'));
    const state = JSON.parse((await call('test_run', { run: 1 })).text);
    expect(state).toMatchObject({ status: 'failed', commitSha: TEST_COMMIT, parts: [{ status: 'passed', commit: TEST_COMMIT }, { status: 'failed', commit: MOVED }] });
    expect(state.parts[1].why).toContain(MOVED);
  });

  it('fails the run when a part passed without saying which commit it checked', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    ivan.node.send(done(await nextOf(ivan.node, 'tests.run'), { commit: null }));
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 failed[\s\S]*did not say which commit it checked/);
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'failed', parts: [{ status: 'failed', commit: null }] });
  });

  it.each([
    { name: 'that failed on the pinned commit', end: { ok: false, exitCode: 1, error: 'failed', commit: TEST_COMMIT }, why: 'exit code 1' },
    { name: 'that never reached a commit', end: { ok: false, exitCode: null, error: 'clone_failed', commit: null }, why: 'the pinned commit could not be fetched' },
    { name: 'that ran out of time before saying where it was', end: { ok: false, exitCode: null, error: 'timeout', commit: null }, why: 'did not end within' },
    { name: 'whose command was killed on the pinned commit', end: { ok: false, exitCode: null, error: 'failed', commit: TEST_COMMIT }, why: 'it failed' },
    { name: 'whose node names no reason', end: { ok: false, exitCode: 2, error: null, commit: TEST_COMMIT }, why: 'exit code 2' },
  ])('keeps its own reason for a part $name', async ({ end, why }) => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    ivan.node.send(done(await nextOf(ivan.node, 'tests.run'), end));
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const state = JSON.parse((await call('test_run', { run: 1 })).text);
    expect(state.status).toBe('failed');
    expect(state.parts[0].why).toContain(why);
    expect(await c.wokeWith(c.bruno.id)).toContain(why);
    expect(await c.wokeWith(c.bruno.id)).not.toContain('not the pinned commit');
  });

  it('starts nothing and says why when the repository cannot say where the branch is', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    c.app.ctx.readCommit = async () => ({ problem: 'The repository has no branch main.' });
    const { call } = await c.turn(c.bruno);
    const refused = await call('run_tests', { branch: 'main', command: 'make test' });
    expect(refused).toEqual({ error: true, text: 'The repository has no branch main.' });
    expect(await c.db.select().from(testRuns)).toEqual([]);
    expect(await gets(c.app.ctx, ivan.node, 'tests.run')).toBe(false);
  });

  it('asks the repository nothing for a run the rules refuse anyway', async () => {
    const c = await company();
    const asked: unknown[] = [];
    c.app.ctx.readCommit = async (_repo, want) => {
      asked.push(want);
      return { branch: 'main', commitSha: TEST_COMMIT };
    };
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { branch: 'main', command: 'make test', parts: 2 })).error).toBe(true);
    expect(asked).toEqual([]);
  });

  it('runs a lost part again at the same commit, whatever its branch is at by then', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    const lost = await nextOf(ivan.node, 'tests.run');
    c.app.ctx.readCommit = atCommit(MOVED);
    ivan.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    const again = await nextOf(ivan.node, 'tests.run');
    expect(again.partId).not.toBe(lost.partId);
    expect(again.commitSha).toBe(TEST_COMMIT);
  });

  it('leaves a run of work as it was: no commit is read or asked of its parts', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const asked: unknown[] = [];
    c.app.ctx.readCommit = async (_repo, want) => {
      asked.push(want);
      return { branch: 'main', commitSha: TEST_COMMIT };
    };
    const { call } = await c.turn(c.bruno);
    await call('run_work', { command: 'make build', branch: 'main' });
    const part = await nextOf(ivan.node, 'tests.run');
    expect(part).toMatchObject({ kind: 'work', branch: 'main', commitSha: null });
    ivan.node.send(done(part, { commit: MOVED }));
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(asked).toEqual([]);
    expect(JSON.parse((await call('work_run', { run: 1 })).text)).toMatchObject({ status: 'done', parts: [{ status: 'done', commit: MOVED }] });
  });

  it('lets a run from before commits were pinned end as it always did', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { job, call } = await c.turn(c.bruno);
    const [row] = await c.db.insert(testRuns).values({ companyId: job.companyId, number: 1, taskId: c.task.id, agentId: c.bruno.id, jobId: job.id, departmentId: c.dev.id, command: 'make test', timeoutMs: 60_000 }).returning();
    await c.db.insert(testParts).values({ companyId: job.companyId, runId: row!.id, part: 1 });
    await pumpTests(c.app.ctx);
    const part = await nextOf(ivan.node, 'tests.run');
    expect(part).toMatchObject({ branch: null, commitSha: null });
    ivan.node.send(done(part, { commit: MOVED }));
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'passed', commitSha: null, parts: [{ status: 'passed', commit: MOVED }] });
  });

  it('shows the pinned commit in the pool, for a part that runs and one that waits', async () => {
    const c = await company();
    await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test -- {part}', parts: 2 });
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const pool = JSON.parse((await (await c.turn(orchestrator!, null)).call('pool')).text);
    expect(pool.machines[0].parts).toEqual([expect.objectContaining({ part: 1, commit: TEST_COMMIT })]);
    expect(pool.waiting).toEqual([expect.objectContaining({ part: 2, commit: TEST_COMMIT })]);
  });
});

describe('whether a run still proves its branch', () => {
  it.each([
    { commitSha: TEST_COMMIT, head: TEST_COMMIT, want: 'current' },
    { commitSha: TEST_COMMIT, head: MOVED, want: 'stale' },
    { commitSha: null, head: TEST_COMMIT, want: 'unknown' },
    { commitSha: TEST_COMMIT, head: null, want: 'unknown' },
    { commitSha: null, head: null, want: 'unknown' },
  ])('at $commitSha with the branch at $head it is $want', ({ commitSha, head, want }) => {
    expect(freshnessOf(commitSha, head)).toBe(want);
  });

  /* A run of the company's first task through run_tests, as its row stands. */
  const pinnedRun = async (c: Awaited<ReturnType<typeof company>>) => {
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test', branch: 'release-checkout' });
    return (await c.db.select().from(testRuns))[0]!;
  };

  it('holds while the branch is at the pinned commit, and goes stale with a new one', async () => {
    const c = await company();
    const run = await pinnedRun(c);
    expect(await evidenceOf(c.app.ctx, run)).toEqual({ commitSha: TEST_COMMIT, head: TEST_COMMIT, freshness: 'current', why: null });
    const asked: unknown[] = [];
    c.app.ctx.readCommit = async (repo, want) => {
      asked.push({ url: repo.url, want });
      return { branch: 'release-checkout', commitSha: MOVED };
    };
    expect(await evidenceOf(c.app.ctx, run)).toEqual({ commitSha: TEST_COMMIT, head: MOVED, freshness: 'stale', why: `The branch is at ${MOVED} now, not at the ${TEST_COMMIT} this run checked.` });
    expect(asked).toEqual([{ url: 'https://github.com/acme/shop.git', want: { branch: 'release-checkout' } }]);
  });

  it('cannot tell, and says why, when the branch cannot be read', async () => {
    const c = await company();
    const run = await pinnedRun(c);
    c.app.ctx.readCommit = async () => ({ problem: 'The repository has no branch release-checkout.' });
    expect(await evidenceOf(c.app.ctx, run)).toEqual({ commitSha: TEST_COMMIT, head: null, freshness: 'unknown', why: 'The repository has no branch release-checkout.' });
  });

  it('cannot tell when the repository is gone', async () => {
    const c = await company();
    const run = await pinnedRun(c);
    await c.db.update(departments).set({ repoUrl: null }).where(eq(departments.id, c.dev.id));
    expect(await evidenceOf(c.app.ctx, run)).toMatchObject({ commitSha: TEST_COMMIT, head: null, freshness: 'unknown', why: expect.stringContaining('repository') });
  });

  it('cannot tell for a run that pinned no commit, and asks the repository nothing', async () => {
    const c = await company();
    const { job } = await c.turn(c.bruno);
    const [run] = await c.db.insert(testRuns).values({ companyId: job.companyId, number: 1, taskId: c.task.id, agentId: c.bruno.id, jobId: job.id, departmentId: c.dev.id, branch: 'task-1', command: 'make test', timeoutMs: 60_000 }).returning();
    c.app.ctx.readCommit = () => Promise.reject(new Error('asked'));
    expect(await evidenceOf(c.app.ctx, run!)).toMatchObject({ commitSha: null, head: null, freshness: 'unknown', why: expect.stringContaining('pinned') });
  });
});
