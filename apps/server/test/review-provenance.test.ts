import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, subscriptions, taskEvents, tasks, testParts, turns } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { turnEffort } from '../src/modules/conversation/turn-effort.js';
import { FIRST, SECOND, fixture, rejectedFinding } from './review-fixture.js';

describe('pinned review provenance', () => {
  it('delivers the author run ID, exact SHA, verified part counts and computed gate counts', async () => {
    const { ctx, task, author, run, event } = await fixture();
    const good = await run(FIRST, 1);
    const stale = await run(SECOND, 2);
    await submit(ctx, author.id, task.id, { summary: 'Done', evidence: 'Both runs passed' });
    expect((await event('submitted')).data.review).toMatchObject({
      commit: FIRST, branch: `task-${task.number}`, authorId: author.id,
      gateCounts: { passed: 0, returned: 0 },
      runs: expect.arrayContaining([
        expect.objectContaining({ id: good.id, number: 1, commit: FIRST, verified: true, parts: { passed: 1, failed: 0, other: 0 } }),
        expect.objectContaining({ id: stale.id, number: 2, commit: SECOND, verified: false }),
      ]),
    });
  });

  it('rejects a verdict claiming a different commit without recording it', async () => {
    const { ctx, db, task, author, reviewer } = await fixture();
    await submit(ctx, author.id, task.id, { summary: 'Done', evidence: 'Checks' });
    await expect(verdict(ctx, reviewer.id, task.id, { pass: true, comment: 'Good', reviewedCommit: SECOND })).rejects.toMatchObject({ reason: 'task_invalid' });
    expect(await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict')))).toEqual([]);
  });

  it('retains the reviewed revision when its branch moves', async () => {
    const { ctx, task, author, reviewer, event, advance } = await fixture();
    await submit(ctx, author.id, task.id, { summary: 'Done', evidence: 'Checks' });
    const submitted = await event('submitted');
    advance();
    await verdict(ctx, reviewer.id, task.id, { pass: true, comment: 'Checked the pinned candidate', reviewedCommit: FIRST });
    expect((await event('verdict')).data.review).toMatchObject({ commit: FIRST, revision: (submitted.data.review as { revision: string }).revision });
    expect((await event('submitted')).data.review).toEqual(submitted.data.review);
  });

  it('gives the immutable evidence to the reviewer through the task tool', async () => {
    const { ctx, task, author, run, tools } = await fixture();
    const good = await run(FIRST, 1);
    await submit(ctx, author.id, task.id, { summary: 'Done', evidence: 'Checks' });
    const response = await (await tools()).callTool({ name: 'task', arguments: { task: task.number } });
    expect(response.isError).toBeFalsy();
    const content = response.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)).toMatchObject({ review: { commit: FIRST, runs: [expect.objectContaining({ id: good.id, verified: true })] } });
  });

  it('does not certify a passed run whose actual part failed', async () => {
    const f = await fixture();
    const run = await f.run(FIRST, 1);
    await f.db.update(testParts).set({ status: 'failed', exitCode: 1 }).where(eq(testParts.runId, run.id));
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Run says passed' });
    expect((await f.event('submitted')).data.review).toMatchObject({ runs: [expect.objectContaining({ id: run.id, verified: false, parts: { passed: 0, failed: 1, other: 0 } })] });
  });

  it('keeps one verdict under concurrent retries', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks' });
    const attempt = () => verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Checked', reviewedCommit: FIRST });
    const settled = await Promise.allSettled([attempt(), attempt()]);
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'verdict')))).toHaveLength(1);
  });

  it('rechecks the reviewer vendor if its subscription changes after assignment', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks' });
    await f.db.update(agents).set({ subscriptionId: f.author.subscriptionId }).where(eq(agents.id, f.reviewer.id));
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Good', reviewedCommit: FIRST })).rejects.toMatchObject({ reason: 'task_not_yours' });
  });
});

