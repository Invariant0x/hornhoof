import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, goals, jobs, people, subscriptions, tasks } from '../src/db/schema.js';
import { createTask, updateTask } from '../src/modules/tasks/engine.js';
import { as, echelonsTurn, invitePerson, ownPlan, setUpCompany, testApp } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [dev, sales] = await db.insert(departments).values([
    { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
    { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
  ]).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const oleg = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id] } });
  const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
  await ownPlan(db, 'oleg@acme.com', bruno.id);
  await echelonsTurn(db, companyId);
  const id = async (email: string) => (await db.select({ id: people.id }).from(people).where(eq(people.email, email)))[0]!.id;
  const send = (method: 'POST' | 'PATCH' | 'PUT', token: string, url: string, payload: object) => app.inject({ method, url, payload, ...as(token) });
  const get = (token: string, url: string) => app.inject({ url, ...as(token) });
  const work = (title = 'Checkout') => createTask(app.ctx, { agentId: head.id }, { title, brief: 'Pay by card.', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, resultKind: 'code' });
  return { app, db, ctx: app.ctx, companyId, ceo, oleg, maria, dev: dev!, sales: sales!, head, bruno, send, get, work, ivanId: await id('ivan@acme.com'), olegId: await id('oleg@acme.com'), mariaId: await id('maria@acme.com') };
}

describe('a person makes a task with what the tracker keeps', () => {
  it('names its goal, responsible person, why, date and pipeline, and a subtask goes to the head of its parent', async () => {
    const { db, companyId, oleg, dev, head, olegId, send } = await company();
    const [goal] = await db.insert(goals).values({ companyId, number: 1, departmentId: dev.id, title: 'Shop', responsiblePersonId: olegId }).returning();
    const pipeline = (await send('POST', oleg, '/api/pipelines', { department: dev.id, name: 'Releases', stages: [{ key: 'lead', parent: null, name: 'Plan', ownerRole: 'DEV-HEAD' }] })).json().pipeline;
    const made = await send('POST', oleg, '/api/tasks', { title: 'Payments', brief: '', body: '', department: dev.id, goal: goal!.id, why: 'People pay online.', due: '2026-12-01T00:00:00.000Z', pipeline: pipeline.id });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().task).toMatchObject({ goal: { id: goal!.id, number: 1, title: 'Shop' }, responsible: { id: olegId, name: 'Oleg' }, why: 'People pay online.', dueAt: '2026-12-01T00:00:00.000Z', assignee: { name: 'Hana' } });
    const [row] = await db.select().from(tasks).where(eq(tasks.title, 'Payments'));
    expect([row!.pipelineId, row!.pipelineStageId]).toEqual([pipeline.id, pipeline.stages[0].id]);
    expect(made.json().task).toMatchObject({ pipelineId: pipeline.id, pipelineStageId: pipeline.stages[0].id });

    const under = await send('POST', oleg, '/api/tasks', { title: 'Card form', brief: '', body: '', parent: row!.id });
    expect(under.statusCode, under.body).toBe(201);
    expect(under.json().task).toMatchObject({ parentId: row!.id, department: { id: dev.id }, assignee: { id: head.id }, goal: { id: goal!.id }, responsible: { id: olegId } });
    const withGoal = await send('POST', oleg, '/api/tasks', { title: 'Card form', brief: '', body: '', parent: row!.id, goal: goal!.id });
    expect([withGoal.statusCode, withGoal.json().error.reason]).toEqual([400, 'goal_invalid']);
  });

  it('names who answers for each department beside the departments the tracker lists', async () => {
    const { ceo, dev, sales, olegId, mariaId, get } = await company();
    const listed = (await get(ceo, '/api/task-departments')).json().departments as { id: string; responsible: { id: string; name: string } | null }[];
    expect(listed.find(d => d.id === dev.id)!.responsible).toEqual({ id: olegId, name: 'Oleg' });
    expect(listed.find(d => d.id === sales.id)!.responsible).toEqual({ id: mariaId, name: 'Maria' });
  });

  it('refuses a responsible person who does not reach the department', async () => {
    const { oleg, dev, mariaId, send } = await company();
    const made = await send('POST', oleg, '/api/tasks', { title: 'Payments', brief: '', body: '', department: dev.id, responsible: mariaId });
    expect([made.statusCode, made.json().error.reason]).toEqual([400, 'responsible_invalid']);
  });
});

