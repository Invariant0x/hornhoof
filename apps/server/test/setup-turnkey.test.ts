import { COMPANY_TEMPLATE_KEYS, COMPANY_TEMPLATES, TEMPLATE_KEYS } from '@hornhoof/protocol';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agentChanges, agents, departments, subscriptions } from '../src/db/schema.js';
import { modelOnPlan } from '../src/modules/agents/role-model.js';
import { as, connectNode, listen, sessionFrom, SETUP, testApp, until } from './helpers.js';

const LATER = { ...SETUP, orchestrator: { mode: 'later' } };
const MAC = { machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };
const codeOf = (command: string) => command.split('--join ')[1]!;

/* The project template: Operations with its four, Development with a head, two developers and a reviewer. */
const PROJECT = ['DEV-ENG', 'DEV-ENG', 'DEV-HEAD', 'DEV-REV', 'OPS-BUGS', 'OPS-HEAD', 'OPS-PROGRAM', 'OPS-WATCH'];

async function setUp(app: FastifyInstance, payload: object) {
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload });
  expect(res.statusCode).toBe(201);
  return { ceo: sessionFrom(res), command: res.json().command as string | undefined };
}

const staffOf = (app: FastifyInstance) => app.ctx.db.select().from(agents).where(and(ne(agents.kind, 'orchestrator'), isNull(agents.removedAt)));
const plans = (app: FastifyInstance) => app.ctx.db.select().from(subscriptions).orderBy(asc(subscriptions.createdAt));
const orchestrator = async (app: FastifyInstance) => (await app.ctx.db.select().from(agents).where(eq(agents.kind, 'orchestrator')))[0]!;
const addKey = (app: FastifyInstance, ceo: string, target: object, apiKey = 'sk-ant-api03-later-key-4321') =>
  app.inject({ method: 'POST', url: '/api/subscriptions', payload: { kind: 'api_key', provider: 'anthropic_api', label: 'Company key', apiKey, target }, ...as(ceo) });

describe('POST /api/setup staffs the template', () => {
  it('hires every employee of the template, with its role, skills and the model its tier asks for on the key', async () => {
    const { app, db } = await testApp();
    await setUp(app, { ...SETUP, template: 'project' });
    const [key] = await plans(app);
    const staff = await staffOf(app);
    expect(staff.map(a => a.roleKey).sort()).toEqual(PROJECT);
    const dev = (await db.select().from(departments).where(eq(departments.templateKey, 'development')))[0]!;
    expect(staff.filter(a => a.departmentId === dev.id).map(a => a.name).sort()).toEqual(['Code reviewer', 'Developer 1', 'Developer 2', 'Head of development']);
    for (const employee of staff) {
      const role = app.ctx.templates.roles.get(employee.roleKey!)!;
      expect(employee.subscriptionId, employee.name).toBe(key!.id);
      expect(employee.skills, employee.name).toEqual(role.skills.filter(s => s.on).map(s => s.id));
      expect(employee.model, employee.name).toBe(modelOnPlan(role.tier, key!));
    }
  });

  it('hires the template as many as it says in each department, and Operations no one twice', async () => {
    const { app, db } = await testApp();
    await setUp(app, { ...SETUP, template: 'corporation' });
    const staff = await staffOf(app);
    const ops = (await db.select().from(departments).where(eq(departments.templateKey, 'operations')))[0]!;
    expect(staff.filter(a => a.departmentId === ops.id).map(a => a.roleKey).sort()).toEqual(['OPS-BUGS', 'OPS-FIX', 'OPS-HEAD', 'OPS-INTEG', 'OPS-PROGRAM', 'OPS-WATCH']);
    /* The card says 30 employees for the full company. */
    expect(staff).toHaveLength(30);
    /* Each employee works in its department itself, not in one of its products. */
    expect(staff.every(a => a.productId === null)).toBe(true);
  });

  it('leaves everyone waiting for a subscription when the company has none yet', async () => {
    const { app } = await testApp();
    await setUp(app, { ...LATER, template: 'project' });
    const staff = await staffOf(app);
    expect(staff.map(a => a.roleKey).sort()).toEqual(PROJECT);
    expect(staff.every(a => a.subscriptionId === null && a.model === '')).toBe(true);
  });

  it('puts everyone on the personal plan picked at setup, where it waits for its machine', async () => {
    const { app } = await testApp();
    await setUp(app, { ...SETUP, template: 'project', orchestrator: { mode: 'personal', provider: 'claude' } });
    const [plan] = await plans(app);
    expect(plan!.status).toBe('waiting_machine');
    expect((await staffOf(app)).every(a => a.subscriptionId === plan!.id)).toBe(true);
  });

  it('leaves the roles a plan cannot run waiting, as a hire does', async () => {
    const { app } = await testApp();
    await setUp(app, { ...SETUP, template: 'project', orchestrator: { mode: 'personal', provider: 'kimi' } });
    const [plan] = await plans(app);
    const staff = await staffOf(app);
    /* Kimi runs no deep model, which the head of development and the reviewer need. */
    expect(staff.filter(a => a.subscriptionId === null).map(a => a.roleKey).sort()).toEqual(['DEV-HEAD', 'DEV-REV']);
    expect(staff.filter(a => a.subscriptionId === plan!.id)).toHaveLength(6);
  });
});