describe('structured findings and conditional repeats', () => {
  it.each(['security', 'data', 'spec'] as const)('gives the original reviewer only the immutable fix range for a blocking %s finding', async category => {
    const f = await rejectedFinding(category);
    const fixed = await f.fix();
    expect(fixed.task.panel).toEqual([f.reviewer.id]);
    expect(fixed.wakes[0]).toMatchObject({ agentId: f.reviewer.id, again: true });
    const wake = taskWakeOf(fixed.task, fixed.wakes[0]!);
    expect(turnEffort('high', ['low', 'medium', 'high'], [wake])).toBe('medium');
    expect((await f.read()).fixReview).toMatchObject({ reviewedCommit: FIRST, fixCommit: SECOND, findingIds: [f.finding.findingId] });
    expect((await f.event('submitted')).data.fixReviews).toEqual([expect.objectContaining({ reviewedCommit: FIRST, fixCommit: SECOND })]);
  });

  it('advances noneligible fixes using author proof without waking another review', async () => {
    const f = await rejectedFinding('other');
    const fixed = await f.fix();
    expect(fixed.task.merging).toBe(true);
    expect(fixed.wakes.map(w => w.why)).toEqual(['merge']);
  });

  it('does not label arbitrary first-review text as a mechanical repeat', async () => {
    const f = await fixture();
    const wake = taskWakeOf(f.task, { why: 'review', text: 'First look at this code' });
    expect(turnEffort('high', ['low', 'medium', 'high'], [wake])).toBe('high');
  });

  it('rejects new findings on unchanged code in a repeat', async () => {
    const f = await rejectedFinding();
    await f.fix();
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, comment: 'Another issue', reviewedCommit: SECOND, issues: [{ category: 'data', blocking: true, path: 'unchanged.ts', line: 1, harm: 'Unrelated behavior' }] })).rejects.toMatchObject({ reason: 'task_invalid' });
  });

  it('keeps an unavailable fix diff degraded and refuses to claim PASS', async () => {
    const f = await rejectedFinding();
    f.advance();
    f.ctx.readCompare = async () => ({ complete: false, reason: 'compare-unavailable' });
    await f.run(SECOND, 1);
    const moved = await submit(f.ctx, f.author.id, f.task.id, { summary: 'Fix', evidence: 'Unit check' });
    expect(moved.task.panel).toEqual([f.reviewer.id]);
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Good', reviewedCommit: SECOND })).rejects.toMatchObject({ reason: 'task_invalid' });
  });

  it('submits with explicit degraded provenance when refs are down and refuses an unpinned PASS', async () => {
    const f = await fixture();
    f.ctx.readCommit = async () => { throw new Error('repository unavailable'); };
    const moved = await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks' });
    expect(moved.task.status).toBe('review');
    expect((await f.event('submitted')).data.review).toMatchObject({ commit: null, status: 'degraded' });
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Good' })).rejects.toMatchObject({ reason: 'task_invalid' });
  });

  it('does not substitute another reviewer when the original finding author is unavailable', async () => {
    const f = await rejectedFinding();
    await f.hire('Replacement reviewer', 'worker', 'DEV-REV', f.reviewer.subscriptionId!);
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id));
    const fixed = await f.fix();
    expect(fixed.task.panel).toEqual([]);
    expect(fixed.wakes.some(wake => wake.why === 'review')).toBe(false);
    expect(fixed.wakes).toEqual([expect.objectContaining({ agentId: f.head.id, why: 'switched' })]);
  });
});

