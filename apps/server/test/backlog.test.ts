import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, backlogItems, companies, departments, jobs, people, subscriptions, tasks, teams, turns } from '../src/db/schema.js';
import { invitePerson, listen, mcp, setUpCompany, testApp } from './helpers.js';

/* Development with Hana at its head and Bruno in it, Sales with Sara at its head, and Dora, who has Development only. */
async function company() {
  const { app, db } = await testApp();
  await listen(app);
  const ceoToken = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    ])
    .returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD', dev!.id);
  const sara = await hire('Sara', 'head', 'SAL-HEAD', sales!.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-BE', dev!.id);
  const dora = await invitePerson(app, ceoToken, { name: 'Dora', email: 'dora@acme.com', access: { departments: [dev!.id] } });
  let n = 0;
  /* Hornhoof's tools as a running turn of this agent sees them. */
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  const send = (token: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie: `hh_session=${token}` }, ...(payload ? { payload } : {}) });
  /* Puts items into a department's list as this person and returns their ids. */
  const put = async (token: string, departmentId: string, ...titles: string[]) => {
    const ids: string[] = [];
    for (const title of titles) {
      const res = await send(token, 'POST', `/api/departments/${departmentId}/backlog`, { title, text: `${title}: what to do.` });
      expect(res.statusCode).toBe(201);
      ids.push(res.json().item.id);
    }
    return ids;
  };
  const listed = async (token: string, departmentId: string) =>
    ((await send(token, 'GET', `/api/departments/${departmentId}/backlog`)).json().items as { id: string; title: string }[]).map(i => i.title);
  return { app, db, companyId, ceo: ceo!, ceoToken, dora, orchestrator: orchestrator!, dev: dev!, sales: sales!, hana, sara, bruno, tools, send, put, listed };
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Res;
const text = (r: Res) => r.content[0]!.text;
const names = async (c: Client) => (await c.listTools()).tools.map(t => t.name);

