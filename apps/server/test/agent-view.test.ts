import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, subscriptions, tasks, turns } from '../src/db/schema.js';
import { as } from './helpers.js';
import { aclCompany, leaks, type AclCompany } from './agent-view-company.js';

type Viewer = keyof AclCompany['tokens'];
type Crew = keyof AclCompany['crew'];

/* Who gets each agent's own data; everyone else gets 403. Olga owns Development and is no different from Ann. */
const SEEN: Record<Viewer, Crew[]> = {
  ceo: ['mine', 'other', 'away', 'far', 'head', 'owned', 'wide', 'deputy'],
  lisa: ['mine', 'other', 'away', 'far', 'head', 'owned', 'wide', 'deputy'],
  ann: ['mine'],
  bob: ['other', 'head'],
  olga: ['owned'],
  wes: ['wide'],
};
const VIEWERS = Object.keys(SEEN) as Viewer[];

describe('one agent', () => {
  it('opens to the owner of its plan who reaches its department, and to the CEO and the delegate', async () => {
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

  it('lists only the agents the viewer sees, and every agent for the CEO and the delegate', async () => {
    const c = await aclCompany();
    const org = async (viewer: Viewer) => (await c.get('/api/org', c.tokens[viewer])).json();
    expect(namesOf(await org('ann'), c.dev.id)).toEqual(['Mina']);
    expect(namesOf(await org('ann'), c.sales.id)).toEqual([]);
    expect(namesOf(await org('olga'), c.dev.id)).toEqual(['Oleg']);
    expect(namesOf(await org('wes'), c.sales.id)).toEqual(['Wanda']);
    for (const viewer of ['ceo', 'lisa'] as const) {
      expect(namesOf(await org(viewer), c.dev.id)).toEqual(['Hana', 'Mina', 'Oleg', 'Otto']);
      expect(namesOf(await org(viewer), c.sales.id)).toEqual(['Awa', 'Fara', 'Lena', 'Wanda']);
    }
  });

  it('says nothing of other agents in its counts, roles, lines and work, nor of the orchestrator', async () => {
    const c = await aclCompany();
    const hiddenWork = await c.work('Hidden work', c.crew.other);
    c.app.ctx.bus.publish(c.companyId, { type: 'pulse', from: { kind: 'agent', id: c.crew.head.id, departmentId: c.dev.id }, to: { kind: 'agent', id: c.crew.other.id, departmentId: c.dev.id } });
    c.app.ctx.bus.publish(c.companyId, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: c.dev.id } });
    const res = await c.get('/api/org', c.tokens.ann);
    const org = res.json();
    expect(leaks(res, [c.crew.other, c.crew.away, c.crew.far, c.crew.head, c.crew.owned, c.crew.wide, c.crew.deputy, c.orchestrator])).toEqual([]);
    expect(res.body).not.toContain(hiddenWork.title);
    expect(org.orchestrator).toBeUndefined();
    expect(org.agents).toEqual({ total: 1, working: 0 });
    const dev = org.departments.find((d: { id: string }) => d.id === c.dev.id);
    expect(dev.agents).toEqual({ total: 1, working: 0 });
    expect(dev.roles.map((r: { id: string }) => r.id)).toEqual(['DEV-BE']);
    expect(dev.current).toBeNull();
    expect(dev.reworkAt).toBeNull();
    expect([org.live, org.workLines, dev.live, dev.workLines]).toEqual([[], [], [], []]);
    const sales = org.departments.find((d: { id: string }) => d.id === c.sales.id);
    expect(sales.agents).toEqual({ total: 0, working: 0 });
    expect(sales.roles).toEqual([]);
  });

  it('shows the work of an own agent in the department it works in', async () => {
    const c = await aclCompany();
    const own = await c.work('Own work', c.crew.mine);
    const org = (await c.get('/api/org', c.tokens.ann)).json();
    const dev = org.departments.find((d: { id: string }) => d.id === c.dev.id);
    expect(dev.employees[0].task.id).toBe(own.id);
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
  it('opens a task of a seen agent, or one the person gave, and closes the rest with 403', async () => {
    const c = await aclCompany();
    const own = await c.work('Own work', c.crew.mine);
    const hidden = await c.work('Hidden work', c.crew.other);
    const elsewhere = await c.work('Far work', c.crew.away, c.sales.id);
    const given = await c.app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Given by Ann', department: c.dev.id }, ...as(c.tokens.ann) });
    expect(given.statusCode).toBe(201);
    expect(leaks(given, [c.crew.head])).toEqual([]);
    const givenId = given.json().task.id as string;
    expect((await c.get(`/api/tasks/${own.id}`, c.tokens.ann)).statusCode).toBe(200);
    expect((await c.get(`/api/tasks/${givenId}`, c.tokens.ann)).statusCode).toBe(200);
    for (const task of [hidden, elsewhere]) {
      const res = await c.get(`/api/tasks/${task.id}`, c.tokens.ann);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.reason).toBe('task_hidden');
      expect(res.body).not.toContain(task.title);
      for (const write of [{ url: `/api/tasks/${task.id}/comments`, payload: { text: 'hi' } }, { url: `/api/tasks/${task.id}/cancel`, payload: {} }]) {
        expect((await c.app.inject({ method: 'POST', ...write, ...as(c.tokens.ann) })).statusCode).toBe(403);
      }
    }
    expect((await c.db.select().from(tasks).where(eq(tasks.id, hidden.id)))[0]!.status).not.toBe('cancelled');
    expect((await c.get(`/api/tasks/${hidden.id}`, c.tokens.lisa)).statusCode).toBe(200);
    expect((await c.get(`/api/tasks/${elsewhere.id}`, c.tokens.ceo)).statusCode).toBe(200);
    expect((await c.get('/api/tasks/00000000-0000-4000-8000-000000000000', c.tokens.ann)).statusCode).toBe(404);
  });

  it('lists only them, for every status and department', async () => {
    const c = await aclCompany();
    const own = await c.work('Own work', c.crew.mine);
    await c.work('Hidden work', c.crew.other);
    await c.work('Far work', c.crew.away, c.sales.id);
    for (const query of [`?department=${c.dev.id}`, `?status=all&department=${c.dev.id}`]) {
      const res = await c.get(`/api/tasks${query}`, c.tokens.ann);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('Hidden work');
      expect(res.body).not.toContain('Far work');
      expect(res.json().tasks.map((t: { id: string }) => t.id)).toEqual([own.id]);
      expect(leaks(res, [c.crew.other, c.crew.far, c.crew.head])).toEqual([]);
    }
    expect((await c.get(`/api/tasks?department=${c.sales.id}`, c.tokens.ann)).statusCode).toBe(403);
    expect((await c.get(`/api/tasks?department=${c.dev.id}`, c.tokens.ceo)).json().tasks).toHaveLength(2);
  });

  it('names no hidden agent on a seen task: not its stage owners, log, requests or files', async () => {
    const c = await aclCompany();
    const { createTask, comment, ask } = await import('../src/modules/tasks/engine.js');
    const parent = await c.work('Hidden parent', c.crew.other);
    const { task } = await createTask(c.app.ctx, { agentId: c.crew.head.id }, { title: 'Shared work', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.crew.mine.id, executor: true, resultKind: 'code', reviewerAgentId: c.crew.other.id, parentId: parent.id });
    await comment(c.app.ctx, { agentId: c.crew.other.id }, task.id, 'Otto was here');
    await comment(c.app.ctx, { agentId: c.crew.mine.id }, task.id, 'Mina says hello');
    await comment(c.app.ctx, { personId: c.ids.ann }, task.id, 'Ann says hello');
    await ask(c.app.ctx, c.crew.mine.id, task.id, { text: 'Mina asks', kind: 'question' });
    const res = await c.get(`/api/tasks/${task.id}`, c.tokens.ann);
    expect(res.statusCode).toBe(200);
    const t = res.json().task;
    expect(leaks(res, [c.crew.other, c.crew.head])).toEqual([]);
    expect(res.body).not.toContain('Hidden parent');
    expect(res.body).not.toContain('Otto was here');
    expect(t.parentId).toBeNull();
    expect(t.parent).toBeNull();
    expect(t).not.toHaveProperty('gates');
    expect(t.echelons.stages.find((step: { stage: string }) => step.stage === 'review').ownerAgentId).toBeNull();
    expect(t.createdBy).toBeNull();
    expect(t.assignee.id).toBe(c.crew.mine.id);
    expect(t.executor.id).toBe(c.crew.mine.id);
    expect(t.log.map((l: { text: string }) => l.text)).toEqual(expect.arrayContaining(['Mina says hello', 'Ann says hello']));
    expect(t.requests[0].agent.id).toBe(c.crew.mine.id);
    const whole = await c.get(`/api/tasks/${task.id}`, c.tokens.lisa);
    expect(whole.json().task.echelons.stages.find((step: { stage: string }) => step.stage === 'review').ownerAgentId).toBe(c.crew.other.id);
    expect(whole.body).toContain('Otto was here');
    expect(whole.json().task.parent.id).toBe(parent.id);
  });

  it('keeps to the agent it was given by the person who gave it, not by the department alone', async () => {
    const c = await aclCompany();
    const hidden = await c.work('Hidden work', c.crew.other);
    expect((await c.get(`/api/tasks/${hidden.id}`, c.tokens.olga)).statusCode).toBe(403);
    expect((await c.get(`/api/tasks/${hidden.id}`, c.tokens.wes)).statusCode).toBe(403);
    expect((await c.get(`/api/tasks/${hidden.id}`, c.tokens.bob)).statusCode).toBe(200);
  });
});

describe('the department tree', () => {
  it('draws only the lines of seen agents, and 403 for a department out of reach', async () => {
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
    expect(tree.lines.map((l: { taskId: string }) => l.taskId)).toEqual([own.id]);
    expect(leaks(res, [c.crew.other, c.crew.head])).toEqual([]);
    expect(res.body).not.toContain('Hidden work');
    const out = await c.get(`/api/departments/${c.sales.id}/tree`, c.tokens.ann);
    expect(out.statusCode).toBe(403);
    expect((await c.get('/api/departments/00000000-0000-4000-8000-000000000000/tree', c.tokens.ann)).statusCode).toBe(404);
    const whole = (await c.get(`/api/departments/${c.dev.id}/tree`, c.tokens.lisa)).json().tree;
    expect(whole.lines.map((l: { taskId: string }) => l.taskId).sort()).toEqual([own.id, hidden.id].sort());
  });

  it('keeps the numbers of a whole department from anyone but the CEO and the delegate', async () => {
    const c = await aclCompany();
    await c.db.insert(turns).values({ companyId: c.companyId, number: 1, goal: 'Turn', status: 'open', openedAt: new Date() });
    for (const viewer of ['ann', 'olga', 'wes'] as const) expect((await c.get(`/api/departments/${c.dev.id}/pipeline`, c.tokens[viewer])).statusCode).toBe(403);
    for (const viewer of ['ceo', 'lisa'] as const) expect((await c.get(`/api/departments/${c.dev.id}/pipeline`, c.tokens[viewer])).statusCode).toBe(200);
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