describe('the mechanical-changes producer for task 459', () => {
  it('marks a changes wake only for structurally mechanical blocking issues', async () => {
    const f = await rejectedFinding('mechanical');
    expect(f.returned.wakes[0]).toMatchObject({ why: 'changes', mechanical: true });
    expect(taskWakeOf(f.returned.task, f.returned.wakes[0]!)).toMatchObject({ mechanical: true });
  });

  it('keeps a mixed blocking panel at the base, including a legacy return', async () => {
    const f = await fixture();
    const [otherPlan] = await f.db.insert(subscriptions).values({ companyId: f.author.companyId, provider: 'kimi', kind: 'personal', label: 'Other reviewer', ownerPersonId: f.ceo.id, status: 'ready' }).returning();
    const second = await f.hire('Second reviewer', 'worker', 'DEV-REV', otherPlan!.id);
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks' });
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, comment: 'Missing translation key', reviewedCommit: FIRST, issues: [{ category: 'mechanical', blocking: true, path: 'i18n/en.ts', line: 1, harm: 'The person sees a missing label.' }] });
    const mixed = await verdict(f.ctx, second.id, f.task.id, { pass: false, comment: 'Investigate data handling', reviewedCommit: FIRST });
    expect(mixed.wakes.find(w => w.why === 'changes')).not.toHaveProperty('mechanical');
  });
});

