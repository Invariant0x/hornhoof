import { asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, goals, jobs, people, subscriptions, taskEvents, tasks, taskWaits } from '../src/db/schema.js';
import { answer, ask, cancel, createTask, startWork } from '../src/modules/tasks/engine.js';
import { giveTasks } from '../src/modules/tasks/turns.js';
import { as, echelonsTurn, invitePerson, setUpCompany, testApp } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev, sales] = await db.insert(departments).values([
    { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
    { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
  ]).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id] } });
  await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
  const id = async (email: string) => (await db.select({ id: people.id }).from(people).where(eq(people.email, email)))[0]!.id;
  await echelonsTurn(db, companyId);
  const work = (input: Partial<Parameters<typeof createTask>[2]> = {}) =>
    createTask(app.ctx, { agentId: head.id }, { title: 'Checkout', brief: 'Pay by card.', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, resultKind: 'code', ...input });
  const get = (path: string) => app.inject({ url: path, ...as(ceo) });
  return { app, db, ctx: app.ctx, companyId, sub: sub!, orchestrator: orchestrator!, dev: dev!, sales: sales!, head, bruno, work, get, ivanId: await id('ivan@acme.com'), olegId: await id('oleg@acme.com'), mariaId: await id('maria@acme.com') };
}

type Data = { fromStatus?: string; toStatus?: string };
const moves = async (db: Awaited<ReturnType<typeof company>>['db'], taskId: string) =>
  (await db.select({ kind: taskEvents.kind, data: taskEvents.data }).from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(asc(taskEvents.id)))
    .filter(e => 'toStatus' in e.data).map(e => [e.kind, (e.data as Data).fromStatus ?? null, (e.data as Data).toStatus]);

describe('status history', () => {
  it('writes where each status change went from and to, wherever it happens', async () => {
    const { ctx, db, companyId, sub, bruno, ivanId, work } = await company();
    const { task } = await work();
    const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, prompt: 'Go', timeoutMs: 60_000, status: 'running', startedAt: new Date() }).returning();
    await startWork(ctx, job!.id);
    const { request } = await ask(ctx, bruno.id, task.id, { kind: 'question', text: 'Which currency?' });
    await answer(ctx, { personId: ivanId }, request.id, { answer: 'EUR' });
    expect(await moves(db, task.id)).toEqual([['created', null, 'open'], ['status', 'open', 'working'], ['asked', 'working', 'waiting'], ['answered', 'waiting', 'working']]);
  });

  it('writes it for each piece of work cancelled with the task above it', async () => {
    const { ctx, db, ivanId, work } = await company();
    const { task } = await work();
    const { task: child } = await work({ parentId: task.id, title: 'Card form' });
    await cancel(ctx, { personId: ivanId }, task.id, 'Not needed now.');
    expect(await moves(db, child.id)).toEqual([['created', null, 'open'], ['cancelled', 'open', 'cancelled']]);
  });
});

