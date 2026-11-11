import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { canDecide, type Decider } from '../src/auth/decisions.js';
import { decisionOwner, type Candidate, type DecisionSubject } from '../src/auth/decision-owner.js';
import { agents, departments, jobs, subscriptions, tasks, teams } from '../src/db/schema.js';
import { company } from './department-owner-fixture.js';
import { as } from './helpers.js';

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
    expect((await send(c, c.samToken, 'POST', `/api/departments/${c.sales.id}/teams`, { name: 'Field' })).statusCode).toBe(403);
  });

  it('connects and disconnects the repository of their department and of its product', async () => {
    const c = await owned();
    expect((await send(c, c.danaToken, 'PUT', `/api/departments/${c.dev.id}/repository`, REPO)).statusCode).toBe(200);
    expect((await send(c, c.danaToken, 'PUT', `/api/departments/${c.product.id}/repository`, REPO)).statusCode).toBe(200);
    expect((await send(c, c.danaToken, 'DELETE', `/api/departments/${c.product.id}/repository`)).statusCode).toBe(204);
    expect((await send(c, c.danaToken, 'PUT', `/api/departments/${c.sales.id}/repository`, REPO)).statusCode).toBe(403);
    expect((await send(c, c.samToken, 'PUT', `/api/departments/${c.sales.id}/repository`, REPO)).statusCode).toBe(403);
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

  it('removes an employee of their department, which someone with only access to it may not', async () => {
    const c = await company();
    const ira = await onHerPlan(c, 'Ira');
    expect((await send(c, c.danaToken, 'GET', `/api/agents/${ira.id}`)).json().canRemove).toBe(false);
    expect((await send(c, c.danaToken, 'DELETE', `/api/agents/${ira.id}`)).statusCode).toBe(403);
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    expect((await send(c, c.danaToken, 'GET', `/api/agents/${ira.id}`)).json().canRemove).toBe(true);
    expect((await send(c, c.danaToken, 'DELETE', `/api/agents/${ira.id}`)).statusCode).toBe(204);
    expect((await c.db.select({ removedAt: agents.removedAt }).from(agents).where(eq(agents.id, ira.id)))[0]!.removedAt).not.toBeNull();
  });

  it('stops a running turn of an employee of their department', async () => {
    const c = await company();
    const ira = await onHerPlan(c, 'Ira');
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: ira.subscriptionId!, agentId: ira.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running', startedAt: new Date() }).returning();
    expect((await send(c, c.danaToken, 'POST', `/api/jobs/${job!.id}/cancel`)).statusCode).toBe(403);
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    expect((await send(c, c.danaToken, 'POST', `/api/jobs/${job!.id}/cancel`)).statusCode).toBe(202);
    /* The orchestrator is in no department: its turn stays the whole company's to stop. */
    const [own] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.orchestrator.subscriptionId!, agentId: c.orchestrator.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running', startedAt: new Date() }).returning();
    expect((await send(c, c.danaToken, 'POST', `/api/jobs/${own!.id}/cancel`)).json().error.reason).toBe('company_scope_only');
  });

  it('pauses, resumes and makes urgent the work of their department', async () => {
    const c = await company();
    const id = await herTask(c, 'Landing page');
    expect((await send(c, c.danaToken, 'GET', `/api/tasks/${id}`)).json().task.mayPause).toBe(false);
    expect((await send(c, c.danaToken, 'PUT', `/api/tasks/${id}/paused`, { paused: true, reason: 'Wait for the brand.' })).statusCode).toBe(403);
    expect((await send(c, c.danaToken, 'PUT', `/api/tasks/${id}/urgent`, { urgent: true })).statusCode).toBe(403);
    await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
    expect((await send(c, c.danaToken, 'GET', `/api/tasks/${id}`)).json().task.mayPause).toBe(true);
    expect((await send(c, c.danaToken, 'PUT', `/api/tasks/${id}/paused`, { paused: true, reason: 'Wait for the brand.' })).statusCode).toBe(200);
    expect((await send(c, c.danaToken, 'PUT', `/api/tasks/${id}/paused`, { paused: false })).statusCode).toBe(200);
    expect((await send(c, c.danaToken, 'PUT', `/api/tasks/${id}/urgent`, { urgent: true })).statusCode).toBe(200);
    expect((await c.db.select({ urgent: tasks.urgent }).from(tasks).where(eq(tasks.id, id)))[0]!.urgent).toBe(true);
    const urgent = await send(c, c.danaToken, 'POST', '/api/tasks', { title: 'Hotfix', department: c.dev.id, urgent: true });
    expect(urgent.statusCode).toBe(201);
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

  it('refuses the same for another department, and for a person who owns none', async () => {
    const c = await owned();
    const hers = await c.tools(c.orchestrator, c.ids.dana);
    expect((await call(hers, 'set_repository', { department: c.sales.id, ...REPO })).isError).toBe(true);
    expect((await call(hers, 'hire', { department: c.sales.id, people: [{ role: 'SAL-AE', name: 'Ola' }] })).isError).toBe(true);
    expect((await call(hers, 'set_urgent', { task: c.salesTask.number, urgent: true })).isError).toBe(true);
    const wes = await c.tools(c.orchestrator, c.ids.wes);
    expect((await call(wes, 'set_repository', { department: c.dev.id, ...REPO })).isError).toBe(true);
    expect((await call(wes, 'set_urgent', { task: c.task.number, urgent: true })).isError).toBe(true);
    const sams = await c.tools(c.orchestrator, c.ids.sam);
    expect((await call(sams, 'set_repository', { department: c.sales.id, ...REPO })).isError).toBe(true);
    expect((await call(sams, 'hire', { department: c.sales.id, people: [{ role: 'SAL-AE', name: 'Ola' }] })).isError).toBe(true);
    expect(await c.db.select().from(agents).where(and(eq(agents.name, 'Ola'), isNull(agents.removedAt)))).toEqual([]);
  });
});
