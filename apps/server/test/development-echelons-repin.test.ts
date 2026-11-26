import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentFallbacks, agents, jobs, subscriptions, taskEvents, taskRoutes, tasks } from '../src/db/schema.js';
import { removeSubscription } from '../src/modules/subscriptions/routes.js';
import { report, submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { as } from './helpers.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const code = { summary: 'Change totals.', evidence: 'Named test.', review: { baseCommit: BASE } };
const pass = { pass: true, reviewedCommit: HEAD, comment: 'Reviewed.' };

/* The reviewer holds an active Review, pinned to the plan and model its card shows. */
async function atReview() {
  const f = await fixture();
  await submit(f.ctx, f.author.id, f.task.id, code);
  expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id });
  const route = async () => (await f.db.select().from(taskRoutes).where(eq(taskRoutes.taskId, f.task.id)))[0]!.state;
  const edit = (payload: object) => f.app.inject({ method: 'PATCH', url: `/api/agents/${f.reviewer.id}`, payload, ...as(f.ceoToken) });
  const headJobs = async () => (await f.db.select().from(jobs).where(and(eq(jobs.agentId, f.head.id), eq(jobs.taskId, f.task.id)))).length;
  return { ...f, route, edit, headJobs };
}

type ReviewFixture = Awaited<ReturnType<typeof atReview>>;

/* A fallback committed the employee's move before the stage could be re-pinned. */
async function savedFallback(f: ReviewFixture, model: string, agent = f.reviewer) {
  await f.db.transaction(async tx => {
    await tx.insert(agentFallbacks).values({
      agentId: agent.id, companyId: agent.companyId, homeSubscriptionId: agent.subscriptionId!,
      homeModel: agent.model, subscriptionId: f.codex.id,
    });
    await tx.update(agents).set({ subscriptionId: f.codex.id, model }).where(eq(agents.id, agent.id));
  });
}

const FALLBACK_MODEL = 'gpt-6.2-sol';
const FIX = 'c'.repeat(40);

