import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, requests, subscriptions, tasks } from '../src/db/schema.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { as, invitePerson, listen, openStream, setUpCompany, testApp, until } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    ])
    .returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const oleg = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id] } });
  const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
  const post = (token: string, path: string, payload: object) => app.inject({ method: 'POST', url: path, payload, ...as(token) });
  const get = (token: string, path: string) => app.inject({ url: path, ...as(token) });
  return { app, db, url, ctx: app.ctx, companyId, ceo, oleg, maria, orchestrator: orchestrator!, dev: dev!, sales: sales!, head, bruno, post, get };
}

describe('tasks for people', () => {
  it("shows a person only their departments' tasks and what waits for them", async () => {
    const { ctx, head, bruno, dev, ceo, oleg, maria, get } = await company();
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: 'The API.', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true });
    await ask(ctx, bruno.id, task.id, { kind: 'question', text: 'Which currency?' });
    expect((await get(oleg, '/api/tasks')).json().tasks.map((t: { number: number }) => t.number)).toEqual([1]);
    expect((await get(maria, '/api/tasks')).json().tasks).toEqual([]);
    expect((await get(maria, `/api/tasks/${task.id}`)).statusCode).toBe(404);
    expect((await get(oleg, `/api/tasks/${task.id}`)).json().task).toMatchObject({ number: 1, title: 'Checkout API', executor: { name: 'Bruno' } });
    expect((await get(oleg, '/api/requests')).json().requests).toMatchObject([{ kind: 'question', text: 'Which currency?', task: { number: 1, title: 'Checkout API' } }]);
    expect((await get(maria, '/api/requests')).json().requests).toEqual([]);
    expect((await get(ceo, '/api/requests')).json().requests).toHaveLength(1);
  });

  it("gives a person's task to the department's head, or the orchestrator's to the whole company only", async () => {
    const { db, dev, sales, head, orchestrator, ceo, oleg, post } = await company();
    const made = await post(oleg, '/api/tasks', { title: 'Payments', brief: 'Take card payments.', body: 'Stripe.', department: dev.id });
    expect(made.statusCode).toBe(201);
    expect(made.json().task).toMatchObject({ number: 1, assignee: { name: 'Hana' } });
    expect((await post(oleg, '/api/tasks', { title: 'Leads', brief: '', body: '', department: sales.id })).statusCode).toBe(404);
    expect((await post(ceo, '/api/tasks', { title: 'Leads', brief: '', body: '', department: sales.id })).json().error.reason).toBe('no_head');
    expect((await post(oleg, '/api/tasks', { title: 'Plan', brief: '', body: '' })).json().error.reason).toBe('company_scope_only');
    expect((await post(ceo, '/api/tasks', { title: 'Plan', brief: '', body: '' })).json().task.assignee.name).toBe('Orchestrator');
    expect((await db.select({ a: tasks.assigneeAgentId }).from(tasks)).map(r => r.a)).toEqual([head.id, orchestrator.id]);
  });

  it('comments, cancels and answers for the people of the department', async () => {
    const { ctx, db, head, bruno, dev, oleg, maria, post, get } = await company();
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true });
    expect((await post(oleg, `/api/tasks/${task.id}/comments`, { text: 'EUR only.' })).statusCode).toBe(201);
    expect((await post(maria, `/api/tasks/${task.id}/comments`, { text: 'Hi.' })).statusCode).toBe(404);
    const { request } = await ask(ctx, bruno.id, task.id, { kind: 'question', text: 'Which currency?' });
    expect((await post(oleg, `/api/requests/${request.id}`, { approve: true })).json().error.reason).toBe('task_invalid');
    expect((await post(maria, `/api/requests/${request.id}`, { answer: 'EUR' })).statusCode).toBe(404);
    expect((await post(oleg, `/api/requests/${request.id}`, { answer: 'EUR' })).statusCode).toBe(200);
    expect((await get(oleg, `/api/tasks/${task.id}`)).json().task).toMatchObject({ status: 'working', log: expect.arrayContaining([expect.objectContaining({ kind: 'answered', text: 'EUR' })]) });
    expect((await post(oleg, `/api/tasks/${task.id}/cancel`, { why: 'Not now.' })).json().task.status).toBe('cancelled');
    expect((await db.select().from(requests))[0]!.status).toBe('answered');
  });

  it('runs one turn at a time and leaves its open tasks without a turn when it closes', async () => {
    const { db, ceo, oleg, orchestrator, post, get } = await company();
    expect((await post(oleg, '/api/turns', { goal: 'Payments' })).json().error.reason).toBe('company_scope_only');
    const started = await post(ceo, '/api/turns', { goal: 'Payments' });
    expect(started.statusCode).toBe(201);
    expect(started.json().turn).toMatchObject({ number: 1, goal: 'Payments', status: 'open' });
    expect((await post(ceo, '/api/turns', { goal: 'More' })).json().error.reason).toBe('turn_open');
    const [turnTask] = await db.select().from(tasks);
    expect(turnTask).toMatchObject({ title: 'Turn 1: Payments', assigneeAgentId: orchestrator.id, turnId: started.json().turn.id });
    expect((await get(ceo, '/api/turns/current')).json().turn).toMatchObject({ number: 1, tasks: { total: 1, done: 0 } });
    expect((await post(ceo, `/api/turns/${started.json().turn.id}/close`, {})).json().turn.status).toBe('closed');
    expect((await db.select().from(tasks))[0]).toMatchObject({ turnId: null, status: 'open' });
    expect((await get(ceo, '/api/turns/current')).json().turn).toBe(null);
    expect((await post(ceo, '/api/turns', { goal: 'More' })).json().turn.number).toBe(2);
  });

  it('keeps a repository token secret and refuses plain http', async () => {
    const { dev, ceo, oleg, app, get } = await company();
    const put = (token: string, payload: object) => app.inject({ method: 'PUT', url: `/api/departments/${dev.id}/repository`, payload, ...as(token) });
    expect((await put(oleg, { url: 'https://github.com/acme/app.git', branch: 'main', token: 'ghp_secret1234' })).json().error.reason).toBe('company_scope_only');
    expect((await put(ceo, { url: 'http://github.com/acme/app.git', branch: 'main' })).json().error.reason).toBe('repo_invalid');
    const saved = await put(ceo, { url: 'https://github.com/acme/app.git', branch: 'main', token: 'ghp_secret1234' });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('ghp_secret');
    const org = await get(ceo, '/api/org');
    expect(org.body).not.toContain('ghp_secret');
    expect(org.json().departments.find((d: { id: string }) => d.id === dev.id).repository).toEqual({ url: 'https://github.com/acme/app.git', branch: 'main', tokenLast4: '1234' });
    expect((await put(ceo, { url: 'https://github.com/acme/app2.git', branch: 'dev' })).json().repository.tokenLast4).toBe('1234');
    expect((await app.inject({ method: 'DELETE', url: `/api/departments/${dev.id}/repository`, ...as(ceo) })).statusCode).toBe(204);
    expect((await get(ceo, '/api/org')).json().departments.find((d: { id: string }) => d.id === dev.id).repository).toBe(null);
  });

  it("streams a task's changes only to people who reach its department", async () => {
    const { app, ctx, head, bruno, dev, oleg, maria } = await company();
    const olegs = await openStream(app, oleg);
    const marias = await openStream(app, maria);
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true });
    await until(() => olegs.messages.some(m => m.type === 'task' && m.id === task.id));
    expect(marias.messages.some(m => m.type === 'task')).toBe(false);
    olegs.close();
    marias.close();
  });

  it('shows what a department works on now, and keeps a department with open tasks', async () => {
    const { ctx, db, companyId, ceo, post, get } = await company();
    const [design] = await db.insert(departments).values({ companyId, templateKey: 'design', roleCode: 'DSN', position: 3 }).returning();
    const [lead] = await db.insert(agents).values({ companyId, kind: 'head', name: 'Dora', roleKey: 'DSN-HEAD', departmentId: design!.id, model: '' }).returning();
    const { task } = await createTask(ctx, { personId: (await get(ceo, '/api/me')).json().person.id }, { title: 'Payments', brief: '', body: '', departmentId: design!.id, assigneeAgentId: lead!.id });
    expect((await get(ceo, '/api/org')).json().departments.find((d: { id: string }) => d.id === design!.id).current).toMatchObject({ number: 1, title: 'Payments' });
    await db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, lead!.id));
    const dev = design!;
    const kept = await post(ceo, '/api/departments/build', { items: [{ department: dev.id, note: '', remove: true }] });
    expect(kept.statusCode).toBe(400);
    expect(kept.json().error.message).toMatch(/open tasks/);
    await post(ceo, `/api/tasks/${task.id}/cancel`, { why: 'Dropped.' });
    expect((await post(ceo, '/api/departments/build', { items: [{ department: dev.id, note: '', remove: true }] })).statusCode).toBe(201);
    expect((await db.select().from(tasks))[0]).toMatchObject({ departmentId: null, status: 'cancelled' });
  });
});
