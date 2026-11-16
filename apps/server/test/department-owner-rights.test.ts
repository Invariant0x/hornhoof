import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { canDecide, type Decider } from '../src/auth/decisions.js';
import { decisionOwner, type Candidate, type DecisionSubject } from '../src/auth/decision-owner.js';
import { agents, departments, jobs, subscriptions, tasks, teams } from '../src/db/schema.js';
import { company } from './department-owner-fixture.js';
import { as, invitePerson } from './helpers.js';

/* The person the CEO named owner of a department runs it as the CEO does there: its employees, its sub-units and products,
   its repository and its tasks, without asking the CEO. Outside it nothing changes. */

type C = Awaited<ReturnType<typeof company>>;
type Res = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Res;

/* Dana owns Development; Sam has Sales, which nobody owns. */
async function owned() {
  const c = await company();
  expect((await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana)).statusCode).toBe(200);
  return c;
}

const send = (c: C, token: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  c.app.inject({ method, url, ...(payload ? { payload } : {}), ...as(token) });
const line = (c: C, role: string, name: string) => ({ role, name, model: '', subscription: null, skills: c.app.ctx.templates.roles.get(role)!.skills.filter(s => s.on).map(s => s.id) });
const REPO = { url: 'https://github.com/acme/shop.git', branch: 'main' };

/* An employee of Development on a plan of Dana's own, whom she sees whether she owns the department or not. */
async function onHerPlan(c: C, name: string) {
  const [plan] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'claude', kind: 'personal', label: 'Dana', status: 'ready', ownerPersonId: c.ids.dana }).returning();
  const [agent] = await c.db.insert(agents).values({ companyId: c.companyId, kind: 'worker', name, roleKey: 'DEV-BE', departmentId: c.dev.id, model: '', subscriptionId: plan!.id }).returning();
  return agent!;
}

/* A task Dana gave her department herself, so she sees it whoever does it. */
async function herTask(c: C, title: string) {
  const res = await send(c, c.danaToken, 'POST', '/api/tasks', { title, department: c.dev.id });
  expect(res.statusCode).toBe(201);
  return res.json().task.id as string;
}

