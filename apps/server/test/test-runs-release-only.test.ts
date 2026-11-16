import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { departments, tasks, testRuns } from '../src/db/schema.js';
import { company } from './test-runs-company.js';

/* All whole runs go once per release, on its release branch; a change is checked in its author's own workspace. */
describe('where a test run may go', () => {
  it('refuses a whole run, one suite and a command on a task branch or any other, and reads no repository for it', async () => {
    const c = await company();
    const read = vi.spyOn(c.app.ctx, 'readCommit');
    const { call } = await c.turn(c.bruno);
    for (const input of [{}, { suite: 'unit' }, { profile: 'full' }, { command: 'npm test' }, { command: 'npm test', branch: 'task-1-checkout' }, { branch: `task-${c.task.number}` }, { branch: 'feature-cart' }, { branch: 'mainline' }, { branch: 'turn-x' }]) {
      const refused = await call('run_tests', input);
      expect(refused.error).toBe(true);
      expect(refused.text).toMatch(/^tests_not_release: /);
      expect(refused.text).toContain('AGENTS.md');
    }
    expect((await call('run_tests', {})).text).toContain(`#${c.task.number}'s own branch is not a release branch`);
    expect((await call('run_tests', { branch: 'feature-cart' })).text).toContain('feature-cart is not a release branch');
    expect(read).not.toHaveBeenCalled();
    expect(await c.db.select().from(testRuns)).toEqual([]);
  });

  it("runs on main, a turn's branch and a release branch, and on the main line its repository names", async () => {
    const c = await company();
    await c.db.update(departments).set({ repoBranch: 'network-1' }).where(eq(departments.id, c.dev.id));
    const { call } = await c.turn(c.bruno);
    for (const [index, branch] of ['main', 'turn-31', 'release-0.30.0', 'release-network', 'network-1'].entries()) {
      const started = await call('run_tests', { command: 'npm test', branch });
      expect(started.error, started.text).toBe(false);
      await call('stop_tests', { run: index + 1 });
    }
    expect((await c.db.select({ branch: testRuns.branch }).from(testRuns)).map(run => run.branch).sort()).toEqual(['main', 'network-1', 'release-0.30.0', 'release-network', 'turn-31']);
  });

  it('leaves other work free to clone a task branch', async () => {
    const c = await company();
    const { call } = await c.turn(c.bruno);
    expect((await call('run_work', { command: 'make', branch: `task-${c.task.number}` })).error).toBe(false);
  });

  it('takes any branch of a repository whose results go to its own main line straight, as each of them is a release of its own', async () => {
    const c = await company();
    const [product] = await c.db.insert(departments).values({ companyId: c.dev.companyId, parentId: c.dev.id, name: 'Shop app', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop-app.git' }).returning();
    await c.db.update(tasks).set({ productId: product!.id }).where(eq(tasks.id, c.task.id));
    const { call } = await c.turn(c.bruno);
    for (const [index, branch] of [undefined, `task-${c.task.number}-checkout`, 'task-99'].entries()) {
      const started = await call('run_tests', { command: 'npm test', ...(branch ? { branch } : {}) });
      expect(started.error, started.text).toBe(false);
      await call('stop_tests', { run: index + 1 });
    }
  });
});
