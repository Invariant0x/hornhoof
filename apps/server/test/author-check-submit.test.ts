import { and, desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { taskEvents, testRuns } from '../src/db/schema.js';
import { submitWithAuthorCheck } from '../src/modules/tasks/author-check-submit.js';
import { TEST_SECRET as SECRET } from './helpers.js';
import { OTHER, qualityFixture, SHA } from './review-quality-fixture.js';

const config = (env: NodeJS.ProcessEnv = {}) => loadConfig({ HORNHOOF_SECRET: SECRET, UPDATE_CHECK_MS: '0', ...env });

describe('author check on submit', () => {
  it('is disabled by default and enabled only explicitly', () => {
    expect(config().authorCheck).toBe(false);
    expect(config({ AUTHOR_CHECK: '1' }).authorCheck).toBe(true);
  });

  it('keeps the old submission when disabled', async () => {
    const f = await qualityFixture();
    await submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, { summary: 'Done', evidence: 'Old path' });
    await expectOldSubmission(f);
  });

  it('keeps submissions without adapter input out of the runner and without a false quality pass', async () => {
    const f = await qualityFixture();
    f.app.ctx.config.authorCheck = true;
    await submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, { summary: 'Done', evidence: 'No adapter', review: { baseCommit: SHA } });
    await expectOldSubmission(f);
  });

  it('pins one remote check on the submission SHA and reuses it for repeats and races', async () => {
    const f = await qualityFixture();
    f.app.ctx.config.authorCheck = true;
    const input = { summary: 'Done', evidence: 'Remote check', review: { baseCommit: SHA, authorCheckPlan: 'plan-text' } };
    const first = await submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, input);
    const [run] = await authorRuns(f);
    expect(run).toMatchObject({ commitSha: SHA, parts: 1 });
    expect(run!.command).toContain(`--sha ${SHA} --base ${SHA} --plan 'plan-text'`);
    expect(first.task.externalWait).toMatchObject({ run: run!.id });
    const again = await submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, input);
    expect(again.task.externalWait).toMatchObject({ run: run!.id });
    await Promise.allSettled([submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, input), submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, input)]);
    expect(await authorRuns(f)).toHaveLength(1);
  });

  it('refuses a branch that moved between review capture and run pinning', async () => {
    const f = await qualityFixture();
    f.app.ctx.config.authorCheck = true;
    let reads = 0;
    f.app.ctx.readCommit = async (_repo, want) => ({ branch: 'branch' in want ? want.branch : `task-${want.task}`, commitSha: ++reads === 1 ? SHA : OTHER });
    const input = { summary: 'Done', evidence: 'Stale check', review: { baseCommit: SHA, authorCheckPlan: 'plan-text' } };
    await expect(submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, input)).rejects.toThrow(/moved|changed/);
    expect(await authorRuns(f)).toHaveLength(0);
  });
});

function jobOf(f: Awaited<ReturnType<typeof qualityFixture>>) {
  return { id: f.job.id, companyId: f.author.companyId, agentId: f.author.id, agentKind: f.author.kind, roleKey: f.author.roleKey, departmentId: f.author.departmentId, skills: f.author.skills };
}

async function authorRuns(f: Awaited<ReturnType<typeof qualityFixture>>) {
  const runs = await f.db.select().from(testRuns).where(eq(testRuns.taskId, f.task.id)).orderBy(desc(testRuns.number));
  return runs.filter(run => run.command.includes('check:author'));
}

async function expectOldSubmission(f: Awaited<ReturnType<typeof qualityFixture>>) {
  const submitted = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
  const runs = await f.db.select().from(testRuns).where(eq(testRuns.taskId, f.task.id));
  expect(submitted).toHaveLength(1);
  expect(runs).toHaveLength(1);
  expect((await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id))).every(event => event.data.authorCheckPending === undefined)).toBe(true);
}