describe('a department owner on the screen', () => {
  it('makes, changes and removes sub-units of their own department, and of no other', async () => {
    const c = await owned();
    const made = await send(c, c.danaToken, 'POST', `/api/departments/${c.dev.id}/teams`, { name: 'Mobile' });
    expect(made.statusCode).toBe(201);
    const team = made.json().team.id as string;
    expect((await send(c, c.danaToken, 'PATCH', `/api/departments/${c.dev.id}/teams/${team}`, { name: 'Apps', urgentOnly: true })).statusCode).toBe(200);
    expect((await send(c, c.danaToken, 'DELETE', `/api/departments/${c.dev.id}/teams/${team}`)).statusCode).toBe(204);
    expect(await c.db.select().from(teams).where(eq(teams.departmentId, c.dev.id))).toEqual([]);
    expect((await send(c, c.danaToken, 'POST', `/api/departments/${c.sales.id}/teams`, { name: 'Field' })).statusCode).toBe(403);
  });

  it('connects and disconnects the repository of their department and of its product', async () => {
    const c = await owned();
    expect((await send(c, c.danaToken, 'PUT', `/api/departments/${c.dev.id}/repository`, REPO)).statusCode).toBe(200);
    expect((await send(c, c.danaToken, 'PUT', `/api/departments/${c.product.id}/repository`, REPO)).statusCode).toBe(200);
    expect((await send(c, c.danaToken, 'DELETE', `/api/departments/${c.product.id}/repository`)).statusCode).toBe(204);
    expect((await send(c, c.danaToken, 'PUT', `/api/departments/${c.sales.id}/repository`, REPO)).statusCode).toBe(403);
  });

  it('reads the roster and hires into their department without the CEO, and into no other', async () => {
    const c = await owned();
    expect((await send(c, c.danaToken, 'GET', `/api/departments/${c.dev.id}/roster`)).statusCode).toBe(200);
    const hired = await send(c, c.danaToken, 'POST', `/api/departments/${c.dev.id}/staff`, { people: [line(c, 'DEV-BE', 'Ira')] });
    expect(hired.statusCode).toBe(201);
    expect(await c.db.select({ name: agents.name }).from(agents).where(and(eq(agents.departmentId, c.dev.id), eq(agents.name, 'Ira')))).toEqual([{ name: 'Ira' }]);
    expect((await send(c, c.danaToken, 'POST', `/api/departments/${c.sales.id}/staff`, { people: [line(c, 'SAL-AE', 'Ola')] })).statusCode).toBe(403);
    /* Someone with the whole company who is neither the CEO nor an owner still leaves hiring to them. */
    expect((await send(c, c.wholeToken, 'POST', `/api/departments/${c.dev.id}/staff`, { people: [line(c, 'DEV-BE', 'Max')] })).statusCode).toBe(403);
  });

  it('adds products and sub-units to their department, but makes or removes no department and writes no company brief', async () => {
    const c = await owned();
    const built = await send(c, c.danaToken, 'POST', '/api/departments/build', { items: [{ department: c.dev.id, products: ['App'], teams: ['Web'] }] });
    expect(built.statusCode).toBe(201);
    expect((await c.db.select({ name: departments.name }).from(departments).where(eq(departments.parentId, c.dev.id))).map(d => d.name).sort()).toEqual(['App', 'Shop']);
    expect((await c.db.select({ name: teams.name }).from(teams).where(eq(teams.departmentId, c.dev.id))).map(t => t.name)).toEqual(['Web']);
    for (const payload of [
      { items: [{ template: 'marketing' }] },
      { items: [{ department: c.dev.id, remove: true }] },
      { items: [{ department: c.sales.id, teams: ['Field'] }] },
      { brief: 'We sell shoes.', items: [{ department: c.dev.id, teams: ['Ops'] }] },
    ]) expect((await send(c, c.danaToken, 'POST', '/api/departments/build', payload)).statusCode, JSON.stringify(payload)).toBe(403);
  });

  it('removes a product of their own department, and of no other', async () => {
    const c = await owned();
    const [stand] = await c.db.insert(departments).values({ companyId: c.companyId, name: 'Stand', roleCode: 'SAL', parentId: c.sales.id, position: 4 }).returning();
    expect((await send(c, c.danaToken, 'POST', '/api/departments/build', { items: [{ department: stand!.id, remove: true }] })).statusCode).toBe(403);
    const removed = await send(c, c.danaToken, 'POST', '/api/departments/build', { items: [{ department: c.product.id, remove: true }] });
    expect(removed.statusCode, removed.body).toBe(201);
    expect(await c.db.select().from(departments).where(eq(departments.parentId, c.dev.id))).toEqual([]);
    expect(await c.db.select({ id: departments.id }).from(departments).where(eq(departments.id, stand!.id))).toEqual([{ id: stand!.id }]);
  });

  it('removes an employee of their department, which someone who sees the whole company but has no department may not', async () => {
    const c = await company();
    const ira = await onHerPlan(c, 'Ira');
    expect((await send(c, c.wholeToken, 'DELETE', `/api/agents/${ira.id}`)).statusCode).toBe(403);
    expect((await send(c, c.danaToken, 'GET', `/api/agents/${ira.id}`)).json().canRemove).toBe(true);
    expect((await send(c, c.danaToken, 'DELETE', `/api/agents/${ira.id}`)).statusCode).toBe(204);
    expect((await c.db.select({ removedAt: agents.removedAt }).from(agents).where(eq(agents.id, ira.id)))[0]!.removedAt).not.toBeNull();
  });

  it('stops a running turn of an employee of their department', async () => {
    const c = await company();
    const ira = await onHerPlan(c, 'Ira');
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: ira.subscriptionId!, agentId: ira.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running', startedAt: new Date() }).returning();
    expect((await send(c, c.wholeToken, 'POST', `/api/jobs/${job!.id}/cancel`)).statusCode).toBe(403);
    expect((await send(c, c.danaToken, 'POST', `/api/jobs/${job!.id}/cancel`)).statusCode).toBe(202);
    /* The orchestrator is in no department: its turn stays the whole company's to stop. */
    const [own] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.orchestrator.subscriptionId!, agentId: c.orchestrator.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running', startedAt: new Date() }).returning();
    expect((await send(c, c.danaToken, 'POST', `/api/jobs/${own!.id}/cancel`)).json().error.reason).toBe('company_scope_only');
  });

  it('pauses, resumes and makes urgent the work of their department', async () => {
    const c = await company();
    const id = await herTask(c, 'Landing page');
    expect((await send(c, c.wholeToken, 'PUT', `/api/tasks/${id}/paused`, { paused: true, reason: 'Wait for the brand.' })).statusCode).toBe(403);
    expect((await send(c, c.wholeToken, 'PUT', `/api/tasks/${id}/urgent`, { urgent: true })).statusCode).toBe(403);
    expect((await send(c, c.danaToken, 'GET', `/api/tasks/${id}`)).json().task.mayPause).toBe(true);
    expect((await send(c, c.danaToken, 'PUT', `/api/tasks/${id}/paused`, { paused: true, reason: 'Wait for the brand.' })).statusCode).toBe(200);
    expect((await send(c, c.danaToken, 'PUT', `/api/tasks/${id}/paused`, { paused: false })).statusCode).toBe(200);
    expect((await send(c, c.danaToken, 'PUT', `/api/tasks/${id}/urgent`, { urgent: true })).statusCode).toBe(200);
    expect((await c.db.select({ urgent: tasks.urgent }).from(tasks).where(eq(tasks.id, id)))[0]!.urgent).toBe(true);
    const urgent = await send(c, c.danaToken, 'POST', '/api/tasks', { title: 'Hotfix', department: c.dev.id, urgent: true });
    expect(urgent.statusCode).toBe(201);
  });
});

