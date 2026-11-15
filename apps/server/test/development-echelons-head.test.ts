import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, jobs, turns } from '../src/db/schema.js';
import { blocked, handOver, loadTask, submit, updateTask } from '../src/modules/tasks/engine.js';
import { BASE, fixture } from './development-echelons-fixture.js';

const code = { summary: 'Keep totals.', evidence: 'Changed source and tests.', review: { baseCommit: BASE } };

describe('head decisions on the current route', () => {
  it('hands unsubmitted work to its replacement and ends only the former executor queued turn', async () => {
    const f = await fixture();
    const next = await f.hire('Next author', 'worker', 'DEV-BE', f.codex.id, 'gpt-6.1-sol');
    const [queued] = await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: f.author.id, subscriptionId: f.author.subscriptionId!, taskId: f.task.id, kind: 'conversation', prompt: 'Old assignment', timeoutMs: 1000, status: 'queued' }).returning();
    const [unrelated] = await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: f.author.id, subscriptionId: f.author.subscriptionId!, kind: 'conversation', prompt: 'Another conversation', timeoutMs: 1000, status: 'queued' }).returning();
    const moved = await handOver(f.ctx, await loadTask(f.db, f.task.id), next.id, 'The original plan is at its limit.');
    expect(moved.task).toMatchObject({ assigneeAgentId: next.id, executorAgentId: next.id, status: 'open' });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'development', candidateId: null, ownerAgentId: next.id });
    expect(moved.wakes).toEqual([expect.objectContaining({ agentId: next.id, taskId: f.task.id, why: 'assigned' })]);
    expect((await f.db.select().from(jobs).where(eq(jobs.id, queued!.id)))[0]).toMatchObject({ status: 'failed', error: 'handed_on' });
    expect((await f.db.select().from(jobs).where(eq(jobs.id, unrelated!.id)))[0]).toMatchObject({ status: 'queued', error: null });
  });

  it('refuses automatic executor changes after a candidate has been submitted', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    const before = (await f.detail()).echelons;
    await expect(handOver(f.ctx, await loadTask(f.db, f.task.id), f.author.id, 'Change executor')).rejects.toMatchObject({ status: 409, reason: 'task_invalid' });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', candidateId: before.candidateId, ownerAgentId: f.reviewer.id });
  });

  it.each(['development', 'review'] as const)('reopens blocked %s after a head rewrite without replacing its stage owner or candidate', async stage => {
    const f = await fixture();
    if (stage === 'review') await submit(f.ctx, f.author.id, f.task.id, code);
    const owner = stage === 'review' ? f.reviewer : f.author;
    const before = (await f.detail()).echelons;
    await blocked(f.ctx, owner.id, f.task.id, 'Need the task clarified.');
    const moved = await updateTask(f.ctx, f.head.id, f.task.id, { body: 'Keep the total and its boundary cases correct.' });
    expect(moved.task).toMatchObject({ status: stage === 'review' ? 'review' : 'open', assigneeAgentId: owner.id, silent: 0 });
    expect((await f.detail()).echelons).toMatchObject({ stage, phase: 'active', candidateId: before.candidateId, ownerAgentId: owner.id });
    expect(moved.wakes).toEqual([expect.objectContaining({ agentId: owner.id, why: 'updated' })]);
  });

  it('reassigns waiting Review without changing its candidate or returning it to Development', async () => {
    const f = await fixture();
    await f.db.update(agents).set({ model: 'claude-haiku-5-5' }).where(eq(agents.id, f.reviewer.id));
    await submit(f.ctx, f.author.id, f.task.id, code);
    const before = (await f.detail()).echelons;
    const other = await f.hire('Another reviewer', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    const moved = await updateTask(f.ctx, f.head.id, f.task.id, { ...{ ownerAgentId: other.id } });
    expect(moved.task.assigneeAgentId).toBe(other.id);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'active', candidateId: before.candidateId, ownerAgentId: other.id });
    expect(moved.wakes.map(w => w.agentId)).toEqual([other.id]);
  });
  it('refuses a worker changing its own route assignment', async () => {
    const f = await fixture();
    await expect(updateTask(f.ctx, f.author.id, f.task.id, { ...{ ownerAgentId: f.reviewer.id } }).then(() => null)).rejects.toMatchObject({ status: 403 });
  });
  it("applies explicit Cleanup to the department's work until its next release, and to new tasks until then", async () => {
    const f = await fixture({ turn: null });
    const [turn] = await f.db.insert(turns).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, number: 1, title: 'Totals', goal: 'Correct totals', status: 'open', openedAt: new Date(), createdByAgentId: f.head.id }).returning();
    const first = (await f.create({ title: 'Turn first' })).task;
    const second = (await f.create({ title: 'Turn second' })).task;
    expect(first.turnId).toBeNull();
    await updateTask(f.ctx, f.head.id, first.id, { ...{ cleanup: true, cleanupForTurn: true } });
    const third = (await f.create({ title: 'Turn third' })).task;
    /* The work going on in the department is the open turn's, whenever it was given out. */
    for (const task of [f.task, first, second, third]) expect((await f.detail(task.id)).echelons.stages.map(step => step.stage)).toEqual(['architecture', 'development', 'review', 'cleanup', 'security', 'tests']);
    /* Its release ends the decision: work given out for the next one goes as the department's route says. */
    await f.db.update(turns).set({ status: 'closed', closedAt: new Date(), version: 'v1.0.0' }).where(eq(turns.id, turn!.id));
    await f.db.insert(turns).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, number: 2, goal: 'The next release.', status: 'open', openedAt: new Date() });
    const fourth = (await f.create({ title: 'Next release' })).task;
    expect((await f.detail(fourth.id)).echelons.stages.some(step => step.stage === 'cleanup')).toBe(false);
  });
});
