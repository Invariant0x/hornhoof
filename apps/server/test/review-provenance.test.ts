import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, taskEvents, taskRoutes, tasks, turns } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { createRoute, routeOf } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { BASE, FIRST, SECOND, fixture, rejectedFinding } from './review-fixture.js';

describe('pinned review provenance', () => {
  it('delivers the exact SHA, branch, author and change of the pinned candidate, and no test runs', async () => {
    const { ctx, task, author, event } = await fixture();
    await submit(ctx, author.id, task.id, { summary: 'Done', evidence: 'Local tests passed', review: { baseCommit: BASE } });
    const review = (await event('submitted')).data.review;
    expect(review).toMatchObject({ commit: FIRST, branch: `task-${task.number}`, authorId: author.id, source: { baseCommit: BASE, commit: FIRST, paths: ['logic/totals.ts'] } });
    expect(review).not.toHaveProperty('runs');
    expect(review).not.toHaveProperty('quality');
  });

  it('rejects a verdict claiming a different commit without recording it', async () => {
    const { ctx, db, task, author, reviewer } = await fixture();
    await submit(ctx, author.id, task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } });
    await expect(verdict(ctx, reviewer.id, task.id, { pass: true, comment: 'Good', reviewedCommit: SECOND })).rejects.toMatchObject({ status: 409, reason: 'task_changed' });
    expect(await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict')))).toEqual([]);
  });

  it('retains the reviewed revision when its branch moves', async () => {
    const { ctx, task, author, reviewer, event, advance } = await fixture();
    await submit(ctx, author.id, task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } });
    const submitted = await event('submitted');
    advance();
    await verdict(ctx, reviewer.id, task.id, { pass: true, comment: 'Checked the pinned candidate', reviewedCommit: FIRST });
    expect((await event('verdict')).data).toMatchObject({ reviewedCommit: FIRST, candidateId: (submitted.data.candidate as { id: string }).id });
    expect((await event('submitted')).data.review).toEqual(submitted.data.review);
  });

  it('gives the immutable candidate to the reviewer through the task tool', async () => {
    const { ctx, task, author, tools } = await fixture();
    await submit(ctx, author.id, task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } });
    const response = await (await tools()).callTool({ name: 'task', arguments: { task: task.number } });
    expect(response.isError).toBeFalsy();
    const content = response.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)).toMatchObject({ review: { commit: FIRST, authorId: author.id } });
  });

  it('keeps one verdict under concurrent retries', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } });
    const attempt = () => verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Checked', reviewedCommit: FIRST });
    const settled = await Promise.allSettled([attempt(), attempt()]);
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'verdict')))).toHaveLength(1);
  });

  it('rechecks the reviewer vendor if its subscription changes after assignment', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } });
    await f.db.update(agents).set({ subscriptionId: f.author.subscriptionId }).where(eq(agents.id, f.reviewer.id));
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Good', reviewedCommit: FIRST })).rejects.toMatchObject({ status: 409, reason: 'task_changed' });
  });
});

describe('candidate source failures', () => {
  it.each(['refs', 'comparison', 'wrong-head'])('refuses unverified %s without a candidate or handoff', async problem => {
    const f = await fixture();
    if (problem === 'refs') f.ctx.readCommit = async () => { throw new Error('Repository unavailable'); };
    else f.ctx.readCompare = async () => problem === 'comparison' ? { complete: false, reason: 'compare-unavailable' } : { complete: true, baseSha: BASE, headSha: SECOND, paths: ['logic/totals.ts'], diff: '+new' };
    await expect(submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } }).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect(await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')))).toEqual([]);
  });
});

