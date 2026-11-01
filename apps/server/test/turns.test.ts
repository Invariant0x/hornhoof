import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, improvements, jobs, people, subscriptions, taskEvents, tasks, turns } from '../src/db/schema.js';
import { appendEvent } from '../src/modules/events/store.js';
import { settle } from '../src/modules/tasks/turns.js';
import { invitePerson, listen, mcp, setUpCompany, testApp } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  await listen(app);
  const ceoToken = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev, sales, design] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
      { companyId, templateKey: 'design', roleCode: 'DSN', position: 3 },
    ])
    .returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD', dev!.id);
  const sara = await hire('Sara', 'head', 'SAL-HEAD', sales!.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-BE', dev!.id);
  let n = 0;
  /* Hornhoof's tools as a running turn of this agent sees them. */
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  /* What a person wrote to the orchestrator, as the window or his terminal stores it. Times count in milliseconds and
     people write seconds apart, so it waits a little first. */
  const say = async (text: string, personId = ceo!.id) => {
    await new Promise(r => setTimeout(r, 5));
    await appendEvent(app.ctx, { companyId, agentId: orchestrator!.id, kind: 'message', data: { text }, personId });
  };
  /* A person's message to the orchestrator with the turn it makes: queued, or running with his tools. */
  const message = async (text: string, status: 'running' | 'queued' = 'running') => {
    await new Promise(r => setTimeout(r, 5));
    const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: `Ivan (CEO): ${text}`, timeoutMs: 900000, status: 'queued', createdBy: ceo!.id }).returning();
    await appendEvent(app.ctx, { companyId, agentId: orchestrator!.id, jobId: job!.id, kind: 'message', data: { text }, personId: ceo!.id });
    const run = async () => {
      const token = `tool-token-${++n}-0123456789abcdef0123456789`;
      await db.update(jobs).set({ status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) }).where(eq(jobs.id, job!.id));
      return mcp(app, token);
    };
    return { run, tools: status === 'running' ? await run() : null };
  };
  /* Turns queued for an agent, oldest first. */
  const queued = async (agentId: string) => db.select({ prompt: jobs.prompt, taskId: jobs.taskId }).from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt));
  const get = (token: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie: `hh_session=${token}` } });
  return { app, db, ctx: app.ctx, companyId, ceo: ceo!, ceoToken, orchestrator: orchestrator!, dev: dev!, sales: sales!, design: design!, hana, sara, bruno, tools, say, message, queued, get };
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: object) => (await c.callTool({ name, arguments: args })) as Res;
const text = (r: Res) => r.content[0]!.text;
const work = (department: string, title: string) => ({ department, title, brief: `${title}, in a line.`, body: `${title}: what to build.` });

