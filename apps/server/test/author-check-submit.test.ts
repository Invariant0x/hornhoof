import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { taskEvents, testRuns } from '../src/db/schema.js';
import { submitWithAuthorCheck } from '../src/modules/tasks/author-check-submit.js';
import { TEST_SECRET as SECRET } from './helpers.js';
import { qualityFixture, SHA } from './review-quality-fixture.js';

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
});

function jobOf(f: Awaited<ReturnType<typeof qualityFixture>>) {
  return { id: f.job.id, companyId: f.author.companyId, agentId: f.author.id, agentKind: f.author.kind, roleKey: f.author.roleKey, departmentId: f.author.departmentId, skills: f.author.skills };
}

async function expectOldSubmission(f: Awaited<ReturnType<typeof qualityFixture>>) {
  const submitted = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
  const runs = await f.db.select().from(testRuns).where(eq(testRuns.taskId, f.task.id));
  expect(submitted).toHaveLength(1);
  expect(runs).toHaveLength(1);
  expect((await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id))).every(event => event.data.authorCheckPending === undefined)).toBe(true);
}
