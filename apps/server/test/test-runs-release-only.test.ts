import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { departments, tasks, testRuns } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { startRun } from '../src/modules/testruns/runs.js';
import { company } from './test-runs-company.js';

/* A shared run of every test goes only on a release; a change is checked by its author's local tests of what it touched. */
describe('where a test run may go', () => {
  it('refuses a task branch or any other with tests_not_release, reads no repository for it, and says why', async () => {
    const c = await company();
    const read = vi.spyOn(c.app.ctx, 'readCommit');
    const { call, job } = await c.turn(c.bruno);
    for (const input of [{ branch: `task-${c.task.number}` }, { suite: 'unit', branch: 'task-1-checkout' }, { command: 'npm test', branch: 'task-1-checkout' }, { branch: 'feature-cart' }, { branch: 'mainline' }, { branch: 'turn-x' }]) {
      const answer = await call('run_tests', input);
      expect(answer.error).toBe(true);
      expect(answer.text).toMatch(/is no release branch: shared test runs go only to main, a turn's branch turn-<number> or a release-<name> branch, so check your change with local tests of what it touched\.$/);
    }
    expect((await call('run_tests', { branch: 'feature-cart' })).text).toMatch(/^feature-cart is no release branch/);
    const runJob = { id: job.id, companyId: job.companyId, agentId: c.bruno.id, agentKind: 'employee', departmentId: c.dev.id } as never;
    await expect(startRun(c.app.ctx, runJob, { task: c.task.id, branch: 'feature-cart' })).rejects.toMatchObject({ status: 409, reason: 'tests_not_release' });
    expect(read).not.toHaveBeenCalled();
    expect(await c.db.select().from(testRuns)).toEqual([]);
  });

  it('refuses a name only like a release branch: another case, a longer name, a full ref, or no branch at all', async () => {
    const c = await company();
    const { call } = await c.turn(c.bruno);
    for (const branch of ['Main', 'TURN-31', 'turn-31-foo', 'refs/heads/turn-31', 'refs/heads/main']) {
      const answer = await call('run_tests', { branch });
      expect(answer.error).toBe(true);
      expect(answer.text).toBe(`${branch} is no release branch: shared test runs go only to main, a turn's branch turn-<number> or a release-<name> branch, so check your change with local tests of what it touched.`);
    }
    expect((await call('run_tests', {})).error).toBe(true);
    expect(await c.db.select().from(testRuns)).toEqual([]);
  });

  /* The repository has a tag release-review and no such branch: git would clone the tag, which no release branch is. */
  it('refuses a tag named like a release branch with tests_not_release, and starts no run', async () => {
    const c = await company();
    c.app.ctx.readCommit = async (_repo, want) => ({ branch: 'branch' in want ? want.branch : `task-${want.task}`, commitSha: 'b'.repeat(40), tag: true });
    const { call, job } = await c.turn(c.bruno);
    const answer = await call('run_tests', { branch: 'release-review' });
    expect(answer.error).toBe(true);
    expect(answer.text).toBe("release-review is a tag of the repository, not a branch: shared test runs go only to the branch main, a turn's branch turn-<number> or a release-<name> branch.");
    const runJob = { id: job.id, companyId: job.companyId, agentId: c.bruno.id, agentKind: 'employee', departmentId: c.dev.id } as never;
    await expect(startRun(c.app.ctx, runJob, { task: c.task.id, branch: 'release-review' })).rejects.toMatchObject({ status: 409, reason: 'tests_not_release' });
    expect(await c.db.select().from(testRuns)).toEqual([]);
  });

  it('takes no task branch of a repository whose results go to its own main line straight either', async () => {
    const c = await company();
    const [product] = await c.db.insert(departments).values({ companyId: c.dev.companyId, parentId: c.dev.id, name: 'Shop app', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop-app.git' }).returning();
    await c.db.update(tasks).set({ productId: product!.id }).where(eq(tasks.id, c.task.id));
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'npm test', branch: `task-${c.task.number}` })).text).toContain('is no release branch');
    expect(await c.db.select().from(testRuns)).toEqual([]);
  });

  it("runs on main, a turn's branch and a release branch, and on the main line its repository names", async () => {
    const c = await company();
    await c.db.update(departments).set({ repoBranch: 'network-1' }).where(eq(departments.id, c.dev.id));
    const { call } = await c.turn(c.bruno);
    for (const [index, branch] of ['main', 'turn-31', 'release-0.30.0', 'release-network', 'network-1'].entries()) {
      const started = await call('run_tests', { command: 'npm test', branch });
      expect(started.error, started.text).toBe(false);
      expect(started.text).not.toContain('no release branch');
      await call('stop_tests', { run: index + 1 });
    }
    expect((await c.db.select(only(testRuns, 'branch')).from(testRuns)).map(run => run.branch).sort()).toEqual(['main', 'network-1', 'release-0.30.0', 'release-network', 'turn-31']);
  });

  it('leaves other work free to clone a task branch', async () => {
    const c = await company();
    const { call } = await c.turn(c.bruno);
    expect((await call('run_work', { command: 'make', branch: `task-${c.task.number}` })).error).toBe(false);
  });
});