describe('turns', () => {
  it('gives the orchestrator turn tools instead of handing out single tasks', async () => {
    const { orchestrator, hana, tools } = await company();
    const names = async (agent: { id: string }) => (await (await tools(agent)).listTools()).tools.map(t => t.name).sort();
    expect(await names(orchestrator)).toEqual(['add_api_key', 'add_tasks', 'answer_request', 'ask_person', 'build_structure', 'cancel_task', 'cancel_update', 'change_employee', 'change_orchestrator', 'change_person', 'check_updates', 'close_improvement', 'comment', 'company', 'connect_plans', 'database', 'disconnect_machine', 'edit_turn', 'explain_request', 'fire_employee', 'forget', 'hire', 'improvements', 'invite_again', 'invite_person', 'merge_turn', 'message_employee', 'move_orchestrator', 'notebook', 'plan_command', 'plan_turn', 'propose_staff', 'propose_structure', 'remember', 'remove_public_link', 'remove_repository', 'remove_subscription', 'report', 'reset_employee', 'rewrite_note', 'set_budget', 'set_public_link', 'set_repository', 'staffing_options', 'stop_employee', 'task', 'tasks', 'test_subscription', 'turns', 'update_hornhoof', 'update_task', 'view']);
    expect(await names(hana)).toContain('create_task');
    expect(await names(hana)).not.toContain('merge_turn');
  });

  it('starts the first turn at once and gives each task to its head', async () => {
    const { db, orchestrator, dev, sales, hana, sara, tools, queued } = await company();
    const res = await call(await tools(orchestrator), 'plan_turn', { title: 'Payments', goal: 'People can pay by card.', tasks: [work(dev.id, 'Checkout'), work(sales.id, 'Pricing page copy')] });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('Turn 1');
    expect(text(res)).toContain('started');
    const [turn] = await db.select().from(turns);
    expect(turn).toMatchObject({ number: 1, title: 'Payments', goal: 'People can pay by card.', status: 'open', createdByAgentId: orchestrator.id });
    expect(turn!.openedAt).not.toBe(null);
    const rows = await db.select().from(tasks).orderBy(asc(tasks.number));
    expect(rows.map(t => [t.title, t.status, t.assigneeAgentId, t.turnId, t.createdByAgentId, t.parentId])).toEqual([
      ['Checkout', 'open', hana.id, turn!.id, orchestrator.id, null],
      ['Pricing page copy', 'open', sara.id, turn!.id, orchestrator.id, null],
    ]);
    expect((await queued(hana.id)).map(j => j.taskId)).toEqual([rows[0]!.id]);
    expect((await queued(sara.id)).map(j => j.taskId)).toEqual([rows[1]!.id]);
  });

  it('plans the next turns while one runs, and wakes nobody for them', async () => {
    const { db, orchestrator, dev, hana, tools, queued } = await company();
    const client = await tools(orchestrator);
    await call(client, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    const second = await call(client, 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    expect(text(second)).toContain('Turn 2');
    expect(text(second)).toContain('planned');
    const third = await call(client, 'plan_turn', { title: 'Reports', goal: 'Monthly totals.', tasks: [work(dev.id, 'Totals')] });
    expect(text(third)).toContain('Turn 3');
    expect((await db.select({ n: turns.number, s: turns.status }).from(turns).orderBy(asc(turns.number))).map(t => [t.n, t.s])).toEqual([
      [1, 'open'],
      [2, 'planned'],
      [3, 'planned'],
    ]);
    const planned = await db.select().from(tasks).where(eq(tasks.status, 'planned'));
    expect(planned.map(t => [t.title, t.assigneeAgentId, t.departmentId])).toEqual([
      ['Refund button', null, dev.id],
      ['Totals', null, dev.id],
    ]);
    expect(await queued(hana.id)).toHaveLength(1);
  });

  it('merges a planned turn into the running one without recreating work or waking it twice', async () => {
    const { db, orchestrator, dev, hana, tools, queued } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(boss, 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    const [checkout] = await db.select().from(tasks).where(eq(tasks.number, 1));
    const [refund] = await db.select().from(tasks).where(eq(tasks.number, 2));
    const [source] = await db.select().from(turns).where(eq(turns.number, 2));
    const [target] = await db.select().from(turns).where(eq(turns.number, 1));
    const [before] = await db.select().from(jobs).where(eq(jobs.taskId, checkout!.id));

    const merged = await call(boss, 'merge_turn', { source: 2, target: 1 });
    expect(merged.isError).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.id, refund!.id)))[0]).toMatchObject({ number: 2, turnId: target!.id, status: 'open', assigneeAgentId: hana.id });
    expect((await db.select().from(turns).where(eq(turns.id, source!.id)))[0]).toMatchObject({ number: 2, status: 'closed' });
    expect((await db.select().from(tasks).where(eq(tasks.id, checkout!.id)))[0]).toMatchObject({ turnId: target!.id, status: 'open' });
    expect((await queued(hana.id)).map(j => j.taskId)).toEqual([checkout!.id, refund!.id]);
    expect((await db.select().from(jobs).where(eq(jobs.id, before!.id)))[0]).toEqual(before);

    const again = await call(boss, 'merge_turn', { source: 2, target: 1 });
    expect(again.isError).toBeFalsy();
    expect(await db.select().from(tasks)).toHaveLength(2);
    expect(await queued(hana.id)).toHaveLength(2);
  });

  it('merges into a planned target without wakes and keeps the following turn order', async () => {
    const { db, orchestrator, dev, hana, tools, queued } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { title: 'One', goal: 'First.', tasks: [work(dev.id, 'First task')] });
    await call(boss, 'plan_turn', { title: 'Two', goal: 'Second.', tasks: [work(dev.id, 'Target task')] });
    await call(boss, 'plan_turn', { title: 'Three', goal: 'Third.', tasks: [work(dev.id, 'Source task')] });
    await call(boss, 'plan_turn', { title: 'Four', goal: 'Fourth.', tasks: [work(dev.id, 'Next task')] });
    const [target, source, next] = await db.select().from(turns).where(inArray(turns.number, [2, 3, 4])).orderBy(asc(turns.number));
    const [sourceTask] = await db.select().from(tasks).where(eq(tasks.number, 3));

    expect((await call(boss, 'merge_turn', { source: 3, target: 2 })).isError).toBeFalsy();
    expect((await db.select().from(turns).orderBy(asc(turns.number))).map(t => [t.number, t.status])).toEqual([
      [1, 'open'],
      [2, 'planned'],
      [3, 'closed'],
      [4, 'planned'],
    ]);
    expect((await db.select().from(tasks).where(eq(tasks.id, sourceTask!.id)))[0]).toMatchObject({ turnId: target!.id, status: 'planned', assigneeAgentId: null });
    expect(await queued(hana.id)).toHaveLength(1);

    await call(await tools(hana), 'report', { task: 1, done: true, summary: 'First done.' });
    expect((await db.select().from(turns).where(eq(turns.id, target!.id)))[0]).toMatchObject({ status: 'open' });
    expect((await db.select().from(tasks).where(eq(tasks.id, sourceTask!.id)))[0]).toMatchObject({ status: 'open', assigneeAgentId: hana.id });
    await call(await tools(hana), 'report', { task: 2, done: true, summary: 'Target done.' });
    expect((await db.select().from(turns).where(eq(turns.id, next!.id)))[0]).toMatchObject({ status: 'planned' });
    await call(await tools(hana), 'report', { task: 3, done: true, summary: 'Source done.' });
    expect((await db.select().from(turns).where(eq(turns.id, source!.id)))[0]).toMatchObject({ status: 'closed' });
    expect((await db.select().from(turns).where(eq(turns.id, next!.id)))[0]).toMatchObject({ status: 'open' });
    expect((await queued(hana.id)).filter(j => j.taskId === sourceTask!.id)).toHaveLength(1);
    expect((await queued(hana.id)).filter(j => j.prompt.includes('Next task'))).toHaveLength(1);
  });

  it('keeps task trees, results, jobs and improvement links when merging', async () => {
    const { db, companyId, ceoToken, orchestrator, dev, hana, bruno, message, get } = await company();
    const [idea] = await db.insert(improvements).values({ companyId, agentId: bruno.id, title: 'Keep links', text: 'Preserve the task link.' }).returning();
    const boss = (await message('Take this improvement into work.')).tools!;
    await call(boss, 'plan_turn', { title: 'Target', goal: 'Current work.', tasks: [work(dev.id, 'Current task')] });
    await call(boss, 'plan_turn', { title: 'Source', goal: 'Linked work.', improvement: idea!.id, tasks: [work(dev.id, 'Improvement root')] });
    const [target] = await db.select().from(turns).where(eq(turns.number, 1));
    const [source] = await db.select().from(turns).where(eq(turns.number, 2));
    const [root] = await db.select().from(tasks).where(eq(tasks.number, 2));
    const [child] = await db
      .insert(tasks)
      .values({ companyId, number: 3, turnId: source!.id, parentId: root!.id, departmentId: dev.id, title: 'Open child', brief: 'Keep assignee.', body: 'Continue the same work.', status: 'open', assigneeAgentId: bruno.id, executorAgentId: bruno.id, gates: [hana.id], createdByAgentId: orchestrator.id })
      .returning();
    const [finished] = await db
      .insert(tasks)
      .values({ companyId, number: 4, turnId: source!.id, parentId: root!.id, departmentId: dev.id, title: 'Finished child', brief: 'Keep result.', body: 'Finished work.', status: 'done', closedAt: new Date(), executorAgentId: bruno.id, createdByAgentId: orchestrator.id })
      .returning();
    await db.insert(taskEvents).values({ companyId, taskId: finished!.id, kind: 'submitted', agentId: bruno.id, text: 'Child result.', data: { evidence: 'kept evidence' } });
    const [sub] = await db.select().from(subscriptions);
    const [running] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: bruno.id, taskId: child!.id, kind: 'conversation', prompt: 'Child work', timeoutMs: 900000, status: 'running', startedAt: new Date() }).returning();

    expect((await call(boss, 'merge_turn', { source: 2, target: 1 })).isError).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.id, root!.id)))[0]).toMatchObject({ turnId: target!.id, status: 'open', assigneeAgentId: hana.id });
    expect((await db.select().from(tasks).where(eq(tasks.id, child!.id)))[0]).toMatchObject({ turnId: target!.id, parentId: root!.id, status: 'open', assigneeAgentId: bruno.id, executorAgentId: bruno.id, gates: [hana.id], body: 'Continue the same work.' });
    expect((await db.select().from(tasks).where(eq(tasks.id, finished!.id)))[0]).toMatchObject({ turnId: target!.id, parentId: root!.id, status: 'done', closedAt: finished!.closedAt });
    expect((await db.select().from(jobs).where(eq(jobs.id, running!.id)))[0]).toEqual(running);
    expect((await db.select().from(taskEvents).where(eq(taskEvents.taskId, finished!.id)))[0]).toMatchObject({ kind: 'submitted', text: 'Child result.', data: { evidence: 'kept evidence' } });
    const listed = (await get(ceoToken, '/api/improvements')).json().improvements.find((i: { id: string }) => i.id === idea!.id);
    expect(listed).toMatchObject({ status: 'taken', decidedBy: 'Ivan', tasks: [{ id: root!.id, number: 2, title: 'Improvement root' }] });
    expect(await db.select().from(tasks)).toHaveLength(4);
  });

  it('closes all-closed and truly empty sources without moving their history', async () => {
    const { db, companyId, orchestrator, dev, tools } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { title: 'Target', goal: 'Current work.', tasks: [work(dev.id, 'Current task')] });
    await call(boss, 'plan_turn', { title: 'History', goal: 'Closed work.', tasks: [work(dev.id, 'Finished'), work(dev.id, 'Replaced')] });
    const [target] = await db.select().from(turns).where(eq(turns.number, 1));
    const [source] = await db.select().from(turns).where(eq(turns.number, 2));
    const [checkout] = await db.select().from(tasks).where(eq(tasks.number, 1));
    const at = new Date();
    await db.update(tasks).set({ status: 'done', closedAt: at }).where(eq(tasks.number, 2));
    await db.update(tasks).set({ status: 'cancelled', closedAt: at }).where(eq(tasks.number, 3));
    await db.insert(taskEvents).values({ companyId, taskId: (await db.select().from(tasks).where(eq(tasks.number, 3)))[0]!.id, kind: 'cancelled', agentId: orchestrator.id, text: 'Replaced by #1.', data: { replacement: checkout!.id } });

    expect((await call(boss, 'merge_turn', { source: 2, target: 1 })).isError).toBeFalsy();
    expect((await db.select().from(turns).where(eq(turns.id, source!.id)))[0]).toMatchObject({ status: 'closed', openedAt: null });
    expect((await db.select().from(tasks).where(eq(tasks.turnId, target!.id)))).toHaveLength(1);
    expect((await db.select().from(tasks).where(eq(tasks.number, 2)))[0]).toMatchObject({ turnId: source!.id, status: 'done' });
    const [replaced] = await db.select().from(tasks).where(eq(tasks.number, 3));
    expect(replaced).toMatchObject({ turnId: source!.id, status: 'cancelled' });
    expect((await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, replaced!.id), eq(taskEvents.kind, 'cancelled'))))[0]).toMatchObject({ text: 'Replaced by #1.', data: { replacement: checkout!.id } });
    expect((await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, replaced!.id), eq(taskEvents.kind, 'updated'))))[0]).toMatchObject({ data: { fields: [], from: 2, to: 1, moved: false } });

    const [empty] = await db.insert(turns).values({ companyId, number: 3, goal: 'No tasks remain.', status: 'planned', createdByAgentId: orchestrator.id }).returning();
    expect((await call(boss, 'merge_turn', { source: 3, target: 1 })).isError).toBeFalsy();
    expect((await db.select().from(turns).where(eq(turns.id, empty!.id)))[0]).toMatchObject({ status: 'closed', openedAt: null });
    expect((await db.select().from(tasks).where(eq(tasks.turnId, target!.id)))).toHaveLength(1);
  });

  it('does not treat blocked or review tasks as empty history', async () => {
    const { db, ctx, orchestrator, dev, hana, bruno, tools, queued } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { title: 'Target', goal: 'Current work.', tasks: [work(dev.id, 'Current task')] });
    await call(boss, 'plan_turn', { title: 'Source', goal: 'Unfinished work.', tasks: [work(dev.id, 'Finished'), work(dev.id, 'Blocked'), work(dev.id, 'Review')] });
    const [target] = await db.select().from(turns).where(eq(turns.number, 1));
    const [source] = await db.select().from(turns).where(eq(turns.number, 2));
    await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.number, 2));
    await db.update(tasks).set({ status: 'blocked', assigneeAgentId: hana.id }).where(eq(tasks.number, 3));
    await db.update(tasks).set({ status: 'review', stage: 1, gates: [hana.id], panel: [hana.id], executorAgentId: bruno.id, assigneeAgentId: hana.id }).where(eq(tasks.number, 4));
    const [finished] = await db.select().from(tasks).where(eq(tasks.number, 2));

    expect(await settle(ctx, finished!)).toBeNull();
    expect((await db.select().from(turns).where(eq(turns.id, source!.id)))[0]).toMatchObject({ status: 'planned' });
    expect((await call(boss, 'merge_turn', { source: 2, target: 1 })).isError).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.number, 3)))[0]).toMatchObject({ turnId: target!.id, status: 'blocked', assigneeAgentId: hana.id });
    expect((await db.select().from(tasks).where(eq(tasks.number, 4)))[0]).toMatchObject({ turnId: target!.id, status: 'review', stage: 1, panel: [hana.id], assigneeAgentId: hana.id });
    expect((await db.select().from(turns).where(eq(turns.id, source!.id)))[0]).toMatchObject({ status: 'closed' });
    expect(await queued(hana.id)).toHaveLength(1);
  });

  it('rejects invalid merge directions and other companies without moving tasks', async () => {
    const { db, orchestrator, dev, tools } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { title: 'One', goal: 'First.', tasks: [work(dev.id, 'First task')] });
    await call(boss, 'plan_turn', { title: 'Two', goal: 'Second.', tasks: [work(dev.id, 'Second task')] });
    await call(boss, 'plan_turn', { title: 'Three', goal: 'Third.', tasks: [work(dev.id, 'Third task')] });
    const before = await db.select().from(tasks).orderBy(asc(tasks.id));
    expect((await call(boss, 'merge_turn', { source: 1, target: 1 })).isError).toBe(true);
    expect((await call(boss, 'merge_turn', { source: 1, target: 2 })).isError).toBe(true);
    expect((await call(boss, 'merge_turn', { source: 99, target: 1 })).isError).toBe(true);
    const [other] = await db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    await db.insert(turns).values({ companyId: other!.id, number: 9, goal: 'Foreign work.', status: 'planned' });
    expect((await call(boss, 'merge_turn', { source: 9, target: 1 })).isError).toBe(true);
    expect((await call(boss, 'merge_turn', { source: 2, target: 9 })).isError).toBe(true);
    await db.update(turns).set({ status: 'closed', closedAt: new Date() }).where(eq(turns.number, 2));
    expect((await call(boss, 'merge_turn', { source: 3, target: 2 })).isError).toBe(true);
    expect((await db.select().from(turns).where(eq(turns.number, 3)))[0]).toMatchObject({ status: 'planned' });
    expect(await db.select().from(tasks).orderBy(asc(tasks.id))).toEqual(before);
  });

  it('merges only once when the same calls race', async () => {
    const { db, orchestrator, dev, hana, tools, queued } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { title: 'Target', goal: 'Current work.', tasks: [work(dev.id, 'Current task')] });
    await call(boss, 'plan_turn', { title: 'Source', goal: 'Later work.', tasks: [work(dev.id, 'Source task')] });
    const [root] = await db.select().from(tasks).where(eq(tasks.number, 2));
    const results = await Promise.all([call(boss, 'merge_turn', { source: 2, target: 1 }), call(boss, 'merge_turn', { source: 2, target: 1 })]);
    expect(results.map(r => !!r.isError)).toEqual([false, false]);
    expect(await db.select().from(tasks)).toHaveLength(2);
    expect(await queued(hana.id)).toHaveLength(2);
    expect(await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, root!.id), eq(taskEvents.kind, 'updated')))).toHaveLength(1);
    expect((await db.select().from(turns).where(eq(turns.number, 2)))[0]).toMatchObject({ status: 'closed' });
  });

  it('closes empty planned turns as soon as their last task is cancelled', async () => {
    const { db, orchestrator, dev, tools } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(boss, 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    await call(boss, 'plan_turn', { title: 'Reports', goal: 'Monthly totals.', tasks: [work(dev.id, 'Totals'), work(dev.id, 'Export')] });
    const [cancelledSource, mixedSource] = await db.select().from(turns).where(inArray(turns.number, [2, 3])).orderBy(asc(turns.number));

    expect((await call(boss, 'cancel_task', { task: 2, why: 'Replaced by Checkout.' })).isError).toBeFalsy();
    expect((await db.select().from(turns).where(eq(turns.id, cancelledSource!.id)))[0]).toMatchObject({ status: 'closed' });
    expect((await db.select().from(tasks).where(eq(tasks.number, 2)))[0]).toMatchObject({ status: 'cancelled', turnId: cancelledSource!.id });

    await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.number, 3));
    expect((await call(boss, 'cancel_task', { task: 4, why: 'Not needed.' })).isError).toBeFalsy();
    expect((await db.select().from(turns).where(eq(turns.id, mixedSource!.id)))[0]).toMatchObject({ status: 'closed' });
    expect((await db.select().from(tasks).where(eq(tasks.number, 3)))[0]).toMatchObject({ status: 'done', turnId: mixedSource!.id });
    expect((await db.select().from(tasks).where(eq(tasks.number, 4)))[0]).toMatchObject({ status: 'cancelled', turnId: mixedSource!.id });
    expect((await db.select().from(turns).where(eq(turns.number, 1)))[0]).toMatchObject({ status: 'open' });
  });

  it('adds tasks to the running turn at once, and to a planned turn for later', async () => {
    const { db, orchestrator, dev, sales, hana, sara, tools, queued } = await company();
    const client = await tools(orchestrator);
    await call(client, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(client, 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    const now = await call(client, 'add_tasks', { turn: 1, tasks: [work(sales.id, 'Tell the customers')] });
    expect(now.isError).toBeFalsy();
    expect(text(now)).toContain('Turn 1');
    const later = await call(client, 'add_tasks', { turn: 2, tasks: [work(dev.id, 'Refund email')] });
    expect(later.isError).toBeFalsy();
    const byTitle = async (title: string) => (await db.select().from(tasks).where(eq(tasks.title, title)))[0]!;
    const [first, second] = await db.select().from(turns).orderBy(asc(turns.number));
    expect(await byTitle('Tell the customers')).toMatchObject({ status: 'open', assigneeAgentId: sara.id, turnId: first!.id });
    expect(await byTitle('Refund email')).toMatchObject({ status: 'planned', assigneeAgentId: null, turnId: second!.id });
    expect(await queued(sara.id)).toHaveLength(1);
    expect(await queued(hana.id)).toHaveLength(1);
  });

  it('refuses work it cannot place, in words the orchestrator can act on', async () => {
    const { db, orchestrator, dev, design, tools } = await company();
    const client = await tools(orchestrator);
    const headless = await call(client, 'plan_turn', { title: 'Logo', goal: 'A logo.', tasks: [work(design.id, 'Logo')] });
    expect(headless.isError).toBe(true);
    expect(text(headless)).toMatch(/no head/i);
    expect(await db.select().from(turns)).toEqual([]);
    expect((await call(client, 'plan_turn', { title: 'Empty', goal: 'Nothing.', tasks: [] })).isError).toBe(true);
    expect(text(await call(client, 'add_tasks', { turn: 4, tasks: [work(dev.id, 'Checkout')] }))).toMatch(/no turn 4/i);
  });

  it('closes a turn when its last task closes and opens the next planned one', async () => {
    const { db, orchestrator, dev, sales, hana, sara, tools, queued } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout'), work(sales.id, 'Pricing')] });
    await call(boss, 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    expect(text(await call(await tools(hana), 'report', { task: 1, done: true, summary: 'Checkout ships.' }))).not.toContain('Turn 2');
    expect((await db.select().from(turns).where(eq(turns.number, 1)))[0]!.status).toBe('open');
    const last = await call(await tools(sara), 'report', { task: 2, done: true, summary: 'Copy is live.' });
    expect(last.isError).toBeFalsy();
    const [first, second] = await db.select().from(turns).orderBy(asc(turns.number));
    expect(first).toMatchObject({ status: 'closed' });
    expect(first!.closedAt).not.toBe(null);
    expect(second).toMatchObject({ status: 'open' });
    expect((await db.select().from(tasks).where(eq(tasks.title, 'Refund button')))[0]).toMatchObject({ status: 'open', assigneeAgentId: hana.id });
    expect((await queued(hana.id)).some(j => j.prompt.includes('Refund button'))).toBe(true);
    /* The orchestrator hears that the turn is over and which one runs now. */
    const told = (await queued(orchestrator.id)).map(j => j.prompt).join('\n');
    expect(told).toContain('Turn 1');
    expect(told).toContain('Turn 2');
  });

  it('keeps a turn open while work under its finished task is still open', async () => {
    const { db, ctx, orchestrator, dev, hana, tools } = await company();
    await call(await tools(orchestrator), 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    const [top] = await db.select().from(tasks);
    /* As an older Hornhoof left it: the top task done, a subtask under it still open. */
    const [under] = await db.insert(tasks).values({ companyId: top!.companyId, number: 2, turnId: top!.turnId, parentId: top!.id, departmentId: dev.id, title: 'Webhook', assigneeAgentId: hana.id }).returning();
    const [finished] = await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, top!.id)).returning();
    expect(await settle(ctx, finished!)).toBeNull();
    expect((await db.select().from(turns))[0]!.status).toBe('open');
    const [last] = await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, under!.id)).returning();
    expect(await settle(ctx, last!)).not.toBeNull();
    expect((await db.select().from(turns))[0]!.status).toBe('closed');
  });

  it('closes the turn when a person cancels its last open task', async () => {
    const { db, orchestrator, dev, ceoToken, app, tools } = await company();
    await call(await tools(orchestrator), 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    const [task] = await db.select().from(tasks);
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${task!.id}/cancel`, payload: { why: 'Not now.' }, headers: { cookie: `hh_session=${ceoToken}` } });
    expect(res.statusCode).toBe(200);
    expect((await db.select().from(turns))[0]!.status).toBe('closed');
  });

  it("keeps the people's own words with the turn they asked for", async () => {
    const { db, dev, say, message } = await company();
    await say('We need card payments, Stripe is fine.');
    const first = (await message('And Apple Pay too.')).tools!;
    await call(first, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')], words: 2 });
    const second = (await message('Also refunds later.')).tools!;
    await call(second, 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    const [one, two] = await db.select().from(turns).orderBy(asc(turns.number));
    expect(one!.messages.map(m => [m.by, m.text])).toEqual([
      ['Ivan', 'We need card payments, Stripe is fine.'],
      ['Ivan', 'And Apple Pay too.'],
    ]);
    expect(two!.messages.map(m => m.text)).toEqual(['Also refunds later.']);
    const third = (await message('Add a refund reason field.')).tools!;
    await call(third, 'add_tasks', { turn: 2, tasks: [work(dev.id, 'Refund reason')] });
    expect((await db.select().from(turns).where(eq(turns.number, 2)))[0]!.messages.map(m => m.text)).toEqual(['Also refunds later.', 'Add a refund reason field.']);
  });

  it('keeps only the message he answers unless he names more, and never words another turn kept', async () => {
    const { db, dev, say, message } = await company();
    await say('How are you?');
    const first = (await message('Make card payments.')).tools!;
    await call(first, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(first, 'plan_turn', { title: 'Again', goal: 'Same words.', tasks: [work(dev.id, 'Other')], words: 6 });
    const [one, two] = await db.select().from(turns).orderBy(asc(turns.number));
    expect(one!.messages.map(m => m.text)).toEqual(['Make card payments.']);
    expect(two!.messages.map(m => m.text)).toEqual(['How are you?']);
  });

  it('takes the words of the message he answers, not of one that came in meanwhile', async () => {
    const { db, dev, message } = await company();
    const card = (await message('Card payments.')).tools!;
    const later = await message('Refunds too.', 'queued');
    await call(card, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(await later.run(), 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    const [one, two] = await db.select().from(turns).orderBy(asc(turns.number));
    expect(one!.messages.map(m => m.text)).toEqual(['Card payments.']);
    expect(two!.messages.map(m => m.text)).toEqual(['Refunds too.']);
  });

  it("keeps no words with a turn he lays out when a task's news woke him", async () => {
    const { db, orchestrator, dev, tools, say } = await company();
    await say('Make card payments.');
    await call(await tools(orchestrator), 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    expect((await db.select().from(turns))[0]!.messages).toEqual([]);
  });

  it('skips a planned turn whose tasks were all cancelled and starts the one after it', async () => {
    const { db, orchestrator, dev, hana, tools } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(boss, 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    await call(boss, 'plan_turn', { title: 'Reports', goal: 'Monthly totals.', tasks: [work(dev.id, 'Totals')] });
    expect((await call(boss, 'cancel_task', { task: 2, why: 'Not needed.' })).isError).toBeFalsy();
    await call(await tools(hana), 'report', { task: 1, done: true, summary: 'Shipped.' });
    expect((await db.select({ n: turns.number, s: turns.status }).from(turns).orderBy(asc(turns.number))).map(t => [t.n, t.s])).toEqual([
      [1, 'closed'],
      [2, 'closed'],
      [3, 'open'],
    ]);
    expect((await db.select().from(tasks).where(eq(tasks.title, 'Totals')))[0]).toMatchObject({ status: 'open', assigneeAgentId: hana.id });
  });

  it('closes a turn from before, whose tasks are all done, when he lays out the next one', async () => {
    const { db, companyId, ceo, orchestrator, dev, hana, tools } = await company();
    const [old] = await db.insert(turns).values({ companyId, number: 1, goal: 'Old goal', status: 'open', startedBy: ceo.id, openedAt: new Date() }).returning();
    await db.insert(tasks).values({ companyId, number: 1, turnId: old!.id, title: 'Turn 1: Old goal', status: 'done', closedAt: new Date(), createdByPersonId: ceo.id });
    const res = await call(await tools(orchestrator), 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    expect(text(res)).toContain('started');
    expect((await db.select({ n: turns.number, s: turns.status }).from(turns).orderBy(asc(turns.number))).map(t => [t.n, t.s])).toEqual([
      [1, 'closed'],
      [2, 'open'],
    ]);
    expect((await db.select().from(tasks).where(eq(tasks.title, 'Checkout')))[0]!.assigneeAgentId).toBe(hana.id);
  });

  it('lists every open task for the tracker even after many newer closed ones', async () => {
    const { db, companyId, orchestrator, dev, tools, ceoToken, get } = await company();
    await call(await tools(orchestrator), 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await db.insert(tasks).values(Array.from({ length: 500 }, (_, i) => ({ companyId, number: i + 2, title: `Old ${i}`, status: 'done' as const, closedAt: new Date() })));
    const all = (await get(ceoToken, '/api/tasks?status=all')).json().tasks as { number: number }[];
    expect(all.some(t => t.number === 1)).toBe(true);
  });

  it("keeps a planned task away from its department's head until its turn starts", async () => {
    const { orchestrator, dev, hana, bruno, tools } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(boss, 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    const head = await tools(hana);
    expect(JSON.parse(text(await call(head, 'tasks', {}))).map((t: { number: number }) => t.number)).toEqual([1]);
    expect((await call(head, 'task', { task: 2 })).isError).toBe(true);
    const early = await call(head, 'create_task', { title: 'Refund API', brief: '', body: '', executor: bruno.id, parent: 2 });
    expect(early.isError).toBe(true);
  });

  it('renames a turn that has not closed', async () => {
    const { db, orchestrator, dev, tools } = await company();
    const client = await tools(orchestrator);
    await call(client, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    expect((await call(client, 'edit_turn', { turn: 1, title: 'Card payments', goal: 'Cards and Apple Pay.' })).isError).toBeFalsy();
    expect((await db.select().from(turns))[0]).toMatchObject({ title: 'Card payments', goal: 'Cards and Apple Pay.' });
  });

  it('lists the running and planned turns with their tasks', async () => {
    const { orchestrator, dev, tools } = await company();
    const client = await tools(orchestrator);
    await call(client, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(client, 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    const listed = JSON.parse(text(await call(client, 'turns', {})));
    expect(listed.map((t: { number: number; status: string; tasks: { number: number; status: string }[] }) => [t.number, t.status, t.tasks.map(x => [x.number, x.status])])).toEqual([
      [1, 'open', [[1, 'open']]],
      [2, 'planned', [[2, 'planned']]],
    ]);
  });

  it('sends a task whose department lost its head back to the orchestrator when its turn opens', async () => {
    const { db, orchestrator, dev, sales, sara, hana, tools, queued } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(boss, 'plan_turn', { title: 'Launch', goal: 'Tell people.', tasks: [work(sales.id, 'Announcement')] });
    await db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, sara.id));
    await call(await tools(hana), 'report', { task: 1, done: true, summary: 'Shipped.' });
    expect((await db.select().from(tasks).where(eq(tasks.title, 'Announcement')))[0]).toMatchObject({ status: 'blocked', assigneeAgentId: null });
    expect((await queued(orchestrator.id)).map(j => j.prompt).join('\n')).toMatch(/no head/i);
  });

  it('shows turns to everyone and the words behind them only to people with the whole company', async () => {
    const { app, orchestrator, dev, tools, message, ceoToken, get } = await company();
    await call((await message('We need card payments.')).tools!, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(await tools(orchestrator), 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    const mine = (await get(ceoToken, '/api/turns')).json().turns;
    expect(mine.map((t: { number: number; title: string; status: string }) => [t.number, t.title, t.status])).toEqual([
      [1, 'Payments', 'open'],
      [2, 'Refunds', 'planned'],
    ]);
    expect(mine[0]).toMatchObject({ goal: 'Card payments.', messages: [{ by: 'Ivan', text: 'We need card payments.' }], tasks: { total: 1, done: 0 } });
    const oleg = await invitePerson(app, ceoToken, { name: 'Oleg', email: 'oleg@acme.test', access: { departments: [dev.id] } });
    const theirs = (await get(oleg, '/api/turns')).json().turns;
    expect(theirs).toHaveLength(2);
    expect(theirs[0].messages).toEqual([]);
  });
});
