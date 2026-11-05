import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { agents, companies, departments, machines, nodes, people, subscriptions } from '../src/db/schema.js';
import { as, sessionFrom, SETUP, testApp } from './helpers.js';

/* A company with a plan whose machine is connected, and an operator that has not been on it. */
async function company() {
  const { app, db } = await testApp();
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'later' } } });
  expect(res.statusCode).toBe(201);
  const ceo = sessionFrom(res);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people);
  const [ops] = await db.select().from(departments).where(eq(departments.templateKey, 'operations'));
  const plan = async (label: string) => {
    const [row] = await db.insert(subscriptions).values({ companyId: acme!.id, provider: 'claude', kind: 'personal', label, ownerPersonId: owner!.id, status: 'ready' }).returning({ id: subscriptions.id });
    const [machine] = await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: randomUUID(), hostname: label }).returning();
    const [node] = await db.insert(nodes).values({ companyId: acme!.id, machineId: machine!.id, subscriptionId: row!.id, keyHash: randomUUID(), status: 'ready', version: '0.7.0' }).returning();
    return { id: row!.id, nodeId: node!.id };
  };
  vi.spyOn(app.ctx.hub, 'isReady').mockReturnValue(true);
  const operators = () => db.select().from(agents).where(and(eq(agents.roleKey, 'OPS-PROGRAM'), isNull(agents.removedAt)));
  return { app, db, ceo, ops: ops!, plan, operators };
}

it('a person who moves the operator to another plan puts it on a machine of that plan at once', async () => {
  const c = await company();
  const first = await c.plan('First');
  const second = await c.plan('Second');
  const [operator] = await c.operators();
  await c.db.update(agents).set({ subscriptionId: first.id, nodeId: first.nodeId }).where(eq(agents.id, operator!.id));
  const moved = await c.app.inject({ method: 'PATCH', url: `/api/agents/${operator!.id}`, payload: { subscription: second.id }, ...as(c.ceo) });
  expect(moved.statusCode).toBe(200);
  expect((await c.operators())[0]).toMatchObject({ subscriptionId: second.id, nodeId: second.nodeId });
});

it('a person who hires another operator on a plan with a machine finds it on that machine at once', async () => {
  const c = await company();
  const plan = await c.plan('Plan');
  const skills = c.app.ctx.templates.roles.get('OPS-PROGRAM')!.skills.filter(skill => skill.locked).map(skill => skill.id);
  const hired = await c.app.inject({ method: 'POST', url: `/api/departments/${c.ops.id}/staff`, payload: { people: [{ role: 'OPS-PROGRAM', name: 'Second operator', model: '', subscription: plan.id, skills }] }, ...as(c.ceo) });
  expect(hired.statusCode).toBe(201);
  const second = (await c.operators()).find(row => row.name === 'Second operator');
  expect(second).toMatchObject({ subscriptionId: plan.id, nodeId: plan.nodeId });
});

it('leaves everyone else to their first turn', async () => {
  const c = await company();
  const plan = await c.plan('Plan');
  const [watcher] = await c.db.select().from(agents).where(eq(agents.roleKey, 'OPS-WATCH'));
  const moved = await c.app.inject({ method: 'PATCH', url: `/api/agents/${watcher!.id}`, payload: { subscription: plan.id }, ...as(c.ceo) });
  expect(moved.statusCode).toBe(200);
  expect((await c.db.select().from(agents).where(eq(agents.id, watcher!.id)))[0]).toMatchObject({ subscriptionId: plan.id, nodeId: null });
});