describe('what a department owner sees', () => {
  /* Bruno works in Development on the CEO's plan, Sid in Sales. */
  it('opens, changes and removes every employee of their department on whoever\'s plan, as the CEO does', async () => {
    const c = await company();
    const card = () => send(c, c.danaToken, 'GET', `/api/agents/${c.worker.id}`);
    expect((await send(c, c.wholeToken, 'GET', `/api/agents/${c.worker.id}`)).json().error.reason).toBe('agent_hidden');
    expect((await card()).json()).toMatchObject({ name: 'Bruno', canEdit: true, canRemove: true });
    expect((await send(c, c.danaToken, 'PATCH', `/api/agents/${c.worker.id}`, { name: 'Bob' })).json().name).toBe('Bob');
    expect((await send(c, c.danaToken, 'GET', `/api/tasks/${c.task.id}`)).json().task.assignee).toMatchObject({ id: c.worker.id });
    const [ira] = await c.db.insert(agents).values({ companyId: c.companyId, kind: 'worker', name: 'Ira', roleKey: 'DEV-BE', departmentId: c.dev.id, productId: c.product.id, model: '', subscriptionId: c.worker.subscriptionId }).returning();
    expect((await send(c, c.danaToken, 'DELETE', `/api/agents/${ira!.id}`)).statusCode).toBe(204);
    /* The numbers of the whole department open to her; there are none before a turn. */
    expect((await send(c, c.danaToken, 'GET', `/api/departments/${c.dev.id}/pipeline`)).json().error.reason).toBe('turn_unknown');
    expect((await send(c, c.danaToken, 'GET', `/api/agents/${c.seller.id}`)).json().error.reason).toBe('agent_hidden');
    /* Another department's numbers are the company's, which everyone reads. */
    expect((await send(c, c.danaToken, 'GET', `/api/departments/${c.sales.id}/pipeline`)).json().error.reason).toBe('turn_unknown');
  });

  it('sees the work of an employee placed in a sub-unit of their department itself', async () => {
    const c = await owned();
    const [kai] = await c.db.insert(agents).values({ companyId: c.companyId, kind: 'worker', name: 'Kai', roleKey: 'DEV-BE', departmentId: c.product.id, model: '', subscriptionId: c.worker.subscriptionId }).returning();
    await c.db.update(tasks).set({ assigneeAgentId: kai!.id }).where(eq(tasks.id, c.task.id));
    expect((await send(c, c.danaToken, 'GET', `/api/agents/${kai!.id}`)).statusCode).toBe(200);
    expect((await send(c, c.danaToken, 'GET', `/api/tasks/${c.task.id}`)).json().task.assignee).toMatchObject({ id: kai!.id, name: 'Kai' });
  });

  it('reads nothing of the key of a plan that is not theirs', async () => {
    const c = await owned();
    await c.db.insert(teams).values({ id: '00000000-0000-4000-8000-000000007a2f', companyId: c.companyId, departmentId: c.dev.id, name: 'Web' });
    await c.db.update(subscriptions).set({ last4: '7zQw' }).where(eq(subscriptions.id, c.worker.subscriptionId!));
    expect((await send(c, c.ceoToken, 'GET', `/api/agents/${c.worker.id}`)).json().subscription.last4).toBe('7zQw');
    const card = (await send(c, c.danaToken, 'GET', `/api/agents/${c.worker.id}`)).json();
    expect(card.subscription).toMatchObject({ id: c.worker.subscriptionId, last4: null });
    expect(JSON.stringify(card)).not.toContain('7zQw');
  });

  it('watches the terminal of an employee on another\'s plan without typing into it', async () => {
    const c = await owned();
    const events = await send(c, c.danaToken, 'GET', `/api/agents/${c.worker.id}/events?after=0`);
    expect(events.statusCode).toBe(200);
    expect(events.json().state.canType).toBe(false);
  });
});