describe('time facts', () => {
  it('says since when a task is in its status, how long it was worked on and whom it waits for', async () => {
    const { db, companyId, sub, bruno, olegId, work, get } = await company();
    const { task: old } = await work({ title: 'Old work' });
    /* As a task from before the log said where a status went: its last line is all there is to go by. */
    const at = new Date(Date.now() - 3 * 3_600_000);
    await db.update(taskEvents).set({ data: sql`${taskEvents.data} - 'toStatus'`, createdAt: new Date(at.getTime() - 60_000) }).where(eq(taskEvents.taskId, old.id));
    await db.insert(taskEvents).values({ companyId, taskId: old.id, kind: 'comment', text: 'Still on it.', createdAt: at });
    const minutes = (n: number) => new Date(Date.now() - n * 60_000);
    await db.insert(jobs).values([
      { companyId, subscriptionId: sub.id, agentId: bruno.id, taskId: old.id, prompt: 'a', timeoutMs: 1, status: 'done', startedAt: minutes(100), finishedAt: minutes(99) },
      { companyId, subscriptionId: sub.id, agentId: bruno.id, taskId: old.id, prompt: 'b', timeoutMs: 1, status: 'failed', startedAt: minutes(50), finishedAt: minutes(48) },
      { companyId, subscriptionId: sub.id, agentId: bruno.id, taskId: old.id, prompt: 'c', timeoutMs: 1, status: 'running', startedAt: minutes(1) },
      { companyId, subscriptionId: sub.id, agentId: bruno.id, taskId: old.id, prompt: 'd', timeoutMs: 1, status: 'queued' },
    ]);
    const since = minutes(30);
    await db.insert(taskWaits).values({ companyId, taskId: old.id, kind: 'person', sourceKey: 'question', sourceRevision: 0, state: 'legacy_needs_plan', ownerPersonId: olegId, createdAt: since });

    const read = await get(`/api/tasks/${old.id}`);
    expect(read.statusCode, read.body).toBe(200);
    const { time } = read.json().task;
    expect(time.inStatusSince).toBe(at.toISOString());
    expect(time.workSeconds).toBeGreaterThanOrEqual(240);
    expect(time.workSeconds).toBeLessThan(260);
    expect(time.waitsOn).toEqual([{ who: { kind: 'person', id: olegId, name: 'Oleg' }, since: since.toISOString() }]);
  });

  it('takes the time of the last status change over later words', async () => {
    const { db, companyId, ctx, sub, bruno, work, get } = await company();
    const { task } = await work();
    const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, prompt: 'Go', timeoutMs: 60_000, status: 'running', startedAt: new Date() }).returning();
    await startWork(ctx, job!.id);
    const [started] = await db.select().from(taskEvents).where(eq(taskEvents.kind, 'status'));
    await db.insert(taskEvents).values({ companyId, taskId: task.id, kind: 'comment', text: 'On it.', createdAt: new Date(Date.now() + 60_000) });
    expect((await get(`/api/tasks/${task.id}`)).json().task.time.inStatusSince).toBe(started!.createdAt.toISOString());
  });
});

describe('the person responsible for a new task', () => {
  it('is the department decision owner when nobody named one, and the named owner over the listed person', async () => {
    const { db, dev, olegId, ivanId, work } = await company();
    expect((await work()).task.responsiblePersonId).toBe(olegId);
    await db.update(departments).set({ ownerPersonId: ivanId }).where(eq(departments.id, dev.id));
    expect((await work()).task.responsiblePersonId).toBe(ivanId);
  });

  it('is the one named when they reach the department, else the parent task\'s, else the goal\'s', async () => {
    const { db, companyId, ivanId, mariaId, olegId, bruno, work } = await company();
    await expect(work({ responsiblePersonId: mariaId })).rejects.toMatchObject({ status: 400, reason: 'responsible_invalid' });
    const { task: top } = await work({ responsiblePersonId: ivanId, why: 'Shops sell by card.', dueAt: new Date('2026-12-01T00:00:00Z') });
    expect(top).toMatchObject({ responsiblePersonId: ivanId, why: 'Shops sell by card.', dueAt: new Date('2026-12-01T00:00:00Z') });
    const { task: under } = await work({ parentId: top.id, assigneeAgentId: bruno.id, title: 'Card form' });
    expect(under.responsiblePersonId).toBe(ivanId);
    const [goal] = await db.insert(goals).values({ companyId, number: 1, title: 'Shop', responsiblePersonId: olegId }).returning();
    const { task: served } = await work({ goalId: goal!.id });
    expect([served.goalId, served.responsiblePersonId]).toEqual([goal!.id, olegId]);
    await expect(work({ parentId: top.id, goalId: goal!.id })).rejects.toMatchObject({ status: 400, reason: 'goal_invalid' });
  });

  it('is set for work given to heads in a turn as well', async () => {
    const { ctx, companyId, orchestrator, dev, olegId } = await company();
    await giveTasks(ctx, { companyId, agentId: orchestrator.id, jobId: crypto.randomUUID() }, [{ department: dev.id, title: 'Price list', brief: '', body: '' }]);
    const [given] = await ctx.db.select().from(tasks).where(eq(tasks.title, 'Price list'));
    expect(given!.responsiblePersonId).toBe(olegId);
  });
});
