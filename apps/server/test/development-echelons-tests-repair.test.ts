import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskEvents } from '../src/db/schema.js';
import { report, submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { testsFixture, verified } from './development-echelons-verification.js';

const TEST_FIX = 'c'.repeat(40);
const SRC_FIX = 'd'.repeat(40);

function withCommits(
  f: Awaited<ReturnType<typeof testsFixture>>,
  headCommit: string,
  changes: Record<string, string[]>,
  branch = 'task-1',
) {
  f.ctx.readCommit = async (_repo, want) => ({ branch: 'branch' in want ? want.branch : branch, commitSha: headCommit });
  f.ctx.readCompare = async (_repo, refs) => {
    const paths = changes[`${refs.base}..${refs.head}`];
    return paths ? { complete: true, baseSha: refs.base, headSha: refs.head, paths, diff: '@@ -1 +1 @@\n-old\n+new' } : { complete: false, reason: 'not-an-ancestor' };
  };
}

describe('test-only repair and src/** return at Tests without task cancellation', () => {
  it.each([
    'test/totals.ts',
    'apps/server/tests/totals-helper.ts',
    'apps/web/e2e/checkout.ts',
    'totals.test.ts',
    'src/modules/totals.test.ts',
    'src/modules/totals.spec.ts',
  ])('lets Tests submit a test-only repair (%s) in the same candidate branch and verify it without cancelling', async testFile => {
    const f = await testsFixture();
    const initialCandidateId = f.snapshot.candidateId!;
    const initialRevision = f.snapshot.revision;
    withCommits(f, TEST_FIX, {
      [`${BASE}..${TEST_FIX}`]: ['logic/totals.ts', testFile],
      [`${HEAD}..${TEST_FIX}`]: [testFile],
    });

    const repaired = await submit(f.ctx, f.tester.id, f.task.id, {
      summary: `Fixed test expectation in ${testFile}.`,
      evidence: `npx vitest run ${testFile}`,
      review: { baseCommit: BASE },
    });
    expect(repaired.task.status).not.toBe('cancelled');
    expect(repaired.task.assigneeAgentId).toBe(f.tester.id);
    expect(repaired.wakes).toEqual([]);

    const afterRepair = (await f.detail()).echelons;
    expect(afterRepair).toMatchObject({ stage: 'tests', phase: 'active', ownerAgentId: f.tester.id });
    expect(afterRepair.candidateId).not.toBe(initialCandidateId);
    expect(afterRepair.revision).toBe(initialRevision + 1);

    const submissions = (await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id)).orderBy(asc(taskEvents.id)))
      .filter(event => event.kind === 'submitted');
    expect(submissions).toHaveLength(2);
    expect(submissions[0]!.data.candidate).toMatchObject({ id: initialCandidateId, parentId: null, commit: HEAD });
    expect(submissions[1]!.data.candidate).toMatchObject({
      id: afterRepair.candidateId,
      parentId: initialCandidateId,
      revision: initialRevision + 1,
      baseCommit: BASE,
      commit: TEST_FIX,
      branch: 'task-1',
      paths: ['logic/totals.ts', testFile],
      producedBy: { stage: 'tests', agentId: f.tester.id },
    });

    const checked = await report(f.ctx, f.tester.id, f.task.id, verified(afterRepair));
    expect(checked.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'ready', candidateId: afterRepair.candidateId });
  });

  it('refuses a Tests submission whose delta touches src/** or omits ancestry, keeping the current candidate intact', async () => {
    const f = await testsFixture();
    withCommits(f, TEST_FIX, {
      [`${BASE}..${TEST_FIX}`]: ['logic/totals.ts', 'src/totals.ts'],
      [`${HEAD}..${TEST_FIX}`]: ['src/totals.ts', 'test/totals.test.ts'],
    });
    await expect(submit(f.ctx, f.tester.id, f.task.id, {
      summary: 'Edited production code at Tests.', evidence: 'Vitest.', review: { baseCommit: BASE },
    })).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', phase: 'active', candidateId: f.snapshot.candidateId });

    withCommits(f, TEST_FIX, { [`${BASE}..${TEST_FIX}`]: ['logic/totals.ts', 'test/totals.test.ts'] });
    await expect(submit(f.ctx, f.tester.id, f.task.id, {
      summary: 'Force-pushed without parent commit.', evidence: 'Vitest.', review: { baseCommit: BASE },
    })).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.candidateId).toBe(f.snapshot.candidateId);
  });

  it('returns the candidate with a delta description to the code executor when src/** changes are needed, preserving immutable revision history', async () => {
    const f = await testsFixture();
    withCommits(f, TEST_FIX, {
      [`${BASE}..${TEST_FIX}`]: ['logic/totals.ts', 'test/totals.test.ts'],
      [`${HEAD}..${TEST_FIX}`]: ['test/totals.test.ts'],
    });
    await submit(f.ctx, f.tester.id, f.task.id, {
      summary: 'Added failing regression test for negative discounts.',
      evidence: 'npx vitest run test/totals.test.ts',
      review: { baseCommit: BASE },
    });
    const atTests = (await f.detail()).echelons;
    const delta = 'logic/totals.ts (src): clamp negative discount to zero before computing tax.';

    const returned = await report(f.ctx, f.tester.id, f.task.id, {
      done: false,
      summary: 'Regression test exposed unguarded negative discount in production totals.',
      verification: { candidateId: atTests.candidateId!, revision: atTests.revision, delta },
    });
    expect(returned.task).toMatchObject({ status: 'open', assigneeAgentId: f.author.id });
    expect(returned.task.status).not.toBe('cancelled');
    expect(returned.wakes.map(w => w.agentId)).toEqual([f.author.id]);
    expect(returned.wakes[0]?.note).toContain(delta);

    const backAtDev = (await f.detail()).echelons;
    expect(backAtDev).toMatchObject({
      stage: 'development',
      phase: 'active',
      ownerAgentId: f.author.id,
      candidateId: atTests.candidateId,
      revision: atTests.revision + 1,
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'development', status: 'active', ownerAgentId: f.author.id, inputCandidateId: atTests.candidateId }),
        expect.objectContaining({ stage: 'review', status: 'pending', ownerAgentId: f.reviewer.id }),
        expect.objectContaining({ stage: 'tests', status: 'pending', ownerAgentId: f.tester.id }),
      ]),
    });

    /* Re-submission must preserve the returned candidate commit in branch history and advance to the next revision. */
    withCommits(f, SRC_FIX, { [`${BASE}..${SRC_FIX}`]: ['logic/totals.ts', 'test/totals.test.ts'] });
    await expect(submit(f.ctx, f.author.id, f.task.id, {
      summary: 'Dropped tester commit.', evidence: 'Vitest.', review: { baseCommit: BASE },
    })).rejects.toMatchObject({ status: 409 });

    withCommits(f, SRC_FIX, {
      [`${BASE}..${SRC_FIX}`]: ['logic/totals.ts', 'test/totals.test.ts'],
      [`${TEST_FIX}..${SRC_FIX}`]: ['logic/totals.ts'],
    });
    const resubmitted = await submit(f.ctx, f.author.id, f.task.id, {
      summary: 'Clamped negative discount in logic/totals.ts.',
      evidence: 'npx vitest run test/totals.test.ts',
      review: { baseCommit: BASE },
    });
    expect(resubmitted.task.assigneeAgentId).toBe(f.reviewer.id);

    const events = await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id)).orderBy(asc(taskEvents.id));
    const candidates = events.filter(e => e.kind === 'submitted').map(e => e.data.candidate as { id: string; parentId: string | null; revision: number; commit: string });
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({ id: f.snapshot.candidateId, parentId: null, commit: HEAD });
    expect(candidates[1]).toMatchObject({ id: atTests.candidateId, parentId: f.snapshot.candidateId, commit: TEST_FIX });
    expect(candidates[2]).toMatchObject({
      parentId: atTests.candidateId,
      revision: backAtDev.revision + 1,
      commit: SRC_FIX,
    });
    expect(events.some(e => e.kind === 'report' && (e.data as { rework?: boolean }).rework === true)).toBe(true);

    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Fix matches delta.', reviewedCommit: SRC_FIX });
    const finalRoute = (await f.detail()).echelons;
    expect(finalRoute).toMatchObject({ stage: 'tests', phase: 'active', candidateId: candidates[2]!.id });
    const checked = await report(f.ctx, f.tester.id, f.task.id, verified(finalRoute));
    expect(checked.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect((await f.detail()).echelons.phase).toBe('ready');
  });
});
