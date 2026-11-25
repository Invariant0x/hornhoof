import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, subscriptions, taskEvents, taskRoutes, tasks } from '../src/db/schema.js';
import { removeSubscription } from '../src/modules/subscriptions/routes.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
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
