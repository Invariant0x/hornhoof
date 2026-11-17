import { COMPANY_TEMPLATE_KEYS, COMPANY_TEMPLATES, DEPARTMENT_TEMPLATES, TEMPLATE_KEYS } from '@hornhoof/protocol';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agentChanges, agents, departments, subscriptions, teams } from '../src/db/schema.js';
import { modelOnPlan } from '../src/modules/agents/role-model.js';
import { as, connectNode, listen, sessionFrom, SETUP, testApp, until } from './helpers.js';

const LATER = { ...SETUP, orchestrator: { mode: 'later' } };
const MAC = { machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' };
const codeOf = (command: string) => command.split('--join ')[1]!;

/* The project template: Operations with its four, Development with a head, two developers and a reviewer, a product
   manager in each, and the turnkey team of each: two developers in Development, an incident fixer in Operations. */
const PROJECT = ['DEV-ENG', 'DEV-ENG', 'DEV-ENG', 'DEV-ENG', 'DEV-HEAD', 'DEV-PM', 'DEV-REV', 'OPS-BUGS', 'OPS-FIX', 'OPS-HEAD', 'OPS-PM', 'OPS-PROGRAM', 'OPS-WATCH'];
/* A member of a turnkey team runs the strongest model, as nobody checks after it. */
const tierOf = (app: FastifyInstance, employee: typeof agents.$inferSelect) => (employee.teamId ? 'top' : app.ctx.templates.roles.get(employee.roleKey!)!.tier);

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
  it.each([...COMPANY_TEMPLATE_KEYS, undefined])('offers first work for %s as soon as the company is set up', async template => {
    const { app } = await testApp();
    const { ceo } = await setUp(app, { ...LATER, template });
    const offer = await app.inject({ url: '/api/orchestrator/first-contact', ...as(ceo) });
    expect(offer.statusCode).toBe(200);
    const expected = {
      project: ['fixProject', 'checkSetup'], startup: ['planLaunch', 'sketchProduct', 'findCustomers'],
      studio: ['pickProduct', 'reviewScreens'], corporation: ['reviewBills', 'sortRequests', 'planRelease'],
      security: ['reviewSecurity', 'triageReport'], opensource: ['sortIssues', 'writeGuide'],
      agency: ['findLeads', 'answerClients'], lab: ['planExperiment', 'reviewResults'],
      home: ['findDevices', 'checkDevices', 'householdBooks'], empty: ['chooseDepartments'],
    };
    expect(offer.json()).toEqual({ offers: [...expected[template ?? 'empty'], 'telegram', 'assistant'] });
  });

  it.each([...COMPANY_TEMPLATE_KEYS, undefined])('starts %s with one default pipeline for each department', async template => {
    const { app, db } = await testApp();
    const { ceo } = await setUp(app, { ...LATER, template });
    const all = (await app.inject({ url: '/api/pipelines', ...as(ceo) })).json().pipelines;
    const top = await db.select().from(departments).where(isNull(departments.parentId));
    expect(all).toHaveLength(top.length);
    for (const dept of top) {
      const catalog = app.ctx.templates.catalogs.get(dept.templateKey!)!;
      const stock = catalog.pipelines.find(p => p.key === catalog.default)!;
      expect(all).toContainEqual(expect.objectContaining({
        department: expect.objectContaining({ id: dept.id }), catalogKey: stock.key, isDefault: true,
        name: stock.name, stages: stock.stages.map(stage => expect.objectContaining({ name: stage.name, ownerRole: stage.ownerRole })),
      }));
    }
  });

  it('gives a department built after setup its default pipeline even without staff', async () => {
    const { app } = await testApp();
    const { ceo } = await setUp(app, LATER);
    const built = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'design', staff: false }] }, ...as(ceo) });
    expect(built.statusCode, built.body).toBe(201);
    const list = (await app.inject({ url: '/api/pipelines', ...as(ceo) })).json().pipelines;
    expect(list).toContainEqual(expect.objectContaining({ catalogKey: 'design-requests', isDefault: true }));
  });

  it('shows ordinary staff, turnkey members and declared one-shot stages before a template company has plans', async () => {
    const templates = mkdtempSync(join(tmpdir(), 'hornhoof-worker-kinds-'));
    onTestFinished(() => rmSync(templates, { recursive: true, force: true }));
    cpSync(new URL('../../../templates', import.meta.url), templates, { recursive: true });
    const route = join(templates, 'echelons', 'marketing.md');
    writeFileSync(route, `---\ndepartment: marketing\nstages:\n  - { stage: development }\n  - { stage: review, ability: hh-check-work, oneShot: { fanOut: 3, judge: Private judge brief } }\n---\n`);
    const { app, db } = await testApp({ TEMPLATES_DIR: templates });
    const { ceo } = await setUp(app, { ...LATER, template: 'corporation' });

    expect(await plans(app)).toEqual([]);
    const res = await app.inject({ url: '/api/org', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Private judge brief');
    const { departments: org } = res.json();
    const marketing = org.find((d: { templateKey: string }) => d.templateKey === 'marketing');
    expect(marketing).toMatchObject({ oneShotStages: [{ stage: 'review', fanOut: 3, judge: true }], calls: [] });
    const [generalist, ordinary] = [true, false].map(turnkey => marketing.employees.find((e: { teamId?: string }) => Boolean(e.teamId) === turnkey));
    expect(generalist).toMatchObject({ turnkey: true, state: 'needs_subscription' });
    expect(ordinary).toMatchObject({ turnkey: false, state: 'needs_subscription' });

    const nonTurnkey = await db.update(teams).set({ turnkey: false }).where(eq(teams.id, generalist.teamId)).returning({ id: teams.id });
    expect(nonTurnkey).toHaveLength(1);
    const next = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(next.departments.flatMap((d: typeof marketing) => d.employees)).toContainEqual(expect.objectContaining({ id: generalist.id, turnkey: false }));
  });

  it('hires every employee of the template, with its role, skills and the model its tier asks for on the key', async () => {
    const { app, db } = await testApp();
    await setUp(app, { ...SETUP, template: 'project' });
    const [key] = await plans(app);
    const staff = await staffOf(app);
    expect(staff.map(a => a.roleKey).sort()).toEqual(PROJECT);
    const dev = (await db.select().from(departments).where(eq(departments.templateKey, 'development')))[0]!;
    expect(staff.filter(a => a.departmentId === dev.id).map(a => a.name).sort()).toEqual(['Code reviewer', 'Developer 1', 'Developer 1 (Turnkey team)', 'Developer 2', 'Developer 2 (Turnkey team)', 'Head of development', 'Product manager']);
    for (const employee of staff) {
      const role = app.ctx.templates.roles.get(employee.roleKey!)!;
      expect(employee.subscriptionId, employee.name).toBe(key!.id);
      expect(employee.skills, employee.name).toEqual(expect.arrayContaining(role.skills.filter(s => s.on).map(s => s.id)));
      expect(employee.model, employee.name).toBe(modelOnPlan(tierOf(app, employee), key!));
    }
  });

  it('hires the template as many as it says in each department, and Operations no one twice', async () => {
    const { app, db } = await testApp();
    await setUp(app, { ...SETUP, template: 'corporation' });
    const staff = await staffOf(app);
    const ops = (await db.select().from(departments).where(eq(departments.templateKey, 'operations')))[0]!;
    expect(staff.filter(a => a.departmentId === ops.id).map(a => a.roleKey).sort()).toEqual(['OPS-BUGS', 'OPS-FIX', 'OPS-FIX', 'OPS-HEAD', 'OPS-INTEG', 'OPS-PM', 'OPS-PROGRAM', 'OPS-WATCH']);
    /* The card says 47 employees for the full company: 38 in its departments and 9 in their turnkey teams. */
    expect(staff).toHaveLength(47);
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
    /* Kimi runs no deep model, which the head of development and the reviewer need, nor the strongest one of a turnkey team. */
    expect(staff.filter(a => a.subscriptionId === null).map(a => a.roleKey).sort()).toEqual(['DEV-ENG', 'DEV-ENG', 'DEV-HEAD', 'DEV-REV', 'OPS-FIX']);
    expect(staff.filter(a => a.subscriptionId === plan!.id)).toHaveLength(8);
  });
});

