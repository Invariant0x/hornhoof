import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, subscriptions, taskEvents, tasks, testRuns } from '../src/db/schema.js';
import { leaveWork, regateWaiting, submit, verdict } from '../src/modules/tasks/engine.js';
import { reviewDetails } from '../src/modules/tasks/review-details.js';
import { FIRST, SECOND, fixture, rejectedFinding } from './review-fixture.js';
import { qualityFixture } from './review-quality-fixture.js';

const problem = { category: 'data' as const, blocking: true, path: 'logic/totals.ts', line: 3, harm: 'A buyer loses the cart total.' };

async function twoReviewers(degraded = false) {
  const f = await fixture();
  const [plan] = await f.db.insert(subscriptions).values({ companyId: f.author.companyId, provider: 'kimi', kind: 'personal', label: 'Second reviewer', ownerPersonId: f.ceo.id, status: 'ready' }).returning();
  const second = await f.hire('Second reviewer', 'worker', 'DEV-REV', plan!.id);
  await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks' });
  await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, comment: 'First finding', reviewedCommit: FIRST, issues: [problem] });
  await verdict(f.ctx, second.id, f.task.id, { pass: false, comment: 'Second finding', reviewedCommit: FIRST, issues: [problem] });
  f.advance();
  f.ctx.readCompare = async (_repo, refs) => degraded ? { complete: false, reason: 'compare-unavailable' } : { complete: true, baseSha: refs.base, headSha: refs.head, paths: ['logic/totals.ts'], diff: '-old\n+fixed' };
  await f.run(SECOND, 1);
  await submit(f.ctx, f.author.id, f.task.id, { summary: 'Fixes', evidence: 'Unit checks' });
  return { ...f, second };
}