describe('every ready-made company', () => {
  it.each([...COMPANY_TEMPLATE_KEYS])('%s brings each department with its head and employees, each with skills, waiting for a subscription', async template => {
    const { app, db } = await testApp();
    await setUp(app, { ...LATER, template });
    const listed = COMPANY_TEMPLATES.find(t => t.key === template)!.departments;
    const top = await db.select().from(departments).where(isNull(departments.parentId));
    expect(top.map(d => d.templateKey).sort()).toEqual(listed.map(d => d.template).sort());
    const staff = await staffOf(app);
    for (const dept of top) {
      const people = staff.filter(a => a.departmentId === dept.id);
      expect(people.filter(a => a.kind === 'head'), dept.templateKey!).toHaveLength(1);
      expect(people.filter(a => a.kind === 'worker').length, dept.templateKey!).toBeGreaterThan(0);
      const roles = listed.find(d => d.template === dept.templateKey)!.staff.flatMap(line => Array<string>(line.count).fill(line.role));
      expect(people.map(a => a.roleKey).sort(), dept.templateKey!).toEqual(roles.sort());
    }
    /* Grey on the map: no one has a subscription until one is connected. */
    for (const employee of staff) {
      expect(employee.skills.length, employee.name).toBeGreaterThan(0);
      expect(employee.subscriptionId, employee.name).toBeNull();
    }
    expect((await orchestrator(app)).subscriptionId).toBeNull();
  });

  it('starts from department templates that each have a head and employees with skills', async () => {
    const { app } = await testApp();
    for (const key of TEMPLATE_KEYS) {
      const roster = app.ctx.templates.roster(key).filter(r => r.inDefault);
      expect(roster.filter(r => r.kind === 'head'), key).toHaveLength(1);
      expect(roster.filter(r => r.kind !== 'head').length, key).toBeGreaterThan(0);
      for (const role of roster) expect(role.skills.filter(s => s.on).length, role.id).toBeGreaterThan(0);
    }
  });
});