describe('a department owner\'s decisions', () => {
  const dev = 'd0000000-0000-4000-8000-000000000001';
  const owns = { whole: false, departments: new Set([dev]), teams: new Set<string>(), owns: new Set([dev]) };
  const dana: Decider & { id: string } = { id: 'dana', companyId: 'c', status: 'active', scopeKind: 'listed', isOwner: false, isCeoDelegate: false };
  const people: Candidate[] = [
    { id: 'ceo', status: 'active', isOwner: true, access: { whole: true, departments: new Set(), teams: new Set() } },
    { id: 'dana', status: 'active', isOwner: false, access: owns },
  ];
  const asked = (topic: DecisionSubject extends infer S ? S extends { topic: infer T } ? T : never : never): DecisionSubject => ({ source: 'request', kind: 'question', topic, spot: { departmentId: dev } });

  it('takes what is asked about the repository and the releases of their department', () => {
    for (const topic of ['repositories', 'release', 'task', 'employee'] as const) {
      expect(canDecide(asked(topic), dana, owns, 'c'), topic).toBe(true);
      expect(decisionOwner(asked(topic), people), topic).toBe('dana');
    }
  });

  it('leaves what only the whole company decides to the CEO', () => {
    for (const topic of ['people', 'access', 'subscriptions', 'machines', 'public_link', 'updates'] as const) {
      expect(canDecide(asked(topic), dana, owns, 'c'), topic).toBe(false);
      expect(decisionOwner(asked(topic), people), topic).toBe('ceo');
    }
  });
});

describe('the orchestrator for a department owner', () => {
  it('hires, sets the repository and changes sub-units of the owner\'s department in a turn that answers them', async () => {
    const c = await owned();
    const tools = await c.tools(c.orchestrator, c.ids.dana);
    const hired = await call(tools, 'hire', { department: c.dev.id, people: [{ role: 'DEV-BE', name: 'Ira' }] });
    expect(hired.isError, hired.content[0]!.text).toBeFalsy();
    const repo = await call(tools, 'set_repository', { department: c.dev.id, ...REPO });
    expect(repo.isError, repo.content[0]!.text).toBeFalsy();
    const [team] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Web' }).returning();
    const urgent = await call(tools, 'set_team_urgent_only', { department: c.dev.id, team: team!.id, urgentOnly: true });
    expect(urgent.isError, urgent.content[0]!.text).toBeFalsy();
    const built = await call(tools, 'build_structure', { items: [{ department: c.dev.id, teams: ['Mobile'] }] });
    expect(built.isError, built.content[0]!.text).toBeFalsy();
    const hurried = await call(tools, 'set_urgent', { task: c.task.number, urgent: true });
    expect(hurried.isError, hurried.content[0]!.text).toBeFalsy();
    expect((await c.db.select({ urgent: tasks.urgent }).from(tasks).where(eq(tasks.id, c.task.id)))[0]!.urgent).toBe(true);
  });

  it('goes as the company owner for a person of another department, and for a person given no department', async () => {
    const c = await owned();
    const hers = await c.tools(c.orchestrator, c.ids.dana);
    expect((await call(hers, 'hire', { department: c.sales.id, people: [{ role: 'SAL-AE', name: 'Ola' }] })).isError).toBeFalsy();
    const wes = await c.tools(c.orchestrator, c.ids.wes);
    expect((await call(wes, 'set_urgent', { task: c.task.number, urgent: true })).isError).toBeFalsy();
    expect(await c.db.select().from(agents).where(and(eq(agents.name, 'Ola'), isNull(agents.removedAt)))).toHaveLength(1);
  });
});

describe('everyone given a department, without being named its owner', () => {
  /* Sam has Sales, which nobody is named owner of; Sid works there on the CEO's plan. */
  it('opens, changes and removes every employee of it on whoever\'s plan, and runs its sub-units and repository', async () => {
    const c = await company();
    expect((await send(c, c.samToken, 'GET', `/api/agents/${c.seller.id}`)).json()).toMatchObject({ name: 'Sid', canEdit: true, canRemove: true });
    expect((await send(c, c.samToken, 'PATCH', `/api/agents/${c.seller.id}`, { name: 'Sidney' })).json().name).toBe('Sidney');
    expect((await send(c, c.samToken, 'POST', `/api/departments/${c.sales.id}/teams`, { name: 'Field' })).statusCode).toBe(201);
    expect((await send(c, c.samToken, 'PUT', `/api/departments/${c.sales.id}/repository`, REPO)).statusCode).toBe(200);
    expect((await send(c, c.samToken, 'GET', `/api/agents/${c.worker.id}`)).json().error.reason).toBe('agent_hidden');
    expect((await send(c, c.samToken, 'POST', `/api/departments/${c.dev.id}/teams`, { name: 'Web' })).statusCode).toBe(403);
  });

  it('runs it beside a named owner and anyone else given it', async () => {
    const c = await company();
    const ola = await invitePerson(c.app, c.ceoToken, { name: 'Ola', email: 'ola@acme.com', access: { departments: [c.sales.id] } });
    expect((await c.setOwner(c.ceoToken, c.sales.id, c.ids.sam)).statusCode).toBe(200);
    for (const token of [c.samToken, ola]) expect((await send(c, token, 'GET', `/api/agents/${c.seller.id}`)).json()).toMatchObject({ name: 'Sid', canRemove: true });
  });
});
