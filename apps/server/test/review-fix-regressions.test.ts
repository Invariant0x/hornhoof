import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, taskEvents, testRuns } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { reviewDetails } from '../src/modules/tasks/review-details.js';
import { BASE, FIRST, SECOND, fixture, rejectedFinding } from './review-fixture.js';
import { qualityFixture } from './review-quality-fixture.js';

const problem = { category: 'data' as const, blocking: true, path: 'logic/totals.ts', line: 3, harm: 'A buyer loses the cart total.' };

describe('candidate source and quality regressions', () => {
  it('retains historical vendor credit when the original reviewer is unavailable', async () => {
    const f = await rejectedFinding();
    await f.db.update(agents).set({ switchedOffAt: new Date(), removedAt: new Date(), subscriptionId: f.author.subscriptionId }).where(eq(agents.id, f.reviewer.id));
    expect((await f.confirm()).isError).toBeFalsy();
    expect((await f.read()).reviewFindings.byVendor).toEqual([{ vendor: 'codex', count: 1, findingIds: [f.finding.findingId] }]);
  });

  it('does not credit a live-branch run on B to a verdict pinned to A', async () => {
    const f = await fixture();
    await f.run(FIRST, 1);
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks A', review: { baseCommit: BASE } });
    f.advance();
    await f.run(SECOND, 2);
    const result = await (await f.tools()).callTool({ name: 'verdict', arguments: { task: f.task.number, pass: true, comment: 'Reviewed A', reviewedCommit: FIRST } });
    expect(result.isError).toBeFalsy();
    expect((await f.event('verdict')).data).toMatchObject({ reviewedCommit: FIRST });
    expect((await f.event('submitted')).data.review).toMatchObject({ runs: [expect.objectContaining({ commit: FIRST, verified: true })] });
    expect((result.content as { text: string }[])[0]!.text).toContain(FIRST);
  });

  it('revalidates visible quality after a receipt changed while retaining the historical snapshot', async () => {
    const f = await qualityFixture();
    await f.seed();
    expect((await f.read()).quality.status).toBe('passed');
    const [original] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
    await f.db.update(testRuns).set({ status: 'failed' }).where(eq(testRuns.id, f.run.id));
    const visible = await reviewDetails(f.db, f.task.id);
    expect(visible.review!.quality.status).toBe('unavailable');
    expect(visible.review!.qualityAtSubmission.status).toBe('passed');
    expect((original!.data.review as { quality: { status: string } }).quality.status).toBe('passed');
  });

  it('binds direct engine verdict evidence to the pinned candidate too', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks A', review: { baseCommit: BASE } });
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'A', reviewedCommit: FIRST, evidence: [{ run: 2, commitSha: SECOND, proves: true }] });
    expect((await f.event('verdict')).data).toMatchObject({ reviewedCommit: FIRST });
    expect((await f.event('verdict')).data).not.toHaveProperty('evidence');
  });

  it('rejects blocking findings attached to PASS', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } });
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Good', reviewedCommit: FIRST, issues: [problem] })).rejects.toMatchObject({ reason: 'task_invalid' });
    expect(await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'verdict')))).toEqual([]);
  });
});
