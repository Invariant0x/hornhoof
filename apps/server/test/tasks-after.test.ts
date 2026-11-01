import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, pendingWakes, people, subscriptions, taskEvents, tasks, turns } from '../src/db/schema.js';
import { comment, createTask, submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { as, listen, mcp, setUpCompany, testApp } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  await listen(app);
  const owner = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const tess = await hire('Tess', 'worker', 'DEV-TEST');
  const ctx = app.ctx;
  const parent = (await createTask(ctx, { personId: ceo!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head.id })).task;
  const member = async (title: string, executor: string, after: string[] = []) =>
    createTask(ctx, { agentId: head.id }, { title, brief: '', body: '', departmentId: dev!.id, parentId: parent.id, assigneeAgentId: executor, executor: true, gates: [rita.id], after });
  const read = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const turnsOf = (agentId: string) => db.select().from(jobs).where(eq(jobs.agentId, agentId));
  let n = 0;
  /* Hornhoof's tools as a running turn of this agent sees them. */
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  return { app, ctx, db, owner, companyId, ceo: ceo!, dev: dev!, head, bruno, rita, tess, parent, member, read, turnsOf, tools };
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: object) => (await c.callTool({ name, arguments: args })) as Res;
const text = (r: Res) => r.content[0]!.text;
const reason = (p: Promise<unknown>) => p.then(() => 'ok', (err: { reason?: string }) => err.reason);
const woken = (r: { wakes: { agentId: string; why: string }[] }) => r.wakes.map(w => [w.agentId, w.why]);