describe('explicit finding confirmation', () => {
  it('does not turn a reviewer verdict into a confirmed metric', async () => {
    const f = await rejectedFinding();
    expect((await f.read()).reviewFindings).toMatchObject({ confirmedCount: 0, byVendor: [] });
  });

  it('lets the real head confirm existence before a fix without removing the block', async () => {
    const f = await rejectedFinding();
    expect((await f.confirm()).isError).toBeFalsy();
    expect((await f.read()).reviewFindings).toMatchObject({ confirmedCount: 1, byVendor: [{ vendor: 'codex', count: 1, findingIds: [f.finding.findingId] }] });
    const [task] = await f.db.select().from(tasks).where(eq(tasks.id, f.task.id));
    expect(task).toMatchObject({ status: 'open', stage: 0, merging: false });
    const history = await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id)).orderBy(taskEvents.id);
    expect(history.at(-1)!.data.findingConfirmation).toMatchObject({ findingId: f.finding.findingId, actorId: f.head.id, fixCommit: null, confirmed: true });
  });

  it('refuses the reviewer and an unrelated employee', async () => {
    const f = await rejectedFinding();
    const outsider = await f.hire('Other', 'worker', 'DEV-BE');
    expect((await f.confirm(f.reviewer)).isError).toBe(true);
    expect((await f.confirm(outsider)).isError).toBe(true);
    expect((await f.read()).reviewFindings.confirmedCount).toBe(0);
  });

  it('requires the actual author to name a current fix and rejects stale revisions and SHAs', async () => {
    const f = await rejectedFinding();
    expect((await f.confirm(f.author)).isError).toBe(true);
    await f.fix();
    expect((await f.confirm(f.author, { fixCommit: FIRST })).isError).toBe(true);
    expect((await f.confirm(f.author, { fixCommit: SECOND, revision: '00000000-0000-4000-8000-000000000000' })).isError).toBe(true);
    expect((await f.confirm(f.author, { fixCommit: SECOND })).isError).toBeFalsy();
    expect((await f.read()).reviewFindings.confirmedCount).toBe(1);
    expect((await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]!.panel).toEqual([f.reviewer.id]);
  });

  it('checks current ownership rather than accepting a declared author', async () => {
    const f = await rejectedFinding();
    await f.fix();
    const other = await f.hire('Replacement', 'worker', 'DEV-BE');
    await f.db.update(tasks).set({ executorAgentId: other.id }).where(eq(tasks.id, f.task.id));
    expect((await f.confirm(f.author, { fixCommit: SECOND })).isError).toBe(true);
    expect((await f.confirm(other, { fixCommit: SECOND })).isError).toBe(true);
    expect((await f.read()).reviewFindings.confirmedCount).toBe(0);
  });

  it('deduplicates concurrent confirmations and keeps revocation history without editing the source', async () => {
    const f = await rejectedFinding();
    const original = await f.event('verdict');
    const client = await f.tools(f.head);
    const args = { task: f.task.number, findingId: f.finding.findingId, revision: f.finding.revision, confirmed: true, reason: 'Verified' };
    const responses = await Promise.all([client.callTool({ name: 'confirm_finding', arguments: args }), client.callTool({ name: 'confirm_finding', arguments: args })]);
    expect(responses.every(r => !r.isError)).toBe(true);
    expect((await f.read()).reviewFindings.confirmedCount).toBe(1);
    expect((await f.confirm(f.head, { confirmed: false, reason: 'The defect was disproved' })).isError).toBeFalsy();
    expect((await f.read()).reviewFindings.confirmedCount).toBe(0);
    const history = (await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id))).filter(e => e.data.findingConfirmation);
    expect(history).toHaveLength(2);
    expect(await f.event('verdict')).toEqual(original);
  });

  it('keeps legacy numeric findings out of the confirmed IDs', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks' });
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Legacy', findings: 7, reviewedCommit: FIRST });
    const result = await (await f.tools()).callTool({ name: 'task', arguments: { task: f.task.number } });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text).reviewFindings).toMatchObject({ confirmedCount: 0, issues: [], legacyUncounted: 1 });
  });

  it('rejects a repository answer for another fix SHA', async () => {
    const f = await rejectedFinding();
    await f.fix();
    f.ctx.readCompare = async (_repo, refs) => ({ complete: true, baseSha: refs.base, headSha: FIRST, paths: [], diff: '' });
    expect((await f.confirm(f.author, { fixCommit: SECOND })).isError).toBe(true);
    expect((await f.read()).reviewFindings.confirmedCount).toBe(0);
  });

  it('rejects ownership changed while the immutable range was being read', async () => {
    const f = await rejectedFinding();
    await f.fix();
    const other = await f.hire('New owner', 'worker', 'DEV-BE');
    f.ctx.readCompare = async (_repo, refs) => {
      await f.db.update(tasks).set({ executorAgentId: other.id }).where(eq(tasks.id, f.task.id));
      return { complete: true, baseSha: refs.base, headSha: refs.head, paths: ['logic/totals.ts'], diff: '+fix' };
    };
    expect((await f.confirm(f.head, { fixCommit: SECOND })).isError).toBe(true);
    expect((await f.read()).reviewFindings.confirmedCount).toBe(0);
  });

  it('delivers vendor provenance in the pipeline report without inventing a legacy baseline', async () => {
    const f = await rejectedFinding();
    const companyId = f.author.companyId;
    const [baseline] = await f.db.insert(turns).values({ companyId, number: 7, title: 'Baseline', goal: '', status: 'closed', openedAt: new Date(Date.now() - 10000), closedAt: new Date(Date.now() - 5000) }).returning();
    const [current] = await f.db.insert(turns).values({ companyId, number: 8, title: 'Current', goal: '', status: 'open', openedAt: new Date() }).returning();
    const [old] = await f.db.insert(tasks).values({ companyId, number: 100, turnId: baseline!.id, departmentId: f.author.departmentId, title: 'Legacy review', brief: '', body: '', status: 'done', executorAgentId: f.head.id, closedAt: new Date() }).returning();
    await f.db.insert(taskEvents).values({ companyId, taskId: old!.id, kind: 'verdict', agentId: f.reviewer.id, text: 'Legacy', data: { pass: true, findings: 7 } });
    await f.db.update(tasks).set({ turnId: current!.id }).where(eq(tasks.id, f.task.id));
    expect((await f.confirm()).isError).toBeFalsy();
    const [orchestrator] = await f.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const result = await (await f.tools(orchestrator!)).callTool({ name: 'pipeline_report', arguments: { turn: 8 } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as { text: string }[])[0]!.text).reviewFindings).toMatchObject({
      current: { confirmedCount: 1, byVendor: [{ vendor: 'codex', count: 1, findingIds: [f.finding.findingId] }] },
      baseline: { confirmedCount: null, status: 'unavailable', reason: 'legacy-verdicts-have-no-confirmation-provenance' },
    });
  });
});
