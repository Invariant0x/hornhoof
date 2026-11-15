import { describe, expect, it } from 'vitest';
import { submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const handIn = { summary: 'Implemented change with tests.', evidence: 'Named local tests passed.', review: { baseCommit: BASE } };

describe('submission paths scope with glob masks and automatic test files', () => {
  it('supports package and folder glob masks including dot-prefixed files while rejecting bare directory names (#762, #774)', async () => {
    const f = await fixture();

    /* Bare directory without * does not count as a scope mask (#762, #774). */
    const bareDir = (await f.create({ paths: ['apps/server/src/modules/tasks'] })).task;
    f.atCommit(HEAD, ['apps/server/src/modules/tasks/attachments.ts']);
    await expect(submit(f.ctx, f.author.id, bareDir.id, handIn)).rejects.toMatchObject({ status: 403 });

    /* Explicit folder and package glob masks match their subtree, including dot-prefixed files, and block outside paths. */
    const packageMask = (await f.create({ paths: ['apps/server/**', 'packages/*/src/**'] })).task;
    f.atCommit(HEAD, [
      'apps/server/package.json',
      'apps/server/.eslintrc.json',
      'apps/server/src/modules/tasks/attachments.ts',
      'packages/protocol/src/echelons.ts',
    ]);
    await submit(f.ctx, f.author.id, packageMask.id, handIn);
    expect((await f.detail(packageMask.id)).echelons).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id });

    const singleLevel = (await f.create({ paths: ['apps/server/src/modules/tasks/*'] })).task;
    f.atCommit(HEAD, ['apps/server/src/modules/tasks/sub/deep.ts']);
    await expect(submit(f.ctx, f.author.id, singleLevel.id, handIn)).rejects.toMatchObject({ status: 403 });
    f.atCommit(HEAD, ['apps/server/src/modules/tasks/attachments.ts']);
    await submit(f.ctx, f.author.id, singleLevel.id, handIn);
    expect((await f.detail(singleLevel.id)).echelons.stage).toBe('review');

    const repoMask = (await f.create({ paths: ['**'] })).task;
    f.atCommit(HEAD, ['.hornhoof/author-check.md', 'apps/server/src/app.ts']);
    await submit(f.ctx, f.author.id, repoMask.id, handIn);
    expect((await f.detail(repoMask.id)).echelons.stage).toBe('review');
  });

  it('preserves exact file path matching and rejects unrelated files', async () => {
    const f = await fixture();
    f.atCommit(HEAD, ['logic/other.ts']);
    await expect(submit(f.ctx, f.author.id, f.task.id, handIn)).rejects.toMatchObject({ status: 403 });
    f.atCommit(HEAD, ['sub/logic/totals.ts']);
    await expect(submit(f.ctx, f.author.id, f.task.id, handIn)).rejects.toMatchObject({ status: 403 });
    f.atCommit(HEAD, ['logic/totals.ts']);
    await submit(f.ctx, f.author.id, f.task.id, handIn);
    expect((await f.detail()).echelons.stage).toBe('review');
  });

  it('automatically allows accompanying test files (*.test.*, *.spec.*, **/test/**, **/tests/**, **/e2e/**) at submit and verdict', async () => {
    const f = await fixture();
    /* f.task has paths: ['logic/totals.ts'] without any test paths listed. */
    f.atCommit(HEAD, [
      'logic/totals.ts',
      'totals.test.ts',
      'totals.spec.ts',
      'logic/totals.test.ts',
      'apps/web/src/Totals.spec.tsx',
      'test/helpers.ts',
      'apps/server/test/task-files.test.ts',
      'apps/server/test/fixtures/sample.ts',
      'tests/setup.ts',
      'apps/server/tests/unit/totals.ts',
      'e2e/checkout.ts',
      'apps/web/e2e/helpers/auth.ts',
    ]);
    await submit(f.ctx, f.author.id, f.task.id, handIn);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id });

    /* Reviewer can record findings on accompanying test files, but not on out-of-scope production files. */
    await expect(
      verdict(f.ctx, f.reviewer.id, f.task.id, {
        pass: true,
        comment: 'Checked.',
        reviewedCommit: HEAD,
        issues: [{ category: 'mechanical', blocking: false, path: 'logic/other.ts', line: 1, harm: 'Outside scope.' }],
      }),
    ).rejects.toMatchObject({ status: 400 });

    await verdict(f.ctx, f.reviewer.id, f.task.id, {
      pass: true,
      comment: 'Checked candidate and accompanying tests.',
      reviewedCommit: HEAD,
      issues: [{ category: 'mechanical', blocking: false, path: 'apps/server/test/task-files.test.ts', line: 12, harm: 'Minor naming note in test.' }],
    });
    expect((await f.detail()).echelons.stage).toBe('tests');
  });

  it('keeps rejecting non-test lookalike production paths, unscoped tasks, and invalid scope patterns', async () => {
    const f = await fixture();
    for (const lookalike of ['apps/server/src/modules/testruns/runs.ts', 'logic/test.ts', 'logic/spec.ts', 'logic/contest.ts']) {
      f.atCommit(HEAD, ['logic/totals.ts', lookalike]);
      await expect(submit(f.ctx, f.author.id, f.task.id, handIn), lookalike).rejects.toMatchObject({ status: 403 });
    }

    /* An unscoped code task (paths: []) still refuses even test-only commits until the head approves paths. */
    const unscoped = (await f.create({ paths: undefined })).task;
    f.atCommit(HEAD, ['apps/server/test/only-test.test.ts']);
    await expect(submit(f.ctx, f.author.id, unscoped.id, handIn)).rejects.toMatchObject({ status: 403 });

    /* Trailing slash or traversal in scope patterns is rejected at task creation and route update. */
    await expect(f.create({ paths: ['apps/server/'] })).rejects.toMatchObject({ status: 400 });
    await expect(updateTask(f.ctx, f.head.id, f.task.id, { paths: ['../escape'] })).rejects.toMatchObject({ status: 400 });
  });
});