describe('a checking stage whose automatic fallback left the old plan pinned', () => {
  it('accepts a verdict from the current reviewer and records the fallback identity on the active stage', async () => {
    const f = await atReview();
    await savedFallback(f, FALLBACK_MODEL);
    const assignment = { agentId: f.reviewer.id, subscriptionId: f.codex.id, provider: 'codex', model: FALLBACK_MODEL, capability: 2 };
    await verdict(f.ctx, f.reviewer.id, f.task.id, { ...pass, pass: false, comment: 'This edge needs a repair.' });
    expect(await f.route()).toMatchObject({ stage: 'review', phase: 'active', assignment });
    expect((await f.detail()).log.findLast(row => row.kind === 'verdict')?.data).toMatchObject({ checker: assignment });
  });

  it('accepts a repair from the same reviewer and records the model that produced it', async () => {
    const f = await atReview();
    await savedFallback(f, FALLBACK_MODEL);
    f.atCommit(FIX);
    await submit(f.ctx, f.reviewer.id, f.task.id, { ...code, summary: 'Repair the edge.' });
    const detail = await f.detail();
    expect(detail.echelons).toMatchObject({ stage: 'tests', phase: 'active' });
    expect(detail.log.findLast(row => row.kind === 'submitted')?.data).toMatchObject({
      candidate: { commit: FIX, producedBy: { agentId: f.reviewer.id, subscriptionId: f.codex.id, model: FALLBACK_MODEL, provider: 'codex' } },
    });
  });

  it('refuses a weaker fallback and tells the reviewer that the head must assign another checker', async () => {
    const f = await atReview();
    const before = await f.route();
    await savedFallback(f, 'gpt-6-luna');
    const weak = { status: 409, message: expect.stringMatching(/fell back to a weaker model.*head.*another checker/i) };
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, pass)).rejects.toMatchObject(weak);
    f.atCommit(FIX);
    await expect(submit(f.ctx, f.reviewer.id, f.task.id, code)).rejects.toMatchObject(weak);
    expect(await f.route()).toEqual(before);
  });

  it('lets the department head re-pin the active checker without reassigning the stage', async () => {
    const f = await atReview();
    const before = await f.route();
    await savedFallback(f, FALLBACK_MODEL);
    const change = { echelonStage: 'review', ownerAgentId: f.reviewer.id } as const;
    await expect(updateTask(f.ctx, f.tester.id, f.task.id, change)).rejects.toMatchObject({ status: 403 });
    await expect(updateTask(f.ctx, f.head.id, f.task.id, { ...change, ownerAgentId: f.tester.id })).rejects.toMatchObject({ status: 409 });
    expect(await f.route()).toEqual(before);
    const revised = await updateTask(f.ctx, f.head.id, f.task.id, change);
    expect(revised.task).toMatchObject({ assigneeAgentId: f.reviewer.id, status: 'review' });
    expect(revised.wakes).toEqual([]);
    expect(await f.route()).toMatchObject({
      stage: 'review', phase: 'active', candidateId: before.candidateId,
      stages: before.stages, assignment: { agentId: f.reviewer.id, subscriptionId: f.codex.id, model: FALLBACK_MODEL },
    });
  });

  it('refuses an old holder and a different agent that has a valid fallback of its own', async () => {
    const f = await atReview();
    const replacement = await f.hire('Replacement', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    await updateTask(f.ctx, f.head.id, f.task.id, { ownerAgentId: replacement.id });
    await savedFallback(f, FALLBACK_MODEL);
    await savedFallback(f, FALLBACK_MODEL, f.tester);
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, pass)).rejects.toMatchObject({ status: 403 });
    await expect(submit(f.ctx, f.reviewer.id, f.task.id, code)).rejects.toMatchObject({ status: 403 });
    await expect(verdict(f.ctx, f.tester.id, f.task.id, pass)).rejects.toMatchObject({ status: 403 });
    expect((await f.route()).assignment?.agentId).toBe(replacement.id);
  });

  it('refuses the producer a checking stage even after the producer falls back', async () => {
    const f = await atReview();
    const author = await f.hire('Independent candidate author', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    const { task } = await f.create({ assigneeAgentId: author.id, reviewerAgentId: f.reviewer.id });
    await submit(f.ctx, author.id, task.id, code);
    await savedFallback(f, FALLBACK_MODEL, author);
    await expect(updateTask(f.ctx, f.head.id, task.id, { ownerAgentId: author.id })).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('cannot review it'),
    });
  });

  it('does not use a fallback to let a completed checker verify a later stage', async () => {
    const f = await atReview();
    await verdict(f.ctx, f.reviewer.id, f.task.id, pass);
    await f.db.update(agents).set({ skills: f.tester.skills }).where(eq(agents.id, f.reviewer.id));
    await updateTask(f.ctx, f.head.id, f.task.id, { ownerAgentId: f.reviewer.id });
    const detail = (await f.detail()).echelons;
    await savedFallback(f, FALLBACK_MODEL);
    await expect(report(f.ctx, f.reviewer.id, f.task.id, {
      done: true, summary: 'Tested.', verification: { candidateId: detail.candidateId!, revision: detail.revision },
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already checked') });
  });

  it('updates the assignment when Tests submits a repair and keeps the stage', async () => {
    const f = await atReview();
    await updateTask(f.ctx, f.head.id, f.task.id, { paths: ['logic/**'] });
    await verdict(f.ctx, f.reviewer.id, f.task.id, pass);
    await savedFallback(f, FALLBACK_MODEL, f.tester);
    f.atCommit(FIX, ['logic/totals.test.ts']);
    await submit(f.ctx, f.tester.id, f.task.id, { ...code, summary: 'Repair the totals test.' });
    expect(await f.route()).toMatchObject({
      stage: 'tests', phase: 'active',
      assignment: { agentId: f.tester.id, subscriptionId: f.codex.id, model: FALLBACK_MODEL },
    });
  });
});

describe('a checking stage follows its owner when the owner card changes', () => {
  it('accepts the Review result after the reviewer moves to another model of the same strength', async () => {
    const f = await atReview();
    expect((await f.edit({ model: 'claude-fable-5-1' })).statusCode).toBe(200);
    await verdict(f.ctx, f.reviewer.id, f.task.id, pass);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', phase: 'active' });
  });

  it('accepts the Review result after the reviewer moves to another plan of the same program', async () => {
    const f = await atReview();
    const [second] = await f.db.insert(subscriptions).values({ companyId: f.task.companyId, provider: 'claude', kind: 'personal', label: 'Second', ownerPersonId: f.codex.ownerPersonId, status: 'ready' }).returning();
    expect((await f.edit({ subscription: second!.id })).statusCode).toBe(200);
    await verdict(f.ctx, f.reviewer.id, f.task.id, pass);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', phase: 'active' });
  });

  it('leaves a stage whose owner no longer qualifies waiting, and tells the head why', async () => {
    const f = await atReview();
    const before = await f.headJobs();
    expect((await f.edit({ model: 'claude-haiku-5-5' })).statusCode).toBe(200);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null });
    expect((await f.detail()).echelons.stages.find(step => step.stage === 'review')).toMatchObject({ status: 'pending', ownerAgentId: null, reason: 'eligible_owner_required' });
    expect((await f.route()).assignment).toBeNull();
    expect((await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]).toMatchObject({ assigneeAgentId: null, status: 'waiting' });
    const notes = (await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'updated')))).map(event => event.text);
    expect(notes.some(text => text?.includes('weaker') && text.includes('Reviewer'))).toBe(true);
    expect(await f.headJobs()).toBeGreaterThan(before);
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, pass)).rejects.toThrow();
  });

  it('lets the stage go with its reason when the plan the reviewer moved to leaves the company', async () => {
    const f = await atReview();
    const [second] = await f.db.insert(subscriptions).values({ companyId: f.task.companyId, provider: 'claude', kind: 'personal', label: 'Second', ownerPersonId: f.codex.ownerPersonId, status: 'ready' }).returning();
    expect((await f.edit({ subscription: second!.id })).statusCode).toBe(200);
    const before = await f.headJobs();
    await removeSubscription(f.ctx, second!);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null });
    const notes = (await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'updated')))).map(event => event.text);
    expect(notes.some(text => text?.includes('Reviewer') && text.includes('no plan'))).toBe(true);
    expect(await f.headJobs()).toBeGreaterThan(before);
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, pass)).rejects.toThrow();
  });

  it('changes nothing for a stage the employee does not hold', async () => {
    const f = await atReview();
    const route = await f.route();
    expect((await f.app.inject({ method: 'PATCH', url: `/api/agents/${f.tester.id}`, payload: { model: 'claude-fable-5-1' }, ...as(f.ceoToken) })).statusCode).toBe(200);
    expect(await f.route()).toEqual(route);
  });
});
