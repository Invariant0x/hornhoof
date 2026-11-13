import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, requests, subscriptions, tasks, turns } from '../src/db/schema.js';
import { as, echelonsTurn } from './helpers.js';
import { aclCompany, leaks, type AclCompany } from './agent-view-company.js';

type Viewer = keyof AclCompany['tokens'];
type Crew = keyof AclCompany['crew'];

/* Who gets each agent's own data; everyone else gets 403. Olga owns Development and sees every agent of it, on whoever's plan;
   in Sales she is no different from Ann. */
const SEEN: Record<Viewer, Crew[]> = {
  ceo: ['mine', 'other', 'away', 'far', 'head', 'owned', 'wide', 'deputy'],
  lisa: ['mine', 'other', 'away', 'far', 'head', 'owned', 'wide', 'deputy'],
  ann: ['mine'],
  bob: ['other', 'head'],
  olga: ['mine', 'other', 'head', 'owned'],
  wes: ['wide'],
};
const VIEWERS = Object.keys(SEEN) as Viewer[];

describe('one agent', () => {
  it('opens to the owner of its plan who reaches its department, to the owner of its department, and to the CEO and the delegate', async () => {
    const c = await aclCompany();
    const got: Record<string, Record<string, number>> = {};
    for (const viewer of VIEWERS) {
      got[viewer] = {};
      for (const [name, agent] of Object.entries(c.crew)) got[viewer]![name] = (await c.get(`/api/agents/${agent.id}`, c.tokens[viewer])).statusCode;
    }
    const wanted = Object.fromEntries(VIEWERS.map(v => [v, Object.fromEntries(Object.keys(c.crew).map(name => [name, SEEN[v].includes(name as Crew) ? 200 : 403]))]));
    expect(got).toEqual(wanted);
  });

  it('says why it is closed, the same way for each of the three closed cases', async () => {
    const c = await aclCompany();
    for (const hidden of [c.crew.other, c.crew.away, c.crew.far]) {
      const res = await c.get(`/api/agents/${hidden.id}`, c.tokens.ann);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject({ code: 'forbidden', reason: 'agent_hidden' });
      expect(leaks(res, [hidden])).toEqual([]);
    }
  });

  it('keeps its events, messages and controls behind the same answer', async () => {
    const c = await aclCompany();
    const routes: { method: 'GET' | 'PATCH' | 'DELETE' | 'POST'; url: string; payload?: object }[] = [
      { method: 'GET', url: '/events' },
      { method: 'GET', url: '/terminal' },
      { method: 'PATCH', url: '', payload: { name: 'Taken' } },
      { method: 'DELETE', url: '' },
      { method: 'POST', url: '/messages', payload: { text: 'hi' } },
      { method: 'POST', url: '/start', payload: {} },
      { method: 'POST', url: '/stop', payload: {} },
      { method: 'POST', url: '/reset', payload: {} },
    ];
    for (const { method, url, payload } of routes) {
      for (const hidden of [c.crew.other, c.crew.away, c.crew.far]) {
        const res = await c.app.inject({ method, url: `/api/agents/${hidden.id}${url}`, ...(payload ? { payload } : {}), ...as(c.tokens.ann) });
        expect(`${method} ${url} ${res.statusCode}`).toBe(`${method} ${url} 403`);
      }
    }
    expect((await c.db.select().from(agents).where(eq(agents.id, c.crew.other.id)))[0]).toMatchObject({ name: 'Otto', removedAt: null });
  });

  it('gives the owner of a plan the events of an own agent, and the CEO and the delegate any', async () => {
    const c = await aclCompany();
    expect((await c.get(`/api/agents/${c.crew.mine.id}/events`, c.tokens.ann)).statusCode).toBe(200);
    expect((await c.get(`/api/agents/${c.crew.mine.id}/events`, c.tokens.lisa)).statusCode).toBe(200);
    expect((await c.get(`/api/agents/${c.crew.far.id}/events`, c.tokens.ceo)).statusCode).toBe(200);
  });

  it('holds the orchestrator to the same rule, with no department to reach', async () => {
    const c = await aclCompany();
    const open = async (token: string) => (await c.get('/api/agents/orchestrator', token)).statusCode;
    expect([await open(c.tokens.ceo), await open(c.tokens.lisa)]).toEqual([200, 200]);
    expect([await open(c.tokens.ann), await open(c.tokens.wes)]).toEqual([403, 403]);
    await c.db.update(agents).set({ subscriptionId: c.plans.wes.id }).where(eq(agents.id, c.orchestrator.id));
    expect(await open(c.tokens.wes)).toBe(200);
    await c.db.update(agents).set({ subscriptionId: c.plans.ann.id }).where(eq(agents.id, c.orchestrator.id));
    expect(await open(c.tokens.ann)).toBe(403);
  });

  it('answers 404 for an agent of another company and for none at all', async () => {
    const c = await aclCompany();
    const [other] = await c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const [stranger] = await c.db.insert(people).values({ companyId: other!.id, name: 'Stranger', email: 'x@other.com', scopeKind: 'company', status: 'active' }).returning();
    const [plan] = await c.db.insert(subscriptions).values({ companyId: other!.id, provider: 'claude', kind: 'personal', label: 'P', status: 'ready', ownerPersonId: stranger!.id }).returning();
    const [theirs] = await c.db.insert(agents).values({ companyId: other!.id, kind: 'worker', name: 'Theirs', roleKey: 'DEV-BE', model: '', subscriptionId: plan!.id }).returning();
    for (const viewer of VIEWERS) {
      for (const id of [theirs!.id, '00000000-0000-4000-8000-000000000000']) {
        const res = await c.get(`/api/agents/${id}`, c.tokens[viewer]);
        expect(res.statusCode).toBe(404);
        expect(res.json().error.reason).toBe('agent_unknown');
      }
    }
  });

  it('closes at once when the plan moves, the access goes or the session ends', async () => {
    const c = await aclCompany();
    const url = `/api/agents/${c.crew.mine.id}`;
    expect((await c.get(url, c.tokens.ann)).statusCode).toBe(200);
    await c.db.update(agents).set({ subscriptionId: c.plans.bob.id }).where(eq(agents.id, c.crew.mine.id));
    expect((await c.get(url, c.tokens.ann)).statusCode).toBe(403);
    await c.db.update(agents).set({ subscriptionId: c.plans.ann.id }).where(eq(agents.id, c.crew.mine.id));
    expect((await c.get(url, c.tokens.ann)).statusCode).toBe(200);
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.ann}`, payload: { access: { departments: [c.sales.id] } }, ...as(c.tokens.ceo) })).statusCode).toBe(200);
    expect((await c.get(url, c.tokens.ann)).statusCode).toBe(403);
    expect((await c.get(`/api/agents/${c.crew.away.id}`, c.tokens.ann)).statusCode).toBe(200);
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, c.ids.ann));
    expect((await c.get(`/api/agents/${c.crew.away.id}`, c.tokens.ann)).statusCode).toBe(401);
  });

  it('stops counting a plan that was removed', async () => {
    const c = await aclCompany();
    await c.db.update(subscriptions).set({ removedAt: new Date() }).where(eq(subscriptions.id, c.plans.ann.id));
    expect((await c.get(`/api/agents/${c.crew.mine.id}`, c.tokens.ann)).statusCode).toBe(403);
  });

  it('stops the full view as soon as a delegate is one no more', async () => {
    const c = await aclCompany();
    expect((await c.get(`/api/agents/${c.crew.far.id}`, c.tokens.lisa)).statusCode).toBe(200);
    await c.app.inject({ method: 'PUT', url: `/api/people/${c.ids.lisa}/ceo-delegate`, payload: { isCeoDelegate: false }, ...as(c.tokens.ceo) });
    expect((await c.get(`/api/agents/${c.crew.far.id}`, c.tokens.lisa)).statusCode).toBe(403);
    expect((await c.get(`/api/agents/${c.crew.deputy.id}`, c.tokens.lisa)).statusCode).toBe(200);
  });
});

describe('the company map', () => {
  const namesOf = (org: { departments: { id: string; employees: { name: string }[] }[] }, id: string) => org.departments.find(d => d.id === id)!.employees.map(e => e.name).sort();

  it('lists every employee to everyone, and marks the ones each person opens', async () => {
    const c = await aclCompany();
    const org = async (viewer: Viewer) => (await c.get('/api/org', c.tokens[viewer])).json();
    const opened = (org: { departments: { employees: { id: string; opens?: boolean }[] }[] }) => org.departments.flatMap(d => d.employees.filter(e => e.opens).map(e => e.id)).sort();
    for (const viewer of VIEWERS) {
      const seen = await org(viewer);
      expect(namesOf(seen, c.dev.id)).toEqual(['Hana', 'Mina', 'Oleg', 'Otto']);
      expect(namesOf(seen, c.sales.id)).toEqual(['Awa', 'Fara', 'Lena', 'Wanda']);
      expect(opened(seen), viewer).toEqual(SEEN[viewer].map(crew => c.crew[crew].id).sort());
    }
  });

  it("shows everyone the company's counts, roles, lines and work, and the orchestrator's state without his plan or machine", async () => {
    const c = await aclCompany();
    const work = await c.work('Hidden work', c.crew.other);
    c.app.ctx.bus.publish(c.companyId, { type: 'pulse', from: { kind: 'agent', id: c.crew.head.id, departmentId: c.dev.id }, to: { kind: 'agent', id: c.crew.other.id, departmentId: c.dev.id } });
    c.app.ctx.bus.publish(c.companyId, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: c.dev.id } });
    const ann = (await c.get('/api/org', c.tokens.ann)).json(), ceo = (await c.get('/api/org', c.tokens.ceo)).json();
    type Card = Record<string, unknown> & { id: string; employees: { name: string; state: string; status: string; task: { id: string } | null }[] };
    const dept = (org: { departments: Card[] }, id: string) => org.departments.find(d => d.id === id)!;
    const shown = (d: ReturnType<typeof dept>) => [d.agents, d.roles, d.current, d.reworkAt, d.live, d.workLines, d.turnProgress, d.employees.map(e => [e.name, e.state, e.status, e.task?.id ?? null])];
    expect(ann.agents).toEqual(ceo.agents);
    expect([ann.live, ann.workLines]).toEqual([ceo.live, ceo.workLines]);
    expect(ann.live).toHaveLength(1);
    for (const id of [c.dev.id, c.sales.id]) expect(shown(dept(ann, id))).toEqual(shown(dept(ceo, id)));
    expect((dept(ann, c.dev.id).current as { id: string }).id).toBe(work.id);
    expect(dept(ann, c.dev.id).live).toHaveLength(1);
    expect(ann.orchestrator).toMatchObject({ id: c.orchestrator.id, opens: false, subscription: null, machine: null });
    expect(ceo.orchestrator).toMatchObject({ id: c.orchestrator.id, opens: true });
  });

  it('shows the work of an own agent in the department it works in', async () => {
    const c = await aclCompany();
    const own = await c.work('Own work', c.crew.mine);
    const org = (await c.get('/api/org', c.tokens.ann)).json();
    const dev = org.departments.find((d: { id: string }) => d.id === c.dev.id);
    expect(dev.employees.find((e: { id: string }) => e.id === c.crew.mine.id).task.id).toBe(own.id);
    expect(dev.current.id).toBe(own.id);
  });

  it('keeps the whole picture for the CEO and the delegate', async () => {
    const c = await aclCompany();
    await c.work('Hidden work', c.crew.other);
    for (const viewer of ['ceo', 'lisa'] as const) {
      const org = (await c.get('/api/org', c.tokens[viewer])).json();
      expect(org.orchestrator.id).toBe(c.orchestrator.id);
      expect(org.agents.total).toBe(9);
      expect(org.departments.find((d: { id: string }) => d.id === c.dev.id).agents.total).toBe(4);
    }
  });
});

describe('tasks', () => {
  it('opens every task of the company to everyone, and lets only whoever acts on its work change it', async () => {
    const c = await aclCompany();
    const own = await c.work('Own work', c.crew.mine);
    const hidden = await c.work('Hidden work', c.crew.other);
    const elsewhere = await c.work('Far work', c.crew.away, c.sales.id);
    /* Ann has a product of Development and gives no task to the department itself; Wes, with the whole company, does. */
    const given = await c.app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Given by Wes', department: c.dev.id }, ...as(c.tokens.wes) });
    expect(given.statusCode).toBe(201);
    const givenId = given.json().task.id as string;
    expect((await c.get(`/api/tasks/${own.id}`, c.tokens.ann)).statusCode).toBe(200);
    expect((await c.get(`/api/tasks/${givenId}`, c.tokens.wes)).statusCode).toBe(200);
    expect((await c.get(`/api/tasks/${hidden.id}`, c.tokens.wes)).statusCode).toBe(200);
    for (const task of [hidden, elsewhere]) {
      const res = await c.get(`/api/tasks/${task.id}`, c.tokens.ann);
      expect(res.statusCode).toBe(200);
      expect(res.json().task.title).toBe(task.title);
      for (const write of [{ url: `/api/tasks/${task.id}/comments`, payload: { text: 'hi' } }, { url: `/api/tasks/${task.id}/cancel`, payload: {} }]) {
        const refused = await c.app.inject({ method: 'POST', ...write, ...as(c.tokens.ann) });
        expect([refused.statusCode, refused.json().error.reason]).toEqual([403, 'task_not_yours']);
      }
    }
    expect((await c.db.select().from(tasks).where(eq(tasks.id, hidden.id)))[0]!.status).not.toBe('cancelled');
    expect((await c.get(`/api/tasks/${hidden.id}`, c.tokens.lisa)).statusCode).toBe(200);
    expect((await c.get(`/api/tasks/${elsewhere.id}`, c.tokens.ceo)).statusCode).toBe(200);
    expect((await c.get('/api/tasks/00000000-0000-4000-8000-000000000000', c.tokens.ann)).statusCode).toBe(404);
  });

  it('lists every task of every department to everyone, for every status', async () => {
    const c = await aclCompany();
    const own = await c.work('Own work', c.crew.mine);
    const hidden = await c.work('Hidden work', c.crew.other);
    const far = await c.work('Far work', c.crew.away, c.sales.id);
    for (const query of [`?department=${c.dev.id}`, `?status=all&department=${c.dev.id}`]) {
      const res = await c.get(`/api/tasks${query}`, c.tokens.ann);
      expect(res.statusCode).toBe(200);
      expect(res.json().tasks.map((t: { id: string }) => t.id)).toEqual([hidden.id, own.id]);
      expect(res.json().tasks.map((t: { assignee: { name: string } | null }) => t.assignee?.name)).toEqual(['Otto', 'Mina']);
    }
    const sales = await c.get(`/api/tasks?department=${c.sales.id}`, c.tokens.ann);
    expect(sales.json().tasks.map((t: { id: string }) => t.id)).toEqual([far.id]);
    expect((await c.get('/api/task-departments', c.tokens.ann)).json().departments.map((d: { id: string }) => d.id)).toEqual([c.dev.id, c.sales.id]);
    expect((await c.get(`/api/tasks?department=${c.dev.id}`, c.tokens.ceo)).json().tasks).toHaveLength(2);
  });

  it("names every employee on a task, and leaves out the words of agents the person does not open", async () => {
    const c = await aclCompany();
    const { createTask, comment, ask } = await import('../src/modules/tasks/engine.js');
    await echelonsTurn(c.db, c.companyId);
    const parent = await c.work('Hidden parent', c.crew.other);
    const { task } = await createTask(c.app.ctx, { agentId: c.crew.head.id }, { title: 'Shared work', brief: '', body: '', departmentId: c.dev.id, productId: c.product.id, assigneeAgentId: c.crew.mine.id, executor: true, resultKind: 'code', reviewerAgentId: c.crew.other.id, parentId: parent.id });
    await comment(c.app.ctx, { agentId: c.crew.other.id }, task.id, 'Otto was here');
    await comment(c.app.ctx, { agentId: c.crew.mine.id }, task.id, 'Mina says hello');
    await comment(c.app.ctx, { personId: c.ids.ann }, task.id, 'Ann says hello');
    await ask(c.app.ctx, c.crew.mine.id, task.id, { text: 'Mina asks', kind: 'question' });
    await c.db.insert(requests).values({ companyId: c.companyId, taskId: task.id, agentId: c.crew.other.id, kind: 'question', text: 'Otto asks', status: 'answered', answer: 'Yes', answeredAt: new Date() });
    const res = await c.get(`/api/tasks/${task.id}`, c.tokens.ann);
    expect(res.statusCode).toBe(200);
    const t = res.json().task;
    expect(res.body).not.toContain('Otto was here');
    expect(res.body).not.toContain('Otto asks');
    expect(t.parent.id).toBe(parent.id);
    expect(t).not.toHaveProperty('gates');
    expect(t.echelons.stages.find((step: { stage: string }) => step.stage === 'review').ownerAgentId).toBe(c.crew.other.id);
    expect(t.createdBy).toMatchObject({ kind: 'agent', id: c.crew.head.id, name: 'Hana' });
    expect(t.assignee.id).toBe(c.crew.mine.id);
    expect(t.executor.id).toBe(c.crew.mine.id);
    expect(t.log.map((l: { text: string }) => l.text)).toEqual(expect.arrayContaining(['Mina says hello', 'Ann says hello']));
    /* Otto's line says that he wrote, not what. */
    expect(t.log.find((l: { by: { id: string } | null; kind: string }) => l.kind === 'comment' && l.by?.id === c.crew.other.id)).toMatchObject({ by: { name: 'Otto' }, text: '', data: {} });
    expect(t.requests.map((r: { agent: { id: string } }) => r.agent.id)).toEqual([c.crew.mine.id]);
    const whole = await c.get(`/api/tasks/${task.id}`, c.tokens.lisa);
    expect(whole.json().task.echelons.stages.find((step: { stage: string }) => step.stage === 'review').ownerAgentId).toBe(c.crew.other.id);
    expect(whole.body).toContain('Otto was here');
    expect(whole.json().task.parent.id).toBe(parent.id);
  });

  it('lets the work of an agent be changed by whoever acts on that agent, not by the department alone, outside a department one owns', async () => {
    const c = await aclCompany();
    const hidden = await c.work('Hidden work', c.crew.other);
    const far = await c.work('Far work', c.crew.far, c.sales.id);
    const say = async (viewer: Viewer, id: string) => (await c.app.inject({ method: 'POST', url: `/api/tasks/${id}/comments`, payload: { text: 'hi' }, ...as(c.tokens[viewer]) })).statusCode;
    expect(await say('wes', hidden.id)).toBe(403);
    expect(await say('bob', hidden.id)).toBe(201);
    expect(await say('olga', hidden.id)).toBe(201);
    expect(await say('olga', far.id)).toBe(403);
  });
});

describe('the department tree', () => {
  it('draws every line of any department for everyone', async () => {
    const c = await aclCompany();
    await c.db.insert(turns).values({ companyId: c.companyId, number: 1, goal: 'Turn', status: 'open', openedAt: new Date(Date.now() - 3_600_000) });
    const [turn] = await c.db.select().from(turns);
    const own = await c.work('Own work', c.crew.mine);
    const hidden = await c.work('Hidden work', c.crew.other);
    await c.db.update(tasks).set({ turnId: turn!.id }).where(eq(tasks.id, own.id));
    await c.db.update(tasks).set({ turnId: turn!.id, after: [hidden.id] }).where(eq(tasks.id, own.id));
    await c.db.update(tasks).set({ turnId: turn!.id }).where(eq(tasks.id, hidden.id));
    const res = await c.get(`/api/departments/${c.dev.id}/tree`, c.tokens.ann);
    expect(res.statusCode).toBe(200);
    const { tree } = res.json();
    expect(tree.lines.map((l: { taskId: string }) => l.taskId).sort()).toEqual([own.id, hidden.id].sort());
    expect((await c.get(`/api/departments/${c.sales.id}/tree`, c.tokens.ann)).statusCode).toBe(200);
    expect((await c.get('/api/departments/00000000-0000-4000-8000-000000000000/tree', c.tokens.ann)).statusCode).toBe(404);
    const whole = (await c.get(`/api/departments/${c.dev.id}/tree`, c.tokens.lisa)).json().tree;
    expect(whole.lines.map((l: { taskId: string }) => l.taskId).sort()).toEqual([own.id, hidden.id].sort());
  });

  it('keeps the numbers of a whole department from anyone but the CEO, the delegate and its owner', async () => {
    const c = await aclCompany();
    await c.db.insert(turns).values({ companyId: c.companyId, number: 1, goal: 'Turn', status: 'open', openedAt: new Date() });
    for (const viewer of ['ann', 'wes'] as const) expect((await c.get(`/api/departments/${c.dev.id}/pipeline`, c.tokens[viewer])).statusCode).toBe(403);
    for (const viewer of ['ceo', 'lisa', 'olga'] as const) expect((await c.get(`/api/departments/${c.dev.id}/pipeline`, c.tokens[viewer])).statusCode).toBe(200);
    expect((await c.get(`/api/departments/${c.sales.id}/pipeline`, c.tokens.olga)).statusCode).toBe(403);
  });
});

describe('a department row', () => {
  it('stays out of the people of the other company', async () => {
    const c = await aclCompany();
    const [other] = await c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const [theirs] = await c.db.insert(departments).values({ companyId: other!.id, name: 'Theirs', roleCode: 'T' }).returning();
    expect((await c.get(`/api/departments/${theirs!.id}/tree`, c.tokens.lisa)).statusCode).toBe(404);
  });
});