describe('a person edits what the tracker keeps of a task', () => {
  it('changes its texts and fields when they act on its work, waking nobody and keeping the version', async () => {
    const { db, ctx, head, oleg, maria, ivanId, send, get, work } = await company();
    const { task } = await work();
    const queued = (await db.select().from(jobs)).length;
    const edited = await send('PATCH', oleg, `/api/tasks/${task.id}`, { title: 'Customers pay by card', why: 'Shops sell online.', responsible: ivanId, due: '2026-12-24T00:00:00.000Z', version: task.version });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().task).toMatchObject({ title: 'Customers pay by card', brief: 'Pay by card.', why: 'Shops sell online.', responsible: { id: ivanId }, dueAt: '2026-12-24T00:00:00.000Z', version: task.version });
    const log = (await get(oleg, `/api/tasks/${task.id}`)).json().task.log as { kind: string; data: { fields?: string[] }; by: { name: string } }[];
    expect(log.at(-1)).toMatchObject({ kind: 'edited', data: { fields: ['title', 'why', 'responsible', 'due'] }, by: { name: 'Oleg' } });
    expect((await db.select().from(jobs)).length).toBe(queued);

    /* A move of its work makes what was read before it stale. */
    await updateTask(ctx, head.id, task.id, { brief: 'Pay by card or cash.' });
    const stale = await send('PATCH', oleg, `/api/tasks/${task.id}`, { title: 'Again', version: task.version });
    expect([stale.statusCode, stale.json().error.reason]).toEqual([409, 'task_changed']);
    expect((await get(oleg, `/api/tasks/${task.id}`)).json().task.mayEdit).toBe(true);
    expect((await get(maria, `/api/tasks/${task.id}`)).json().task.mayEdit).toBe(false);
    const other = await send('PATCH', maria, `/api/tasks/${task.id}`, { title: 'Mine', version: task.version + 1 });
    expect([other.statusCode, other.json().error.reason]).toEqual([403, 'task_not_yours']);
    const executor = await send('PATCH', oleg, `/api/tasks/${task.id}`, { executor: 'someone', version: task.version + 1 });
    expect(executor.statusCode).toBe(400);
  });

  it('sets what a task waits for through the engine checks', async () => {
    const { ceo, send, get, work } = await company();
    const { task: first } = await work('Prices');
    const { task: second } = await work('Checkout');
    const set = await send('PUT', ceo, `/api/tasks/${second.id}/after`, { after: [first.number], independentNone: 'The checkout shows the prices.', version: second.version });
    expect(set.statusCode, set.body).toBe(200);
    expect((await get(ceo, `/api/tasks/${second.id}`)).json().task.after.map((a: { number: number }) => a.number)).toEqual([first.number]);
    expect((await get(ceo, `/api/tasks/${first.id}`)).json().task.neededFor.map((a: { number: number }) => a.number)).toEqual([second.number]);
    const circle = await send('PUT', ceo, `/api/tasks/${first.id}/after`, { after: [second.number], independentNone: 'Loop.', version: first.version });
    expect([circle.statusCode, circle.json().error.message]).toEqual([400, '#1 would wait for itself through what it comes after.']);
  });

  it('names in each line of the list both who holds the task now and who does its work', async () => {
    const { db, oleg, dev, head, get, work } = await company();
    const { task } = await work();
    /* In review: the head holds it, the developer still does the work. */
    await db.update(tasks).set({ assigneeAgentId: head.id }).where(eq(tasks.id, task.id));
    const line = (await get(oleg, `/api/tasks?department=${dev.id}`)).json().tasks.find((t: { id: string }) => t.id === task.id);
    expect([line.assignee?.name, line.executor?.name]).toEqual(['Hana', 'Bruno']);
  });

  it('lists the tasks a person answers for', async () => {
    const { ceo, olegId, ivanId, send, get, work } = await company();
    const { task: mine } = await work('Prices');
    await work('Checkout');
    await send('PATCH', ceo, `/api/tasks/${mine.id}`, { responsible: ivanId, version: mine.version });
    expect((await get(ceo, `/api/tasks?responsible=${ivanId}`)).json().tasks.map((t: { title: string }) => t.title)).toEqual(['Prices']);
    expect((await get(ceo, `/api/tasks?responsible=${olegId}`)).json().tasks.map((t: { title: string }) => t.title)).toEqual(['Checkout']);
  });
});