describe("a department's tasks and its list for later turns", () => {
  it("show a person with one department every department's tasks, and keep another one's list refused and as it was", async () => {
    const { db, ceoToken, dora, dev, sales, send, put, listed } = await company();
    const [salesItem] = await put(ceoToken, sales.id, 'Call the new leads');
    const picked = (await send(dora, 'GET', '/api/task-departments')).json();
    expect(picked).toEqual({ whole: false, departments: [{ id: dev.id, name: null, templateKey: 'development' }, { id: sales.id, name: null, templateKey: 'sales' }] });
    expect((await send(dora, 'GET', `/api/tasks?department=${dev.id}`)).statusCode).toBe(200);
    expect((await send(dora, 'GET', `/api/tasks?department=${sales.id}`)).statusCode).toBe(200);
    expect((await send(dora, 'GET', `/api/departments/${dev.id}/backlog`)).statusCode).toBe(200);

    const refused = [
      await send(dora, 'GET', '/api/tasks?department=none'),
      await send(dora, 'GET', `/api/departments/${sales.id}/backlog`),
      await send(dora, 'POST', `/api/departments/${sales.id}/backlog`, { title: 'Mine now', text: '' }),
      await send(dora, 'PUT', `/api/departments/${sales.id}/backlog/order`, { ids: [salesItem] }),
      await send(dora, 'DELETE', `/api/departments/${sales.id}/backlog/${salesItem}`),
      await send(dora, 'POST', `/api/departments/${sales.id}/backlog/schedule`, { ids: [salesItem] }),
      /* An item of another department named under one of hers is not hers either. */
      await send(dora, 'DELETE', `/api/departments/${dev.id}/backlog/${salesItem}`),
      await send(dora, 'POST', `/api/departments/${dev.id}/backlog/schedule`, { ids: [salesItem] }),
    ];
    expect(refused.map(r => [r.statusCode, r.json().error.reason])).toEqual([
      [403, 'not_your_department'],
      [403, 'not_your_department'],
      [403, 'not_your_department'],
      [403, 'not_your_department'],
      [403, 'not_your_department'],
      [403, 'not_your_department'],
      [404, 'backlog_unknown'],
      [409, 'backlog_changed'],
    ]);
    expect(await listed(ceoToken, sales.id)).toEqual(['Call the new leads']);
    expect(await db.select().from(tasks)).toEqual([]);
  });

  it('keep the order people give and put the chosen items into the next turn as its tasks, leaving the rest in the list', async () => {
    const { db, ceo, ceoToken, dora, orchestrator, hana, dev, send, put, listed } = await company();
    const [a, b, c] = await put(dora, dev.id, 'A', 'B', 'C');
    expect((await send(dora, 'PUT', `/api/departments/${dev.id}/backlog/order`, { ids: [c, a, b] })).statusCode).toBe(200);
    expect(await listed(ceoToken, dev.id)).toEqual(['C', 'A', 'B']);
    const stale = await send(dora, 'PUT', `/api/departments/${dev.id}/backlog/order`, { ids: [a, b] });
    expect([stale.statusCode, stale.json().error.reason]).toEqual([409, 'backlog_changed']);

    /* No turn runs, so the next turn is a new one and starts at once: its task goes to the head. */
    const first = await send(dora, 'POST', `/api/departments/${dev.id}/backlog/schedule`, { ids: [c] });
    expect(first.statusCode).toBe(200);
    expect(await listed(dora, dev.id)).toEqual(['A', 'B']);
    const [started] = await db.select().from(tasks);
    expect(started).toMatchObject({ title: 'C', body: 'C: what to do.', brief: 'C: what to do.', departmentId: dev.id, status: 'open', assigneeAgentId: hana.id, createdByAgentId: orchestrator.id });
    const [open] = await db.select().from(turns);
    expect(open).toMatchObject({ status: 'open', goal: 'C' });
    expect(first.json()).toEqual({ turn: { number: open!.number }, tasks: [{ id: started!.id, number: started!.number }] });

    /* A turn runs: the next turn is planned after it and holds the task until it starts. */
    await send(ceoToken, 'POST', `/api/departments/${dev.id}/backlog/schedule`, { ids: [b] });
    const planned = await db.select().from(turns).where(eq(turns.status, 'planned'));
    expect(planned).toMatchObject([{ number: open!.number + 1, goal: 'B' }]);
    /* A planned turn is there: the next item joins it. */
    await send(ceoToken, 'POST', `/api/departments/${dev.id}/backlog/schedule`, { ids: [a] });
    const later = await db.select().from(tasks).where(eq(tasks.turnId, planned[0]!.id)).orderBy(asc(tasks.number));
    expect(later.map(t => [t.title, t.status, t.createdByPersonId])).toEqual([['B', 'planned', ceo.id], ['A', 'planned', ceo.id]]);
    expect(await listed(dora, dev.id)).toEqual([]);
    expect(await db.select().from(backlogItems)).toEqual([]);
  });

  it('put the chosen items into the next turn of the mode the person picks, and refuse a turnkey turn with no turnkey team', async () => {
    const { db, companyId, ceoToken, dora, dev, bruno, send, put } = await company();
    const [a, b, c] = await put(dora, dev.id, 'A', 'B', 'C');
    const schedule = (ids: string[], mode?: string) => send(dora, 'POST', `/api/departments/${dev.id}/backlog/schedule`, { ids, ...(mode ? { mode } : {}) });
    const refused = await schedule([a!], 'turnkey');
    expect([refused.statusCode, refused.json().error.message]).toEqual([409, expect.stringMatching(/no turnkey team/)]);
    expect(await db.select().from(turns)).toEqual([]);

    const [team] = await db.insert(teams).values({ companyId, departmentId: dev.id, name: 'Lane', turnkey: true }).returning();
    await db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, bruno.id));
    expect((await schedule([a!], 'turnkey')).statusCode).toBe(200);
    /* The turnkey turn runs, so work in stages waits in a turn of its own, and later turnkey work in another one. */
    expect((await schedule([b!])).statusCode).toBe(200);
    expect((await send(ceoToken, 'POST', `/api/departments/${dev.id}/backlog/schedule`, { ids: [c], mode: 'turnkey' })).statusCode).toBe(200);
    const rows = await db.select({ n: turns.number, mode: turns.mode, status: turns.status, goal: turns.goal }).from(turns).orderBy(asc(turns.number));
    expect(rows.map(t => [t.n, t.mode, t.status, t.goal])).toEqual([[1, 'turnkey', 'open', 'A'], [2, 'echelons', 'planned', 'B'], [3, 'turnkey', 'planned', 'C']]);
  });

  it('are no work for agents: nobody is woken, heads and members neither list nor read an item, and only the orchestrator takes it into a turn', async () => {
    const { db, ceoToken, orchestrator, hana, bruno, dev, tools, put } = await company();
    const [item] = await put(ceoToken, dev.id, 'Write the price page');
    expect(await db.select().from(jobs)).toEqual([]);
    expect(await db.select().from(tasks)).toEqual([]);
    for (const agent of [hana, bruno]) {
      const client = await tools(agent);
      expect(await names(client)).not.toContain('backlog');
      expect(text(await call(client, 'tasks'))).not.toContain('Write the price page');
      expect(await call(client, 'task', { task: item })).toMatchObject({ isError: true });
    }

    const boss = await tools(orchestrator);
    const lists = JSON.parse(text(await call(boss, 'backlog')));
    expect(lists).toMatchObject([{ department: { id: dev.id }, items: [{ id: item, title: 'Write the price page', text: 'Write the price page: what to do.', by: 'Ivan' }] }]);
    const planned = await call(boss, 'plan_turn', { mode: 'echelons', title: 'Prices', goal: 'Show the prices.', tasks: [], backlog: [item] });
    expect(planned.isError).toBeFalsy();
    const [task] = await db.select().from(tasks);
    expect(task).toMatchObject({ title: 'Write the price page', status: 'open', assigneeAgentId: hana.id, createdByAgentId: orchestrator.id });
    expect(await db.select().from(backlogItems)).toEqual([]);
    expect(await call(boss, 'add_tasks', { turn: 1, tasks: [], backlog: [item] })).toMatchObject({ isError: true });
  });
});
