import { and, asc, eq, isNull } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { agentChanges, agents, jobs, people, subscriptions, tasks, teams } from '../src/db/schema.js';
import { ensureOperations, placeOperator } from '../src/modules/operations/ensure.js';
import { as, invitePerson, withoutOperations } from './helpers.js';
import { createRoute } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { company, operator, addKey, addPlan } from './operations-plan-fixture.js';

describe("the program operator's plan", () => {
  it('waits without one, and gets the first key that comes with no one asked', async () => {
    const c = await company();
    expect((await operator(c.db)).subscriptionId).toBeNull();
    const key = await addKey(c);
    expect((await operator(c.db)).subscriptionId).toBe(key);
    const [change] = await c.db.select().from(agentChanges).where(and(eq(agentChanges.agentId, (await operator(c.db)).id), eq(agentChanges.field, 'subscription')));
    expect(change).toMatchObject({ personId: null, byOrchestrator: false, before: null, after: key });
  });

  it('is not the only one who gets it: the others of Operations that wait take it too, as any employee does', async () => {
    const c = await company();
    const key = await addKey(c);
    const others = await c.db.select().from(agents).where(and(eq(agents.departmentId, c.ops.id), isNull(agents.removedAt)));
    expect(others.filter(a => a.roleKey !== 'OPS-PROGRAM').map(a => a.subscriptionId)).toEqual([key, key, key]);
  });

  it('gets a plan that still waits for its machine', async () => {
    const c = await company();
    const res = await c.app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(c.ceo) });
    expect(res.statusCode).toBe(201);
    const [plan] = await c.db.select().from(subscriptions);
    expect(plan!.status).toBe('waiting_machine');
    expect((await operator(c.db)).subscriptionId).toBe(plan!.id);
  });

  it.each(['needs_login', 'needs_setup', 'ready', 'waiting_machine'] as const)('takes a plan that is %s at the next check', async status => {
    const c = await company();
    const plan = await addPlan(c, { status });
    await ensureOperations(c.app.ctx, c.companyId);
    expect((await operator(c.db)).subscriptionId).toBe(plan);
  });

  it('takes the oldest that may serve, and the lower id when they came at once', async () => {
    const c = await company();
    const at = new Date('2026-03-01T00:00:00Z');
    const a = await addPlan(c, { createdAt: at });
    const b = await addPlan(c, { createdAt: at });
    await addPlan(c, { createdAt: new Date('2026-02-01T00:00:00Z'), removedAt: new Date('2026-02-02T00:00:00Z') });
    await addPlan(c, { createdAt: new Date('2026-04-01T00:00:00Z') });
    await ensureOperations(c.app.ctx, c.companyId);
    expect((await operator(c.db)).subscriptionId).toBe([a, b].sort()[0]);
  });

  it('does not take a key for another department or for a sub-unit of it', async () => {
    const c = await company();
    await addKey(c, { kind: 'department', id: c.dev.id });
    const [team] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Tigers' }).returning();
    await addKey(c, { kind: 'team', id: team!.id });
    expect((await operator(c.db)).subscriptionId).toBeNull();
  });

  it('takes a key for Operations, and one for a sub-unit of it', async () => {
    const c = await company();
    const key = await addKey(c, { kind: 'department', id: c.ops.id });
    expect((await operator(c.db)).subscriptionId).toBe(key);

    const d = await company();
    const [team] = await d.db.insert(teams).values({ companyId: d.companyId, departmentId: d.ops.id, name: 'Night shift' }).returning();
    const teamKey = await addKey(d, { kind: 'team', id: team!.id });
    expect((await operator(d.db)).subscriptionId).toBe(teamKey);
  });

  it('does not take the plan of someone who does not reach Operations, and takes one of someone who does', async () => {
    const c = await company();
    const inDev = await invitePerson(c.app, c.ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [c.dev.id] } });
    expect((await c.app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex'] }, ...as(inDev) })).statusCode).toBe(201);
    expect((await operator(c.db)).subscriptionId).toBeNull();
    const inOps = await invitePerson(c.app, c.ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [c.ops.id] } });
    expect((await c.app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex'] }, ...as(inOps) })).statusCode).toBe(201);
    const [maria] = await c.db.select().from(people).where(eq(people.email, 'maria@acme.com'));
    const [plan] = await c.db.select().from(subscriptions).where(eq(subscriptions.ownerPersonId, maria!.id));
    expect((await operator(c.db)).subscriptionId).toBe(plan!.id);
  });

  it("does not take the plan of an owner who is switched off", async () => {
    const c = await company();
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, c.ownerId));
    await addPlan(c);
    await ensureOperations(c.app.ctx, c.companyId);
    expect((await operator(c.db)).subscriptionId).toBeNull();
  });

  it('keeps a plan a person picked while it may serve, when an older one or a new one is there', async () => {
    const c = await company();
    const first = await addKey(c);
    const second = await addKey(c);
    const me = await operator(c.db);
    expect(me.subscriptionId).toBe(first);
    const picked = await c.app.inject({ method: 'PATCH', url: `/api/agents/${me.id}`, payload: { subscription: second, model: 'claude-sonnet-5-5' }, ...as(c.ceo) });
    expect(picked.statusCode).toBe(200);
    await addKey(c);
    await ensureOperations(c.app.ctx, c.companyId);
    expect(await operator(c.db)).toMatchObject({ subscriptionId: second, model: 'claude-sonnet-5-5' });
  });

  it('tells the map only when the operator changes plan', async () => {
    const c = await company();
    const told = vi.spyOn(c.app.ctx.bus, 'publish');
    const orgs = () => told.mock.calls.filter(([, event]) => event.type === 'org').length;
    await placeOperator(c.app.ctx, c.companyId);
    expect(orgs()).toBe(0);
    const key = await addPlan(c);
    await placeOperator(c.app.ctx, c.companyId);
    expect((await operator(c.db)).subscriptionId).toBe(key);
    expect(orgs()).toBe(1);
    await placeOperator(c.app.ctx, c.companyId);
    expect(orgs()).toBe(1);
  });

  it('tells no map with no operator on, or with no Operations', async () => {
    const c = await company();
    const told = vi.spyOn(c.app.ctx.bus, 'publish');
    await addPlan(c);
    await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, (await operator(c.db)).id));
    await placeOperator(c.app.ctx, c.companyId);
    await withoutOperations(c.db);
    await placeOperator(c.app.ctx, c.companyId);
    expect(told).not.toHaveBeenCalled();
  });

  it('leaves an operator who is switched off without a plan', async () => {
    const c = await company();
    await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, (await operator(c.db)).id));
    await addKey(c);
    expect((await operator(c.db)).subscriptionId).toBeNull();
  });

  it('moves off a plan that may serve no more, onto the next, on the Default model', async () => {
    const c = await company();
    const first = await addKey(c);
    const second = await addKey(c);
    await c.db.update(agents).set({ model: 'claude-sonnet-5-5', effort: 'high' }).where(eq(agents.id, (await operator(c.db)).id));
    await c.db.update(subscriptions).set({ targetKind: 'department', targetId: c.dev.id }).where(eq(subscriptions.id, first));
    await ensureOperations(c.app.ctx, c.companyId);
    expect(await operator(c.db)).toMatchObject({ subscriptionId: second, model: '', effort: null });
    const changes = await c.db.select().from(agentChanges).where(and(eq(agentChanges.field, 'subscription'), eq(agentChanges.agentId, (await operator(c.db)).id))).orderBy(asc(agentChanges.createdAt));
    expect(changes.at(-1)).toMatchObject({ personId: null, byOrchestrator: false, before: first, after: second });
  });

  it("moves off the plan of an owner who was switched off, and waits when no other may serve", async () => {
    const c = await company();
    const plan = await addPlan(c);
    await ensureOperations(c.app.ctx, c.companyId);
    expect((await operator(c.db)).subscriptionId).toBe(plan);
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, c.ownerId));
    await ensureOperations(c.app.ctx, c.companyId);
    expect((await operator(c.db)).subscriptionId).toBeNull();
  });

  it('does not stop a turn that runs on a plan that may serve no more, and moves it once the turn ended', async () => {
    const c = await company();
    const first = await addKey(c);
    const second = await addKey(c);
    const me = await operator(c.db);
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: first, agentId: me.id, kind: 'conversation', prompt: 'look', timeoutMs: 900000, status: 'running' }).returning();
    await c.db.update(subscriptions).set({ targetKind: 'department', targetId: c.dev.id }).where(eq(subscriptions.id, first));
    await ensureOperations(c.app.ctx, c.companyId);
    expect((await operator(c.db)).subscriptionId).toBe(first);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]!.status).toBe('running');
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, job!.id));
    await ensureOperations(c.app.ctx, c.companyId);
    expect((await operator(c.db)).subscriptionId).toBe(second);
  });

  it('goes to the next plan when its own is removed', async () => {
    const c = await company();
    const first = await addKey(c);
    const second = await addKey(c);
    expect((await c.app.inject({ method: 'DELETE', url: `/api/subscriptions/${first}`, ...as(c.ceo) })).statusCode).toBe(204);
    expect((await operator(c.db)).subscriptionId).toBe(second);
  });

  it('starts the work that waited for a plan as soon as it has one', async () => {
    const c = await company();
    const me = await operator(c.db);
    const [task] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 900, title: 'Look at a screen', brief: '', body: '', departmentId: c.ops.id, assigneeAgentId: me.id, status: 'open' }).returning();
    await c.db.transaction(tx => createRoute(tx, task!, {}, developmentStages()));
    expect(await c.db.select().from(jobs).where(eq(jobs.agentId, me.id))).toEqual([]);
    const key = await addKey(c);
    const turns = await c.db.select().from(jobs).where(eq(jobs.agentId, me.id));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.subscriptionId).toBe(key);
  });

});
