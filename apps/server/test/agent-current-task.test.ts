import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, jobs, tasks } from '../src/db/schema.js';
import { createCoordinationRoute } from '../src/modules/tasks/echelons-store.js';
import { submit } from '../src/modules/tasks/engine.js';
import { BASE, fixture } from './development-echelons-fixture.js';
import { as, invitePerson, ownPlan, setUpCompany, testApp } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const companyId = orchestrator!.companyId;
  const [department] = await db.insert(departments).values({ companyId, name: 'Development', templateKey: 'development', roleCode: 'DEV' }).returning();
  const [product] = await db.insert(departments).values({ companyId, parentId: department!.id, name: 'Checkout', roleCode: 'CHECKOUT' }).returning();
  const [employee] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: department!.id, productId: product!.id, subscriptionId: orchestrator!.subscriptionId, model: '' }).returning();
  const insertTask = (value: typeof tasks.$inferInsert) => db.transaction(async tx => {
    const rows = await tx.insert(tasks).values(value).returning();
    await createCoordinationRoute(tx, rows[0]!);
    return rows;
  });
  return { app, db, ceo, insertTask, companyId, orchestrator: orchestrator!, department: department!, product: product!, employee: employee! };
}

describe('the task in an agent window', () => {
  it('uses the running orchestrator turn rather than a newer assigned task', async () => {
    const { app, db, ceo, insertTask, companyId, orchestrator } = await company();
    const [current] = await insertTask({ companyId, number: 12, title: 'Current work', status: 'working', assigneeAgentId: orchestrator.id });
    await insertTask({ companyId, number: 99, title: 'Later work', assigneeAgentId: orchestrator.id, after: [current!.id] });
    await db.insert(jobs).values({ companyId, subscriptionId: orchestrator.subscriptionId!, agentId: orchestrator.id, taskId: current!.id, prompt: 'work', status: 'running', timeoutMs: 1000 });
    const response = await app.inject({ url: '/api/agents/orchestrator', ...as(ceo) });
    expect(response.statusCode).toBe(200);
    expect(response.json().currentTask).toEqual({ id: current!.id, number: 12, title: 'Current work' });
  });

  it('shows a product employee task to someone with access only to the product', async () => {
    const { app, db, ceo, insertTask, companyId, department, product, employee } = await company();
    const viewer = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [product.id] } });
    await ownPlan(db, 'maria@acme.com', employee.id);
    const [current] = await insertTask({ companyId, departmentId: department.id, productId: product.id, number: 12, title: 'Product work', status: 'working', assigneeAgentId: employee.id });
    await db.insert(jobs).values({ companyId, subscriptionId: employee.subscriptionId!, agentId: employee.id, taskId: current!.id, prompt: 'work', status: 'running', timeoutMs: 1000 });
    const response = await app.inject({ url: `/api/agents/${employee.id}`, ...as(viewer) });
    expect(response.statusCode).toBe(200);
    expect(response.json().currentTask).toEqual({ id: current!.id, number: 12, title: 'Product work' });
    expect((await app.inject({ url: `/api/tasks/${current!.id}`, ...as(viewer) })).statusCode).toBe(200);
  });

  it("shows a task outside the viewer's access too, as everyone sees the company's tasks", async () => {
    const { app, db, ceo, insertTask, companyId, department, product, employee } = await company();
    const viewer = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [product.id] } });
    await ownPlan(db, 'maria@acme.com', employee.id);
    const [current] = await insertTask({ companyId, departmentId: department.id, number: 12, title: 'Department private work', status: 'working', assigneeAgentId: employee.id });
    await db.insert(jobs).values({ companyId, subscriptionId: employee.subscriptionId!, agentId: employee.id, taskId: current!.id, prompt: 'work', status: 'running', timeoutMs: 1000 });
    const response = await app.inject({ url: `/api/agents/${employee.id}`, ...as(viewer) });
    expect(response.statusCode).toBe(200);
    expect(response.json().currentTask).toEqual({ id: current!.id, number: 12, title: 'Department private work' });
    expect((await app.inject({ url: `/api/tasks/${current!.id}`, ...as(viewer) })).statusCode).toBe(200);
  });

  it('retains a held task while waiting without a running program and excludes unfinished prerequisites', async () => {
    const { app, db, ceo, insertTask, companyId, department, product, employee } = await company();
    const [current] = await insertTask({ companyId, departmentId: department.id, productId: product.id, number: 12, title: 'Waiting work', status: 'blocked', assigneeAgentId: employee.id });
    await insertTask({ companyId, number: 99, title: 'Later work', assigneeAgentId: employee.id, after: [current!.id] });
    expect((await app.inject({ url: `/api/agents/${employee.id}`, ...as(ceo) })).json().currentTask).toEqual({ id: current!.id, number: 12, title: 'Waiting work' });
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.departments.find((d: { id: string }) => d.id === department.id).employees.find((a: { id: string }) => a.id === employee.id).status).toBe('waiting');
    await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, current!.id));
    await db.update(tasks).set({ status: 'cancelled', closedAt: new Date() }).where(eq(tasks.number, 99));
    expect((await app.inject({ url: `/api/agents/${employee.id}`, ...as(ceo) })).json().currentTask).toBeNull();
  });

  it('shows the current Review owner after the author hands over the candidate', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checked', review: { baseCommit: BASE } });
    const response = await f.app.inject({ url: `/api/agents/${f.reviewer.id}`, ...as(f.ceoToken) });
    expect(response.statusCode).toBe(200);
    expect(response.json().currentTask).toEqual({ id: f.task.id, number: f.task.number, title: f.task.title });
    expect((await f.detail()).echelons.ownerAgentId).toBe(f.reviewer.id);
  });

  it.each(['open', 'blocked'] as const)('keeps the leading held task during a conversation without a task reference (%s)', async status => {
    const { app, db, ceo, insertTask, companyId, employee } = await company();
    await insertTask({ companyId, number: 12, title: 'Older work', status, assigneeAgentId: employee.id });
    const [current] = await insertTask({ companyId, number: 99, title: 'Leading work', status, assigneeAgentId: employee.id });
    await db.insert(jobs).values({ companyId, subscriptionId: employee.subscriptionId!, agentId: employee.id, prompt: 'conversation', status: 'running', timeoutMs: 1000 });
    expect((await app.inject({ url: `/api/agents/${employee.id}`, ...as(ceo) })).json().currentTask).toEqual({ id: current!.id, number: 99, title: 'Leading work' });
  });
});
