import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { qualityFixture, SHA } from './review-quality-fixture.js';
import { submitWithAuthorCheck } from '../src/modules/tasks/author-check-submit.js';
import { TEST_SECRET as SECRET } from './helpers.js';

const config = (env: NodeJS.ProcessEnv = {}) => loadConfig({ HORNHOOF_SECRET: SECRET, UPDATE_CHECK_MS: '0', ...env });

describe('author check on submit', () => {
  it('is disabled by default and enabled only explicitly', () => {
    expect(config().authorCheck).toBe(false);
    expect(config({ AUTHOR_CHECK: '1' }).authorCheck).toBe(true);
  });

  it('keeps the old submission when disabled', async () => {
    const f = await qualityFixture();
    const moved = await submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, { summary: 'Done', evidence: 'Old path' });
    expect(moved.task.status).toBe('done');
  });

  it('keeps submissions without adapter input out of the runner and without a false quality pass', async () => {
    const f = await qualityFixture();
    f.app.ctx.config.authorCheck = true;
    const moved = await submitWithAuthorCheck(f.app.ctx, jobOf(f), f.task.id, { summary: 'Done', evidence: 'No adapter', review: { baseCommit: SHA } });
    expect(moved.task.status).toBe('done');
    expect(moved.task.externalWait).toBeNull();
  });
});

function jobOf(f: Awaited<ReturnType<typeof qualityFixture>>) {
  return { id: f.job.id, companyId: f.author.companyId, agentId: f.author.id, agentKind: f.author.kind, roleKey: f.author.roleKey, departmentId: f.author.departmentId, skills: f.author.skills };
}