describe('a subscription that comes later', () => {
  it('takes every employee that waits for one, and the orchestrator, with the model each tier asks for', async () => {
    const { app, db } = await testApp();
    const { ceo } = await setUp(app, { ...LATER, template: 'project' });
    expect((await addKey(app, ceo, { kind: 'any' })).statusCode).toBe(201);
    const [key] = await plans(app);
    const staff = await staffOf(app);
    expect(staff.every(a => a.subscriptionId === key!.id)).toBe(true);
    for (const employee of staff) expect(employee.model, employee.name).toBe(modelOnPlan(app.ctx.templates.roles.get(employee.roleKey!)!.tier, key!));
    expect((await orchestrator(app)).subscriptionId).toBe(key!.id);
    /* Hornhoof did it, so the card says no person did. */
    const [developer] = staff.filter(a => a.roleKey === 'DEV-ENG');
    const [change] = await db.select().from(agentChanges).where(and(eq(agentChanges.agentId, developer!.id), eq(agentChanges.field, 'subscription')));
    expect(change).toMatchObject({ personId: null, byOrchestrator: false, before: null, after: key!.id });
  });

  it('takes the employees of the department a key is for, and leaves the others waiting', async () => {
    const { app, db } = await testApp();
    const { ceo } = await setUp(app, { ...LATER, template: 'project' });
    const dev = (await db.select().from(departments).where(eq(departments.templateKey, 'development')))[0]!;
    expect((await addKey(app, ceo, { kind: 'department', id: dev.id })).statusCode).toBe(201);
    const [key] = await plans(app);
    const staff = await staffOf(app);
    expect(staff.filter(a => a.subscriptionId === key!.id).map(a => a.roleKey).sort()).toEqual(['DEV-ENG', 'DEV-ENG', 'DEV-HEAD', 'DEV-REV']);
    expect(staff.filter(a => a.departmentId !== dev.id).every(a => a.subscriptionId === null)).toBe(true);
    expect((await orchestrator(app)).subscriptionId).toBeNull();
  });

  it('takes the waiting employees when a person connects their own plan', async () => {
    const { app } = await testApp();
    const { ceo } = await setUp(app, { ...LATER, template: 'project' });
    expect((await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).statusCode).toBe(201);
    const [plan] = await plans(app);
    expect((await staffOf(app)).every(a => a.subscriptionId === plan!.id)).toBe(true);
    expect((await orchestrator(app)).subscriptionId).toBe(plan!.id);
  });

  it('gives an employee whose plan was removed the next one', async () => {
    const { app } = await testApp();
    const { ceo } = await setUp(app, { ...SETUP, template: 'project' });
    const [first] = await plans(app);
    expect((await app.inject({ method: 'DELETE', url: `/api/subscriptions/${first!.id}`, ...as(ceo) })).statusCode).toBe(204);
    expect((await staffOf(app)).every(a => a.subscriptionId === null)).toBe(true);
    expect((await addKey(app, ceo, { kind: 'any' })).statusCode).toBe(201);
    const second = (await plans(app)).find(p => p.id !== first!.id)!;
    expect((await staffOf(app)).every(a => a.subscriptionId === second.id)).toBe(true);
    expect((await orchestrator(app)).subscriptionId).toBe(second.id);
  });

  it('leaves an employee whose plan a person took off by hand', async () => {
    const { app } = await testApp();
    const { ceo } = await setUp(app, { ...SETUP, template: 'project' });
    const [reviewer] = (await staffOf(app)).filter(a => a.roleKey === 'DEV-REV');
    expect((await app.inject({ method: 'PATCH', url: `/api/agents/${reviewer!.id}`, payload: { subscription: null }, ...as(ceo) })).statusCode).toBe(200);
    expect((await addKey(app, ceo, { kind: 'any' })).statusCode).toBe(201);
    expect((await staffOf(app)).find(a => a.id === reviewer!.id)!.subscriptionId).toBeNull();
  });

  it('leaves an employee who is switched off waiting, as the program operator is', async () => {
    const { app, db } = await testApp();
    const { ceo } = await setUp(app, { ...LATER, template: 'project' });
    const [reviewer] = (await staffOf(app)).filter(a => a.roleKey === 'DEV-REV');
    await db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, reviewer!.id));
    expect((await addKey(app, ceo, { kind: 'any' })).statusCode).toBe(201);
    const staff = await staffOf(app);
    expect(staff.find(a => a.id === reviewer!.id)!.subscriptionId).toBeNull();
    expect(staff.filter(a => a.id !== reviewer!.id).every(a => a.subscriptionId !== null)).toBe(true);
  });

  it('takes an employee hired while the plan waited for its machine once the plan works', async () => {
    const { app, db } = await testApp();
    const url = await listen(app);
    const { ceo } = await setUp(app, { ...LATER, template: 'project' });
    const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).json();
    const plan = connected.subscriptions[0].id as string;
    /* A person hires one more developer while the plan still waits, so the card leaves it without one. */
    const dev = (await db.select().from(departments).where(eq(departments.templateKey, 'development')))[0]!;
    const role = app.ctx.templates.roles.get('DEV-ENG')!;
    const hired = await app.inject({ method: 'POST', url: `/api/departments/${dev.id}/staff`, payload: { people: [{ role: 'DEV-ENG', name: 'Developer 3', model: '', subscription: null, skills: role.skills.filter(s => s.on).map(s => s.id) }] }, ...as(ceo) });
    expect(hired.statusCode).toBe(201);
    const late = () => db.select().from(agents).where(eq(agents.name, 'Developer 3'));
    expect((await late())[0]!.subscriptionId).toBeNull();
    const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(connected.command), ...MAC } })).json();
    const node = await connectNode(url, joined.nodes[0].key);
    node.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    await until(async () => (await late())[0]!.subscriptionId === plan);
  });
});