describe('the consolidated review fix pass', () => {
  it('retains another reviewer restriction after the first repeat verdict', async () => {
    const f = await twoReviewers(true);
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, comment: 'Still unfixed', reviewedCommit: SECOND });
    const visible = await reviewDetails(f.db, f.task.id, f.second.id);
    expect(visible.fixReview).toMatchObject({ reviewerId: f.second.id, status: 'degraded' });
    await expect(verdict(f.ctx, f.second.id, f.task.id, { pass: true, comment: 'Good', reviewedCommit: SECOND })).rejects.toMatchObject({ reason: 'task_invalid' });
    await expect(verdict(f.ctx, f.second.id, f.task.id, { pass: false, comment: 'New issue', reviewedCommit: SECOND, issues: [{ ...problem, path: 'unchanged.ts' }] })).rejects.toMatchObject({ reason: 'task_invalid' });
  });

  it('keeps a repeat blocked when the original reviewer leaves an active gate', async () => {
    const f = await rejectedFinding();
    await f.fix();
    await f.hire('Replacement', 'worker', 'DEV-REV', f.reviewer.subscriptionId!);
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id));
    await leaveWork(f.ctx, { personId: f.ceo.id }, f.reviewer);
    const [task] = await f.db.select().from(tasks).where(eq(tasks.id, f.task.id));
    expect(task).toMatchObject({ status: 'review', merging: false, panel: [], assigneeAgentId: f.head.id });
  });

  it('does not replace a blocked original reviewer during automatic reactivation', async () => {
    const f = await rejectedFinding();
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id));
    await f.fix();
    const replacement = await f.hire('Replacement', 'worker', 'DEV-REV', f.reviewer.subscriptionId!);
    await regateWaiting(f.ctx, { personId: f.ceo.id }, replacement, 'Reviewer ready');
    expect((await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]).toMatchObject({ status: 'review', panel: [], merging: false });
  });

  it('restores only the original reviewer and its explicit repeat signal', async () => {
    const f = await rejectedFinding();
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id));
    await f.fix();
    await f.db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, f.reviewer.id));
    const resumed = await regateWaiting(f.ctx, { personId: f.ceo.id }, f.reviewer, 'Original reviewer ready');
    expect(resumed.wakes).toEqual([expect.objectContaining({ agentId: f.reviewer.id, why: 'review', again: true })]);
  });

  it('does not pass a gate after one fix passed and another original reviewer left', async () => {
    const f = await twoReviewers();
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'First fixed', reviewedCommit: SECOND });
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.second.id));
    await leaveWork(f.ctx, { personId: f.ceo.id }, f.second);
    expect((await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]).toMatchObject({ status: 'review', merging: false, panel: [] });
  });

  it('rejects head confirmation without fix after area ownership changed', async () => {
    const f = await rejectedFinding();
    const replacement = await f.hire('New author', 'worker', 'DEV-BE');
    await f.db.update(tasks).set({ executorAgentId: replacement.id }).where(eq(tasks.id, f.task.id));
    expect((await f.confirm()).isError).toBe(true);
    expect((await f.read()).reviewFindings.confirmedCount).toBe(0);
  });

  it('retains historical vendor credit when the original reviewer is unavailable', async () => {
    const f = await rejectedFinding();
    await f.db.update(agents).set({ switchedOffAt: new Date(), removedAt: new Date(), subscriptionId: f.author.subscriptionId }).where(eq(agents.id, f.reviewer.id));
    expect((await f.confirm()).isError).toBeFalsy();
    expect((await f.read()).reviewFindings.byVendor).toEqual([{ vendor: 'codex', count: 1, findingIds: [f.finding.findingId] }]);
  });

  it('does not credit a live-branch run on B to a verdict pinned to A', async () => {
    const f = await fixture();
    await f.run(FIRST, 1);
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks A' });
    f.advance();
    await f.run(SECOND, 2);
    const result = await (await f.tools()).callTool({ name: 'verdict', arguments: { task: f.task.number, pass: true, comment: 'Reviewed A', reviewedCommit: FIRST } });
    expect(result.isError).toBeFalsy();
    expect((await f.event('verdict')).data.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ run: 2, commitSha: SECOND, proves: false })]));
    expect((result.content as { text: string }[])[0]!.text).toContain(FIRST);
  });

  it('revalidates visible quality after a receipt changed while retaining the historical snapshot', async () => {
    const f = await qualityFixture();
    await f.seed();
    expect((await f.read()).quality.status).toBe('passed');
    const [original] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
    const snapshot = original!.data.review as { quality: object; revision: string; gateCounts: object };
    await f.db.insert(taskEvents).values({ companyId: f.author.companyId, taskId: f.task.id, kind: 'comment', text: 'Review assignment', data: { reviewPlan: { threshold: 800, large: false, integrationReviewerId: null, degraded: [], assignments: [{ reviewerId: f.author.id, taskId: f.task.id, revision: snapshot.revision, authorId: f.author.id, authorVendor: 'claude', baseCommit: null, commit: FIRST, paths: ['logic/totals.ts'], commonContracts: [], runs: [], gateCounts: snapshot.gateCounts, quality: snapshot.quality }] } } });
    await f.db.update(testRuns).set({ status: 'failed' }).where(eq(testRuns.id, f.run.id));
    const visible = await reviewDetails(f.db, f.task.id, f.author.id);
    expect(visible.review!.quality.status).toBe('unavailable');
    expect(visible.review!.qualityAtSubmission.status).toBe('passed');
    expect(visible.reviewPlan!.assignments[0]!.quality.status).toBe('unavailable');
    expect((original!.data.review as { quality: { status: string } }).quality.status).toBe('passed');
  });

  it('binds direct engine verdict evidence to the pinned candidate too', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks A' });
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'A', reviewedCommit: FIRST, evidence: [{ run: 2, commitSha: SECOND, proves: true }] });
    expect((await f.event('verdict')).data.evidence).toEqual([expect.objectContaining({ commitSha: SECOND, proves: false })]);
  });

  it('rejects blocking findings attached to PASS', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks' });
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Good', reviewedCommit: FIRST, issues: [problem] })).rejects.toMatchObject({ reason: 'task_invalid' });
    expect(await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'verdict')))).toEqual([]);
  });
});