describe('every ready-made company', () => {
  it.each([...COMPANY_TEMPLATE_KEYS])('%s shows its declared ghost places on the map before any subscription is connected', async template => {
    const { app } = await testApp();
    const { ceo } = await setUp(app, { ...LATER, template });
    expect(await plans(app)).toEqual([]);
    const res = await app.inject({ url: '/api/org', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    const { departments: org } = res.json();
    const listed = COMPANY_TEMPLATES.find(t => t.key === template)!.departments;
    const expected = listed.map(({ template: key }) => ({
      templateKey: key,
      oneShotStages: app.ctx.templates.stagesOf(key).stages.flatMap(({ stage, oneShot }) =>
        oneShot ? [{ stage, fanOut: oneShot.fanOut, judge: oneShot.judge !== null }] : [],
      ),
      calls: [],
    }));
    expect(expected.some(dept => dept.oneShotStages.length > 0)).toBe(true);
    expect(org).toHaveLength(expected.length);
    expect(org).toEqual(expect.arrayContaining(expected.map(dept => expect.objectContaining(dept))));
  });

  it.each([...COMPANY_TEMPLATE_KEYS])('%s brings each department with its head and employees, each with skills, waiting for a subscription', async template => {
    const { app, db } = await testApp();
    await setUp(app, { ...LATER, template });
    const listed = COMPANY_TEMPLATES.find(t => t.key === template)!.departments;
    const top = await db.select().from(departments).where(isNull(departments.parentId));
    expect(top.map(d => d.templateKey).sort()).toEqual(listed.map(d => d.template).sort());
    const staff = await staffOf(app);
    const made = await db.select().from(teams);
    for (const dept of top) {
      const people = staff.filter(a => a.departmentId === dept.id);
      expect(people.filter(a => a.kind === 'head'), dept.templateKey!).toHaveLength(1);
      expect(people.filter(a => a.kind === 'worker').length, dept.templateKey!).toBeGreaterThan(0);
      const roles = listed.find(d => d.template === dept.templateKey)!.staff.flatMap(line => Array<string>(line.count).fill(line.role));
      expect(people.filter(a => !a.teamId).map(a => a.roleKey).sort(), dept.templateKey!).toEqual(roles.sort());
      /* Each turnkey team of the department's template comes as a sub-unit with its members, as the orchestrator builds it. */
      const kept = app.ctx.templates.teamsOf(dept.templateKey!);
      const own = made.filter(t => t.departmentId === dept.id);
      expect(own.map(t => [t.name, t.turnkey]), dept.templateKey!).toEqual(kept.map(t => [t.title.en, t.turnkey]));
      const members = kept.flatMap(t => t.members.flatMap(line => Array<string>(line.count).fill(line.role)));
      expect(people.filter(a => own.some(t => t.id === a.teamId)).map(a => a.roleKey).sort(), dept.templateKey!).toEqual(members.sort());
    }
    /* As many as the template's card says. */
    const counted = listed.reduce((n, d) => n + d.staff.reduce((m, line) => m + line.count, 0) + DEPARTMENT_TEMPLATES.find(t => t.key === d.template)!.teamMembers, 0);
    expect(staff).toHaveLength(counted);
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

describe('a product added later', () => {
  async function design(app: FastifyInstance, ceo: string) {
    const built = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'design', staff: true }] }, ...as(ceo) });
    expect(built.statusCode).toBe(201);
    return (await app.ctx.db.select().from(departments).where(eq(departments.templateKey, 'design')))[0]!;
  }
  const skillsOf = (app: FastifyInstance, role: string) => app.ctx.templates.roles.get(role)!.skills.filter(s => s.on).map(s => s.id);

  it('hires the people its department keeps one of for each product, as the structure card or the orchestrator adds it', async () => {
    const { app, db } = await testApp();
    const { ceo } = await setUp(app, LATER);
    const dept = await design(app, ceo);
    const added = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ department: dept.id, products: ['Shop'] }] }, ...as(ceo) });
    expect(added.statusCode).toBe(201);
    const [shop] = await db.select().from(departments).where(eq(departments.name, 'Shop'));
    const people = (await staffOf(app)).filter(a => a.productId === shop!.id);
    expect(people.map(a => [a.roleKey, a.name, a.departmentId, a.subscriptionId])).toEqual([['DSN-UI', 'Product UI designer (Shop)', dept.id, null]]);
    expect(people[0]!.skills).toEqual(skillsOf(app, 'DSN-UI'));
  });

  it('hires them for a product that comes with another repository', async () => {
    const { app } = await testApp();
    const { ceo } = await setUp(app, LATER);
    const dept = await design(app, ceo);
    const added = await app.inject({ method: 'POST', url: `/api/departments/${dept.id}/repositories`, payload: { url: 'https://github.com/acme/brand.git' }, ...as(ceo) });
    expect(added.statusCode).toBe(201);
    const people = (await staffOf(app)).filter(a => a.productId === added.json().product.id);
    expect(people.map(a => [a.roleKey, a.name, a.departmentId])).toEqual([['DSN-UI', 'Product UI designer (brand)', dept.id]]);
    expect(people[0]!.skills).toEqual(skillsOf(app, 'DSN-UI'));
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
    for (const employee of staff) expect(employee.model, employee.name).toBe(modelOnPlan(tierOf(app, employee), key!));
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
    expect(staff.filter(a => a.subscriptionId === key!.id).map(a => a.roleKey).sort()).toEqual(['DEV-ENG', 'DEV-ENG', 'DEV-ENG', 'DEV-ENG', 'DEV-HEAD', 'DEV-PM', 'DEV-REV']);
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