describe('a task that comes after others', () => {
  it('waits without waking its executor, and goes to it by itself once the last of them is done', async () => {
    const { ctx, db, bruno, rita, tess, member, read, turnsOf } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const schema = (await member('Database schema', bruno.id)).task;
    const tests = await member('End-to-end tests', tess.id, [api.id, schema.id]);
    expect(tests.task.after).toEqual([api.id, schema.id]);
    expect(woken(tests)).toEqual([]);
    expect(await db.select().from(pendingWakes).where(eq(pendingWakes.taskId, tests.task.id))).toEqual([]);

    await submit(ctx, bruno.id, api.id, { summary: 'Done.', evidence: 'npm test' });
    expect(woken(await verdict(ctx, rita.id, api.id, { pass: true, comment: 'Good.' }))).not.toContainEqual([tess.id, 'assigned']);
    await submit(ctx, bruno.id, schema.id, { summary: 'Done.', evidence: 'npm test' });
    const last = await verdict(ctx, rita.id, schema.id, { pass: true, comment: 'Good.' });
    expect(woken(last)).toContainEqual([tess.id, 'assigned']);
    /* The turn is kept with the move that finished the last of them. */
    expect(await db.select({ why: pendingWakes.why }).from(pendingWakes).where(and(eq(pendingWakes.taskId, tests.task.id), eq(pendingWakes.agentId, tess.id)))).toEqual([{ why: 'assigned' }]);
    expect((await read(tests.task.id)).assigneeAgentId).toBe(tess.id);
    const log = await db.select({ kind: taskEvents.kind, text: taskEvents.text }).from(taskEvents).where(eq(taskEvents.taskId, tests.task.id));
    expect(log.at(-1)).toEqual({ kind: 'started', text: `#${api.number} and #${schema.number} are done, so it starts now.` });
    await wakeAll(ctx, last.wakes);
    expect((await turnsOf(tess.id)).map(j => j.taskId)).toEqual([tests.task.id]);
  });

  it('wakes nobody on it and takes no work in for it while it waits', async () => {
    const { ctx, ceo, bruno, tess, member, turnsOf } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const tests = (await member('End-to-end tests', tess.id, [api.id])).task;
    await wakeAll(ctx, (await comment(ctx, { personId: ceo.id }, tests.id, 'Cover refunds too.')).wakes);
    await wakeAll(ctx, [{ agentId: tess.id, taskId: tests.id, why: 'reminder' }]);
    expect(await turnsOf(tess.id)).toEqual([]);
    expect(await reason(submit(ctx, tess.id, tests.id, { summary: 'Done.', evidence: 'npm test' }))).toBe('task_invalid');
  });

  it('comes only after tasks of its own turn that are not cancelled, and never after itself', async () => {
    const { ctx, db, companyId, dev, head, bruno, tess, member } = await company();
    const [old] = await db.insert(turns).values({ companyId, number: 1, goal: 'Old', status: 'closed', closedAt: new Date() }).returning();
    const [earlier] = await db.insert(tasks).values({ companyId, number: 90, turnId: old!.id, departmentId: dev.id, title: 'Old work', status: 'done', closedAt: new Date() }).returning();
    expect(await reason(member('End-to-end tests', tess.id, [earlier!.id]))).toBe('task_invalid');
    const api = (await member('Checkout API', bruno.id)).task;
    await db.update(tasks).set({ status: 'cancelled', closedAt: new Date() }).where(eq(tasks.id, api.id));
    expect(await reason(member('End-to-end tests', tess.id, [api.id]))).toBe('task_invalid');
    expect(await reason(member('End-to-end tests', tess.id, ['00000000-0000-4000-8000-000000000000']))).toBe('task_invalid');
    const free = await createTask(ctx, { agentId: head.id }, { title: 'Loose', brief: '', body: '', departmentId: dev.id, assigneeAgentId: tess.id, executor: true, after: [] });
    expect(free.task.after).toEqual([]);
  });

  it('starts at once when what it comes after is done already', async () => {
    const { ctx, bruno, rita, tess, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    await submit(ctx, bruno.id, api.id, { summary: 'Done.', evidence: 'npm test' });
    await verdict(ctx, rita.id, api.id, { pass: true, comment: 'Good.' });
    expect(woken(await member('End-to-end tests', tess.id, [api.id]))).toEqual([[tess.id, 'assigned']]);
  });

  it('lets the head change what a task comes after, starts it once nothing is left to wait for, and refuses a circle', async () => {
    const { ctx, head, bruno, tess, member, tools } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const tests = (await member('End-to-end tests', tess.id, [api.id])).task;
    expect(await reason(updateTask(ctx, head.id, api.id, { after: [tests.id] }))).toBe('task_invalid');
    expect(await reason(updateTask(ctx, head.id, api.id, { after: [api.id] }))).toBe('task_invalid');
    const docs = (await member('Docs', bruno.id)).task;
    expect(woken(await updateTask(ctx, head.id, docs.id, { after: [tests.id] }))).toEqual([]);
    expect(await reason(updateTask(ctx, head.id, api.id, { after: [docs.id] }))).toBe('task_invalid');
    const freed = await updateTask(ctx, head.id, tests.id, { after: [] });
    expect(freed.task.after).toEqual([]);
    expect(woken(freed)).toEqual([[tess.id, 'assigned']]);
    const client = await tools(head);
    const again = await call(client, 'update_task', { task: tests.number, after: [api.number] });
    expect(again.isError).toBeFalsy();
    expect(text(again)).toContain(`It starts once #${api.number} is done.`);
  });

  it("takes the tasks a person's task comes after by number through the API", async () => {
    const { app, db, owner, dev, head, bruno, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const res = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Launch', department: dev.id, after: [api.number] }, ...as(owner) });
    expect(res.statusCode).toBe(201);
    expect(res.json().task.waitsFor).toEqual([api.number]);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, head.id))).toEqual([]);
    const unknown = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Launch', department: dev.id, after: [999] }, ...as(owner) });
    expect(unknown.statusCode).toBe(400);
  });

  it('is made by the head with create_task, naming the tasks by number, and the task tool shows what it waits for', async () => {
    const { db, head, bruno, tess, member, tools } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const client = await tools(head);
    const made = await call(client, 'create_task', { title: 'End-to-end tests', brief: '', body: '', executor: tess.id, gates: [], after: [api.number] });
    expect(made.isError).toBeFalsy();
    expect(text(made)).toContain(`starts once #${api.number} is done`);
    const [tests] = await db.select().from(tasks).where(eq(tasks.title, 'End-to-end tests'));
    expect(tests!.after).toEqual([api.id]);
    const shown = JSON.parse(text(await call(await tools(tess), 'task', { task: tests!.number })));
    expect(shown.after).toEqual([{ id: api.id, number: api.number, title: 'Checkout API', status: 'open' }]);
    expect(shown.waitsFor).toEqual([api.number]);
    const unknown = await call(client, 'create_task', { title: 'More', brief: '', body: '', executor: tess.id, gates: [], after: [999] });
    expect(unknown.isError).toBe(true);
  });
});
