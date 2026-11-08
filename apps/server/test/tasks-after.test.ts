import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, pendingWakes, people, subscriptions, taskEvents, tasks, turns } from '../src/db/schema.js';
import { pump } from '../src/modules/conversation/queue.js';
import { cancel, comment, createTask as createTaskEngine, startWork, submit, updateTask as updateTaskEngine, verdict } from '../src/modules/tasks/engine.js';
import { taskDetail } from '../src/modules/tasks/views.js';
import { wakeAll, wakePrompt } from '../src/modules/tasks/wake.js';
import { as, invitePerson, listen, mcp, setUpCompany, statements, testApp, ownPlan } from './helpers.js';

const NONE = 'Genuine dependency in the existing behavior test.';
function withDefault<T extends { after?: string[]; independentPart?: unknown; independentNone?: string }>(input: T): T {
  return input.after?.length && !input.independentPart && input.independentNone === undefined ? { ...input, independentNone: NONE } : input;
}
const createTask = (ctx: Parameters<typeof createTaskEngine>[0], actor: Parameters<typeof createTaskEngine>[1], input: Parameters<typeof createTaskEngine>[2]) => createTaskEngine(ctx, actor, withDefault(input));
const updateTask = (ctx: Parameters<typeof updateTaskEngine>[0], agentId: string, taskId: string, change: Parameters<typeof updateTaskEngine>[3]) => updateTaskEngine(ctx, agentId, taskId, withDefault(change));

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
  /* Sales, with a deal of the CEO's that Development knows nothing of. */
  const outside = async () => {
    const [sales] = await db.insert(departments).values({ companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 }).returning();
    const [sid] = await db.insert(agents).values({ companyId, kind: 'head', name: 'Sid', roleKey: 'SAL-HEAD', departmentId: sales!.id, model: '', subscriptionId: sub!.id }).returning();
    return (await createTask(ctx, { personId: ceo!.id }, { title: 'Big deal', brief: '', body: '', departmentId: sales!.id, assigneeAgentId: sid!.id })).task;
  };
  return { app, ctx, db, owner, companyId, ceo: ceo!, dev: dev!, head, bruno, rita, tess, parent, member, read, turnsOf, tools, outside };
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Res;
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

  it('never comes after a task it is part of, however far up, as made or changed', async () => {
    const { ctx, dev, head, bruno, tess, parent, member } = await company();
    const said = (p: Promise<unknown>) => p.then(() => 'ok', (err: { message?: string }) => err.message);
    expect(await said(member('End-to-end tests', tess.id, [parent.id]))).toBe(`#${parent.number} is the task this work is part of, so it cannot come after it: #${parent.number} is done only once the work under it is.`);
    const api = (await member('Checkout API', bruno.id)).task;
    const under = (after: string[]) => createTask(ctx, { agentId: head.id }, { title: 'Card form', brief: '', body: '', departmentId: dev.id, parentId: api.id, assigneeAgentId: tess.id, executor: true, after });
    expect(await reason(under([parent.id]))).toBe('task_invalid');
    expect(await reason(under([api.id]))).toBe('task_invalid');
    const form = (await under([])).task;
    expect(await reason(updateTask(ctx, head.id, form.id, { after: [parent.id] }))).toBe('task_invalid');
    expect(await reason(updateTask(ctx, head.id, api.id, { after: [parent.id] }))).toBe('task_invalid');
    expect((await updateTask(ctx, head.id, form.id, { after: [] })).task.after).toEqual([]);
  });

  it('never comes after work under it, however far down', async () => {
    const { ctx, dev, head, bruno, tess, parent, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const form = (await createTask(ctx, { agentId: head.id }, { title: 'Card form', brief: '', body: '', departmentId: dev.id, parentId: api.id, assigneeAgentId: tess.id, executor: true })).task;
    const said = (p: Promise<unknown>) => p.then(() => 'ok', (err: { message?: string }) => err.message);
    expect(await said(updateTask(ctx, head.id, api.id, { after: [form.id] }))).toBe(`#${form.number} is work under #${api.number}, so #${api.number} cannot come after it: the work under a task is part of it.`);
    expect(await reason(updateTask(ctx, head.id, parent.id, { after: [form.id] }))).toBe('task_invalid');
    expect(await reason(updateTask(ctx, head.id, parent.id, { after: [api.id] }))).toBe('task_invalid');
  });

  it('takes no work under it while it waits', async () => {
    const { ctx, ceo, dev, head, bruno, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const launch = (await createTask(ctx, { personId: ceo.id }, { title: 'Launch', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id, after: [api.id] })).task;
    const under = createTask(ctx, { agentId: head.id }, { title: 'Release notes', brief: '', body: '', departmentId: dev.id, parentId: launch.id, assigneeAgentId: bruno.id, executor: true });
    expect(await under.then(() => 'ok', (err: { message?: string }) => err.message)).toBe(`#${launch.number} waits for #${api.number} first, so no work goes under it yet. You are woken once it can start.`);
  });

  it('takes the tasks that wait for a task as it is done before it looks at what else they wait for, so two done at once still start them', async () => {
    const { ctx, bruno, tess, rita, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const page = (await member('Checkout page', tess.id)).task;
    const launch = (await member('Launch', bruno.id, [api.id, page.id])).task;
    await submit(ctx, bruno.id, api.id, { summary: 'Done.', evidence: 'npm test' });
    const seen = statements();
    await verdict(ctx, rita.id, api.id, { pass: true, comment: 'Good.' });
    const lock = seen.findIndex(s => /from "tasks" where .*"tasks"\."after" @> .* for update$/.test(s.sql));
    const looking = seen.findIndex((s, i) => i > lock && s.sql.includes('"tasks"."status" <> $') && s.params.includes(api.id) && s.params.includes(page.id));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(looking).toBeGreaterThan(lock);
    expect(launch.id).toBeTruthy();
  });

  it('holds what it comes after as it is made, so one of them done at that moment still starts it', async () => {
    const { bruno, tess, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const seen = statements();
    const tests = (await member('End-to-end tests', tess.id, [api.id])).task;
    const held = seen.findIndex(s => /from "tasks" where "tasks"\."id" in \(\$1\).* for share$/.test(s.sql) && s.params[0] === api.id);
    const made = seen.findIndex(s => s.sql.startsWith('insert into "tasks"'));
    expect(held).toBeGreaterThanOrEqual(0);
    expect(held).toBeLessThan(made);
    expect(tests.after).toEqual([api.id]);
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
    const again = await call(client, 'update_task', { task: tests.number, after: [api.number], independentNone: NONE });
    expect(again.isError).toBeFalsy();
    expect(text(again)).toContain(`It starts once #${api.number} is done.`);
  });

  it('ends the turn its holder has waiting on it once it comes to wait, and wakes the holder again once it can start', async () => {
    const { ctx, head, bruno, rita, tess, member, turnsOf } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const tests = await member('End-to-end tests', tess.id);
    await wakeAll(ctx, tests.wakes);
    expect((await turnsOf(tess.id)).map(j => j.status)).toEqual(['queued']);
    expect(woken(await updateTask(ctx, head.id, tests.task.id, { after: [api.id] }))).toEqual([]);
    expect((await turnsOf(tess.id)).map(j => [j.status, j.error])).toEqual([['failed', 'waiting']]);
    await submit(ctx, bruno.id, api.id, { summary: 'Done.', evidence: 'npm test' });
    await wakeAll(ctx, (await verdict(ctx, rita.id, api.id, { pass: true, comment: 'Good.' })).wakes);
    expect((await turnsOf(tess.id)).filter(j => j.status === 'queued').map(j => j.taskId)).toEqual([tests.task.id]);
  });

  it('sends no turn of its holder that was left waiting on it, nor sets it to work by one', async () => {
    const { ctx, db, companyId, bruno, tess, member, read, turnsOf } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const tests = (await member('End-to-end tests', tess.id, [api.id])).task;
    /* As a wake that raced the change to what it comes after would leave one. */
    const [sub] = await db.select().from(subscriptions);
    const [left] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: tess.id, kind: 'conversation', prompt: 'Go on.', timeoutMs: 900000, taskId: tests.id }).returning();
    await startWork(ctx, left!.id);
    expect((await read(tests.id)).status).toBe('open');
    vi.spyOn(ctx.hub, 'isReady').mockReturnValue(true);
    vi.spyOn(ctx.hub, 'hasTerminals').mockReturnValue(false);
    const send = vi.spyOn(ctx.hub, 'send').mockReturnValue(true);
    await pump(ctx, tess.id);
    expect(send).not.toHaveBeenCalled();
    expect((await turnsOf(tess.id)).map(j => [j.status, j.error])).toEqual([['failed', 'waiting']]);
    expect((await read(tests.id)).status).toBe('open');
  });

  it("leaves such a turn out of the head's turn that takes in the others waiting for it", async () => {
    const { ctx, db, companyId, ceo, dev, head, bruno, parent, member, turnsOf } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const launch = (await createTask(ctx, { personId: ceo.id }, { title: 'Launch', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id, after: [api.id] })).task;
    const [sub] = await db.select().from(subscriptions);
    const turn = (taskId: string, prompt: string) => ({ companyId, subscriptionId: sub!.id, agentId: head.id, kind: 'conversation' as const, prompt, timeoutMs: 900000, taskId });
    await db.delete(jobs).where(eq(jobs.agentId, head.id));
    await db.insert(jobs).values(turn(parent.id, 'Payments moved.'));
    await db.insert(jobs).values({ ...turn(launch.id, 'Launch moved.'), createdAt: new Date(Date.now() + 1000) });
    vi.spyOn(ctx.hub, 'isReady').mockReturnValue(true);
    vi.spyOn(ctx.hub, 'hasTerminals').mockReturnValue(false);
    vi.spyOn(ctx.hub, 'takesSkillFiles').mockReturnValue(true);
    const sent: string[] = [];
    vi.spyOn(ctx.hub, 'send').mockImplementation((_, m) => Boolean(m.type === 'job.run' && sent.push(m.prompt)));
    await pump(ctx, head.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Payments moved.');
    expect(sent[0]).not.toContain('Launch moved.');
    expect((await turnsOf(head.id)).filter(j => j.taskId === launch.id).map(j => [j.status, j.error])).toEqual([['failed', 'waiting']]);
  });

  it('looks for a circle once changes to what tasks come after are taken one at a time, so two at once cannot close one', async () => {
    const { ctx, companyId, head, bruno, tess, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const tests = (await member('End-to-end tests', tess.id)).task;
    const seen = statements();
    await updateTask(ctx, head.id, api.id, { after: [tests.id] });
    const lock = seen.findIndex(s => /^select "id" from "companies" where "companies"\."id" = \$1 for update$/.test(s.sql) && s.params[0] === companyId);
    const circle = seen.findIndex(s => /^select "after" from "tasks" where "tasks"\."id" in \(\$1\)$/.test(s.sql) && s.params[0] === tests.id);
    const change = seen.findIndex(s => s.sql.startsWith('update "tasks"') && s.params.includes(api.id));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(circle);
    expect(circle).toBeLessThan(change);
  });

  it('holds what it comes after as that changes, and only then sees whether it waits, so one of them done meanwhile still starts it', async () => {
    const { ctx, head, bruno, tess, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const tests = (await member('End-to-end tests', tess.id)).task;
    const seen = statements();
    await updateTask(ctx, head.id, api.id, { after: [tests.id] });
    const held = seen.findIndex(s => /from "tasks" where "tasks"\."id" in \(\$1\).* for share$/.test(s.sql) && s.params[0] === tests.id);
    const change = seen.findIndex(s => s.sql.startsWith('update "tasks"') && s.params.includes(api.id));
    const looks = seen.flatMap((s, i) => (s.sql.includes('"tasks"."status" <> $') && s.params.includes(tests.id) ? [i] : []));
    expect(held).toBeGreaterThanOrEqual(0);
    expect(held).toBeLessThan(change);
    expect(looks.length).toBeGreaterThan(0);
    expect(looks.every(i => i > held)).toBe(true);
  });

  it('tells whoever made a waiting task once a task it comes after is cancelled, and it keeps waiting', async () => {
    const { ctx, db, ceo, head, bruno, tess, member, read, turnsOf } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const tests = (await member('End-to-end tests', tess.id, [api.id])).task;
    const gone = await cancel(ctx, { personId: ceo.id }, api.id, 'Not needed.');
    const told = gone.wakes.find(w => w.taskId === tests.id)!;
    expect(told).toMatchObject({ agentId: head.id, why: 'after_cancelled' });
    const [hana] = await db.select().from(agents).where(eq(agents.id, head.id));
    const prompt = wakePrompt(hana!, await read(tests.id), told);
    expect(prompt).toContain(`comes after #${api.number}, which was cancelled`);
    expect(prompt).toContain('update_task');
    expect(prompt).toContain('cancel_task');
    expect((await read(tests.id)).status).toBe('open');
    await wakeAll(ctx, gone.wakes);
    expect(await turnsOf(tess.id)).toEqual([]);
  });

  it('says it in the answer instead when the one who made the waiting task cancels', async () => {
    const { ctx, head, bruno, tess, member, tools } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const tests = (await member('End-to-end tests', tess.id, [api.id])).task;
    const res = await call(await tools(head), 'cancel_task', { task: api.number, why: 'Not needed.' });
    expect(text(res)).toContain(`#${tests.number} comes after it and still waits`);
    expect((await cancel(ctx, { agentId: head.id }, (await member('Docs', bruno.id)).task.id, 'No.')).wakes.filter(w => w.why === 'after_cancelled')).toEqual([]);
  });

  it("takes the tasks a person's task comes after by number through the API", async () => {
    const { app, db, owner, dev, head, bruno, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const res = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Launch', department: dev.id, after: [api.number], independentNone: NONE }, ...as(owner) });
    expect(res.statusCode).toBe(201);
    expect(res.json().task.waitsFor).toEqual([api.number]);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, head.id))).toEqual([]);
    const unknown = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Launch', department: dev.id, after: [999], independentNone: NONE }, ...as(owner) });
    expect(unknown.statusCode).toBe(400);
  });

  it('is made by the head with create_task, naming the tasks by number, and the task tool shows what it waits for', async () => {
    const { db, head, bruno, tess, member, tools } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const client = await tools(head);
    const made = await call(client, 'create_task', { title: 'End-to-end tests', brief: '', body: '', executor: tess.id, gates: [], after: [api.number], independentNone: NONE });
    expect(made.isError).toBeFalsy();
    expect(text(made)).toContain(`starts once #${api.number} is done`);
    const [tests] = await db.select().from(tasks).where(eq(tasks.title, 'End-to-end tests'));
    expect(tests!.after).toEqual([api.id]);
    const shown = JSON.parse(text(await call(await tools(tess), 'task', { task: tests!.number })));
    expect(shown.after).toEqual([{ id: api.id, number: api.number, title: 'Checkout API', status: 'open' }]);
    expect(shown.waitsFor).toEqual([api.number]);
    const unknown = await call(client, 'create_task', { title: 'More', brief: '', body: '', executor: tess.id, gates: [], after: [999], independentNone: NONE });
    expect(unknown.isError).toBe(true);
  });
});

describe('what a task comes after, as each one sees it', () => {
  it('is refused to a person for a task the person cannot reach, and left out of a task the person reads', async () => {
    const { app, ctx, owner, ceo, dev, head, outside } = await company();
    const deal = await outside();
    const dana = await invitePerson(app, owner, { name: 'Dana', email: 'dana@acme.com', access: { departments: [dev.id] } });
    const refused = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Launch', department: dev.id, after: [deal.number], independentNone: NONE }, ...as(dana) });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toBe(`There is no task #${deal.number} to come after.`);
    await ownPlan(ctx.db, 'dana@acme.com', head.id);
    const launch = (await createTask(ctx, { personId: ceo.id }, { title: 'Launch', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id, after: [deal.id] })).task;
    const read = (session: typeof owner) => app.inject({ url: `/api/tasks/${launch.id}`, ...as(session) }).then(r => r.json().task);
    expect(await read(dana)).toMatchObject({ after: [], waitsFor: [] });
    expect(await read(owner)).toMatchObject({ after: [{ title: 'Big deal' }], waitsFor: [deal.number] });
    const listed = (session: typeof owner) => app.inject({ url: '/api/tasks', ...as(session) }).then(r => r.json().tasks.find((t: { id: string }) => t.id === launch.id));
    expect(await listed(dana)).toMatchObject({ waitsFor: [] });
    expect(await listed(owner)).toMatchObject({ waitsFor: [deal.number] });
  });

  it("is left out of the task lines an agent reads for a task the agent cannot see", async () => {
    const { ctx, ceo, dev, head, tools, outside } = await company();
    const deal = await outside();
    const launch = (await createTask(ctx, { personId: ceo.id }, { title: 'Launch', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id, after: [deal.id] })).task;
    const lines = JSON.parse(text(await call(await tools(head), 'tasks', {}))) as { number: number; waitsFor: number[] }[];
    expect(lines.find(l => l.number === launch.number)).toMatchObject({ waitsFor: [] });
  });

  it("is refused to a head for another department's task, as a parent is", async () => {
    const { head, tools, outside } = await company();
    const deal = await outside();
    const res = await call(await tools(head), 'create_task', { title: 'Launch', brief: '', body: '', executor: head.id, gates: [], after: [deal.number], independentNone: NONE });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(`There is no task ${deal.number} to come after`);
  });
});

describe('an independent part of a dependent task', () => {
  it('requires a declaration without writing a task, event, child or wake', async () => {
    const { ctx, db, dev, head, bruno, tess, parent, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const input = { title: 'Dependent work', brief: '', body: '', departmentId: dev.id, parentId: parent.id, assigneeAgentId: tess.id, executor: true, gates: [], after: [api.id] };
    const before = {
      tasks: (await db.select({ id: tasks.id }).from(tasks)).length,
      events: (await db.select({ id: taskEvents.id }).from(taskEvents)).length,
      wakes: (await db.select({ id: pendingWakes.id }).from(pendingWakes)).length,
    };
    await expect(createTaskEngine(ctx, { agentId: head.id }, input)).rejects.toMatchObject({ reason: 'task_invalid', message: 'A task with after needs independentPart or independentNone.' });
    await expect(createTaskEngine(ctx, { agentId: head.id }, { ...input, independentPart: { title: 'Tests', brief: '', body: 'Write tests.', executor: bruno.id }, independentNone: 'Both.' })).rejects.toMatchObject({ reason: 'task_invalid' });
    await expect(createTaskEngine(ctx, { agentId: head.id }, { ...input, after: [], independentNone: 'Not needed.' })).rejects.toMatchObject({ reason: 'task_invalid' });
    expect((await db.select({ id: tasks.id }).from(tasks)).length).toBe(before.tasks);
    expect((await db.select({ id: taskEvents.id }).from(taskEvents)).length).toBe(before.events);
    expect((await db.select({ id: pendingWakes.id }).from(pendingWakes)).length).toBe(before.wakes);
  });

  it('starts the independent child while the parent waits and exposes the declaration', async () => {
    const { ctx, db, dev, head, bruno, rita, tess, parent, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const moved = await createTaskEngine(ctx, { agentId: head.id }, {
      title: 'Full checkout', brief: 'All of it.', body: 'The dependent part.', departmentId: dev.id, parentId: parent.id,
      assigneeAgentId: tess.id, executor: true, gates: [rita.id], after: [api.id], inTurnReview: true,
      independentPart: { title: 'Contract tests', brief: 'Test first.', body: 'Cover the API contract.', executor: bruno.id },
    });
    expect(moved.task.after).toEqual([api.id]);
    expect(moved.wakes.map(w => [w.agentId, w.why])).toEqual([[bruno.id, 'assigned']]);
    const children = await db.select().from(tasks).where(eq(tasks.parentId, moved.task.id));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ title: 'Contract tests', after: [], assigneeAgentId: bruno.id, executorAgentId: bruno.id, gates: [rita.id] });
    const detail = await taskDetail(ctx, moved.task, () => true);
    expect(detail.independentPart).toMatchObject({
      title: 'Contract tests', brief: 'Test first.', body: 'Cover the API contract.',
      executor: { id: bruno.id }, task: { id: children[0]!.id, number: children[0]!.number, status: 'open' },
    });
  });

  it('records the absence reason and leaves an old dependent task valid', async () => {
    const { ctx, db, companyId, dev, head, bruno, tess, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const declared = (await member('End-to-end tests', tess.id, [api.id])).task;
    expect((await taskDetail(ctx, declared, () => true)).independentPart).toEqual({ reason: NONE });
    const [old] = await db.insert(tasks).values({ companyId, number: 99, title: 'Old dependent', departmentId: dev.id, status: 'open', assigneeAgentId: tess.id, executorAgentId: tess.id, after: [api.id] }).returning();
    expect((await taskDetail(ctx, old!, () => true)).independentPart).toBeNull();
    expect((await updateTaskEngine(ctx, head.id, old!.id, { title: 'Old but updated' })).task.title).toBe('Old but updated');
  });

  it('creates the part when update_task changes only independentPart without changing after', async () => {
    const { ctx, db, dev, head, bruno, tess, parent, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const docs = (await createTask(ctx, { agentId: head.id }, { title: 'Docs', brief: '', body: '', departmentId: dev.id, parentId: parent.id, assigneeAgentId: tess.id, executor: true, after: [api.id] })).task;
    const moved = await updateTaskEngine(ctx, head.id, docs.id, { independentPart: { title: 'Examples', brief: 'Independent.', body: 'Write examples.', executor: bruno.id } });
    expect(moved.wakes.map(w => [w.agentId, w.why])).toEqual([[bruno.id, 'assigned']]);
    const children = await db.select().from(tasks).where(eq(tasks.parentId, docs.id));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ title: 'Examples', after: [], assigneeAgentId: bruno.id });
    expect((await taskDetail(ctx, docs, () => true)).independentPart).toMatchObject({ title: 'Examples', task: { id: children[0]!.id } });
  });

  it('is idempotent on update and hides the current declaration when after clears without deleting history', async () => {
    const { ctx, db, dev, head, bruno, tess, parent, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const docs = (await createTask(ctx, { agentId: head.id }, { title: 'Docs', brief: '', body: '', departmentId: dev.id, parentId: parent.id, assigneeAgentId: tess.id, executor: true })).task;
    const independentPart = { title: 'Examples', brief: 'Independent.', body: 'Write examples.', executor: bruno.id };
    await updateTaskEngine(ctx, head.id, docs.id, { after: [api.id], independentPart });
    await updateTaskEngine(ctx, head.id, docs.id, { after: [api.id], independentPart });
    expect(await db.select().from(tasks).where(eq(tasks.parentId, docs.id))).toHaveLength(1);
    await updateTaskEngine(ctx, head.id, docs.id, { after: [] });
    expect((await taskDetail(ctx, docs, () => true)).independentPart).toBeNull();
    await updateTaskEngine(ctx, head.id, docs.id, { after: [api.id], independentPart });
    expect(await db.select().from(tasks).where(eq(tasks.parentId, docs.id))).toHaveLength(1);
    expect(await db.select().from(taskEvents).where(eq(taskEvents.taskId, docs.id))).not.toHaveLength(0);
  });

  it('does not finish the parent or open turn review when the independent child finishes early', async () => {
    const { ctx, db, dev, head, bruno, rita, tess, parent, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const moved = await createTaskEngine(ctx, { agentId: head.id }, {
      title: 'Full checkout', brief: '', body: '', departmentId: dev.id, parentId: parent.id,
      assigneeAgentId: tess.id, executor: true, gates: [rita.id], after: [api.id], inTurnReview: true,
      independentPart: { title: 'Contract tests', brief: '', body: 'Test first.', executor: bruno.id },
    });
    const [child] = await db.select().from(tasks).where(eq(tasks.parentId, moved.task.id));
    await submit(ctx, bruno.id, child!.id, { summary: 'Done.', evidence: 'npm test' });
    await verdict(ctx, rita.id, child!.id, { pass: true, comment: 'Good.' });
    expect((await db.select().from(tasks).where(eq(tasks.id, moved.task.id)))[0]!.status).not.toBe('done');
    expect(await db.select().from(taskEvents).where(sql`${taskEvents.data}->>'turnReview' = 'true'`)).toHaveLength(0);
  });

  it('requires the declaration through the person API and returns the linked child', async () => {
    const { app, db, owner, dev, bruno, member } = await company();
    const api = (await member('Checkout API', bruno.id)).task;
    const refused = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Launch', department: dev.id, after: [api.number] }, ...as(owner) });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toBe('A task with after needs independentPart or independentNone.');
    expect(await db.select().from(tasks).where(eq(tasks.title, 'Launch'))).toHaveLength(0);
    const made = await app.inject({ method: 'POST', url: '/api/tasks', payload: {
      title: 'Launch', department: dev.id, after: [api.number],
      independentPart: { title: 'Release notes', brief: 'Now.', body: 'Write notes.', executor: bruno.id },
    }, ...as(owner) });
    expect(made.statusCode).toBe(201);
    expect(made.json().task.independentPart).toMatchObject({ title: 'Release notes', executor: { id: bruno.id }, task: { title: 'Release notes', status: 'open' } });
    expect(await db.select().from(tasks).where(eq(tasks.parentId, made.json().task.id))).toHaveLength(1);
  });
});