describe('explicit finding confirmation', () => {
  it('does not turn a reviewer verdict into a confirmed metric', async () => {
    const f = await rejectedFinding();
    expect((await f.read()).reviewFindings).toMatchObject({ uniqueConfirmed: 0, byVendor: [] });
  });

  it('lets the real head confirm existence before a fix without removing the block', async () => {
    const f = await rejectedFinding();
    expect((await f.confirm()).isError).toBeFalsy();
    expect((await f.read()).reviewFindings).toMatchObject({ uniqueConfirmed: 1, byVendor: [{ vendor: 'codex', count: 1, findingIds: [f.finding.findingId] }] });
    const [task] = await f.db.select().from(tasks).where(eq(tasks.id, f.task.id));
    expect(task).toMatchObject({ status: 'working', assigneeAgentId: f.reviewer.id });
    const history = await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id)).orderBy(taskEvents.id);
    expect(history.at(-1)!.data.findingConfirmation).toMatchObject({ findingId: f.finding.findingId, actorId: f.head.id, confirmed: true });
  });

  it('refuses the reviewer and an unrelated employee', async () => {
    const f = await rejectedFinding();
    const outsider = await f.hire('Other', 'worker', 'DEV-BE');
    expect((await f.confirm(f.reviewer)).isError).toBe(true);
    expect((await f.confirm(outsider)).isError).toBe(true);
    expect((await f.read()).reviewFindings.uniqueConfirmed).toBe(0);
  });

  it('requires the actual author to name a current fix and rejects stale revisions and SHAs', async () => {
    const f = await rejectedFinding();
    expect((await f.confirm(f.author)).isError).toBe(true);
    await f.fix();
    expect((await f.confirm(f.author, { fixCommit: FIRST })).isError).toBe(true);
    expect((await f.confirm(f.author, { fixCommit: SECOND, revision: '00000000-0000-4000-8000-000000000000' })).isError).toBe(true);
    expect((await f.confirm(f.author, { fixCommit: SECOND })).isError).toBeFalsy();
    expect((await f.read()).reviewFindings.uniqueConfirmed).toBe(1);
    expect((await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]!.assigneeAgentId).not.toBe(f.author.id);
  });

  it('keeps the immutable affected producer distinct from a later executor pointer', async () => {
    const f = await rejectedFinding();
    await f.fix();
    const other = await f.hire('Replacement', 'worker', 'DEV-BE');
    await f.db.update(tasks).set({ executorAgentId: other.id }).where(eq(tasks.id, f.task.id));
    expect((await f.confirm(f.author, { fixCommit: SECOND })).isError).toBeFalsy();
    expect((await f.confirm(other, { fixCommit: SECOND })).isError).toBe(true);
    expect((await f.read()).reviewFindings.uniqueConfirmed).toBe(1);
  });

  it('deduplicates concurrent confirmations and keeps revocation history without editing the source', async () => {
    const f = await rejectedFinding();
    const original = await f.event('verdict');
    const client = await f.tools(f.head);
    const args = { task: f.task.number, findingId: f.finding.findingId, revision: f.finding.revision, confirmed: true, reason: 'Verified' };
    const responses = await Promise.all([client.callTool({ name: 'confirm_finding', arguments: args }), client.callTool({ name: 'confirm_finding', arguments: args })]);
    expect(responses.every(r => !r.isError)).toBe(true);
    expect((await f.read()).reviewFindings.uniqueConfirmed).toBe(1);
    expect((await f.confirm(f.head, { confirmed: false, reason: 'The defect was disproved' })).isError).toBeFalsy();
    expect((await f.read()).reviewFindings.uniqueConfirmed).toBe(0);
    const history = (await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id))).filter(e => e.data.findingConfirmation);
    expect(history).toHaveLength(2);
    expect(await f.event('verdict')).toEqual(original);
  });

  it('delivers vendor provenance in the pipeline report without inventing a legacy baseline', async () => {
    const f = await rejectedFinding();
    const companyId = f.author.companyId;
    const [baseline] = await f.db.insert(turns).values({ companyId, departmentId: f.task.departmentId, number: 7, title: 'Baseline', goal: '', status: 'closed', openedAt: new Date(Date.now() - 10000), closedAt: new Date(Date.now() - 5000) }).returning();
    const [current] = await f.db.update(turns).set({ number: 8, title: 'Current' }).where(and(eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open'))).returning();
    const [old] = await f.db.insert(tasks).values({ companyId, number: 100, turnId: baseline!.id, departmentId: f.author.departmentId, title: 'Legacy review', brief: '', body: '', status: 'done', executorAgentId: f.head.id, closedAt: new Date() }).returning();
    await f.db.transaction(async tx => {
      await createRoute(tx, old!, {}, developmentStages());
      const route = await routeOf(tx, old!);
      await tx.update(taskRoutes).set({ state: { ...route.state, stage: null, phase: 'done', stages: [] } }).where(eq(taskRoutes.taskId, old!.id));
    });
    await f.db.insert(taskEvents).values({ companyId, taskId: old!.id, kind: 'verdict', agentId: f.reviewer.id, text: 'Legacy', data: { pass: true, findings: 7 } });
    await f.db.update(tasks).set({ turnId: current!.id }).where(eq(tasks.id, f.task.id));
    expect((await f.confirm()).isError).toBeFalsy();
    const [orchestrator] = await f.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const result = await (await f.tools(orchestrator!)).callTool({ name: 'pipeline_report', arguments: { turn: 8 } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(JSON.parse((result.content as { text: string }[])[0]!.text).reviewFindings).toMatchObject({
      current: { uniqueConfirmed: 1, byVendor: [{ vendor: 'codex', count: 1, findingIds: [f.finding.findingId] }] },
      baseline: { uniqueConfirmed: null, status: 'unavailable', reason: 'finding-provenance-unavailable' },
    });
  });
});
