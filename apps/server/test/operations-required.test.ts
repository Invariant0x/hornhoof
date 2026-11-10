import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMPANY_TEMPLATES, COMPANY_TEMPLATE_KEYS } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentChanges, agentEvents, companies, departments, subscriptions } from '../src/db/schema.js';
import { FIRST_TURN } from '../src/modules/conversation/prompt.js';
import { PROGRAM_OPERATOR_ROLE, REQUIRED_OPERATIONS_ROLES } from '../src/modules/operations/required.js';
import { as, connectNode, listen, sessionFrom, SETUP, testApp, until, ownDatabases } from './helpers.js';
import { company, FOUR, NODE_KEY, opsDepartments, roles, staff } from './operations-required-fixture.js';

ownDatabases();

describe('the required roles of Operations', () => {
  it('are the four every company template lists', () => {
    expect([...REQUIRED_OPERATIONS_ROLES].sort()).toEqual(FOUR);
    for (const template of COMPANY_TEMPLATES) {
      const listed = template.departments.find(d => d.template === 'operations')!.staff.map(line => line.role);
      for (const role of REQUIRED_OPERATIONS_ROLES) expect(listed, `${template.key}: ${role}`).toContain(role);
    }
  });
});

describe('the program operator role', () => {
  /* Part A of the feature keeps this constant in the protocol. Until its module is merged there is nothing to compare. */
  const contract = fileURLToPath(new URL('../../../packages/protocol/src/program-operator.ts', import.meta.url));

  it.runIf(existsSync(contract))('is the one the protocol names', () => {
    expect(readFileSync(contract, 'utf8')).toContain(`PROGRAM_OPERATOR_ROLE = '${PROGRAM_OPERATOR_ROLE}'`);
  });
});

describe('a new company', () => {
  it.each([...COMPANY_TEMPLATE_KEYS])('from the %s template starts with the four roles in Operations', async template => {
    const { db } = await company({ template });
    expect(await opsDepartments(db)).toHaveLength(1);
    expect(await roles(db)).toEqual(FOUR);
  });

  it('with no template gets an Operations with the four roles, and nothing else', async () => {
    const { db } = await company();
    const top = await db.select().from(departments);
    expect(top.map(d => [d.templateKey, d.name, d.roleCode])).toEqual([['operations', null, 'OPS']]);
    expect(await roles(db)).toEqual(FOUR);
  });

  it('with no template still gets the orchestrator\'s greeting and his interview, with only the Operations it starts with', async () => {
    const { app, db } = await testApp({ NODE_KEY });
    const url = await listen(app);
    const ceo = sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }));
    expect(await opsDepartments(db)).toHaveLength(1);
    const node = await connectNode(url, NODE_KEY);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
    await until(async () => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(ceo) })).json().state.ready);
    const start = await app.inject({ method: 'POST', url: '/api/agents/orchestrator/start', ...as(ceo) });
    expect(start.json()).toEqual({ started: true });
    let run = await node.next();
    while (run.type !== 'job.run') run = await node.next();
    expect(run.prompt).toContain(FIRST_TURN);
  });

  it('built by hand on top of Operations gets no greeting: its build already told him', async () => {
    const { app, db } = await testApp({ NODE_KEY });
    const url = await listen(app);
    const ceo = sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }));
    const node = await connectNode(url, NODE_KEY);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
    await until(async () => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(ceo) })).json().state.ready);
    await db.insert(departments).values({ companyId: (await db.select().from(companies))[0]!.id, templateKey: 'support', roleCode: 'SUP', position: 5 });
    const start = await app.inject({ method: 'POST', url: '/api/agents/orchestrator/start', ...as(ceo) });
    expect(start.json()).toEqual({ started: false });
  });

  it('hires each role as an ordinary hire: its kind, its skills, its timer, its template hashes', async () => {
    const { app, db } = await company();
    const all = await staff(db);
    const byRole = (id: string) => all.find(a => a.roleKey === id)!;
    expect(all.map(a => a.kind).sort()).toEqual(['head', 'worker', 'worker', 'worker']);
    expect(byRole('OPS-HEAD').kind).toBe('head');
    expect(byRole('OPS-WATCH')).toMatchObject({ timerMinutes: 10, timerForWork: true, name: 'Task watchdog' });
    expect(byRole('OPS-WATCH').timerAt).toBeInstanceOf(Date);
    /* Each runs the model its role asks for on the company's key, by name: the middle one for the operator, the lightest for the watchdog. */
    expect(byRole('OPS-PROGRAM')).toMatchObject({ timerMinutes: null, model: 'claude-sonnet-5-5', name: 'Program operator', createdBy: null });
    expect(byRole('OPS-WATCH').model).toBe('claude-haiku-5-5');
    const role = app.ctx.templates.roles.get('OPS-PROGRAM')!;
    expect(byRole('OPS-PROGRAM').skills).toEqual(role.skills.filter(s => s.on).map(s => s.id));
    expect(byRole('OPS-PROGRAM').templateHashes['OPS-PROGRAM']).toBe(role.hash);
    expect(byRole('OPS-PROGRAM').templateHashes['ops-program-operator']).toBe(app.ctx.templates.skills.get('ops-program-operator')!.hash);
  });

  it('records the hires as Hornhoof\'s own: neither a person nor the orchestrator', async () => {
    const { db } = await company();
    const operator = (await staff(db)).find(a => a.roleKey === 'OPS-PROGRAM')!;
    const [change] = await db.select().from(agentChanges).where(eq(agentChanges.agentId, operator.id));
    expect(change).toMatchObject({ field: 'hired', personId: null, byOrchestrator: false, before: null });
    expect(change!.after).toMatchObject({ role: 'OPS-PROGRAM', name: 'Program operator' });
  });

  it('leaves the orchestrator\'s conversation unbegun, so he still greets the CEO', async () => {
    const { db } = await company();
    expect(await db.select().from(agentEvents)).toEqual([]);
  });

  it('with a key puts all four on it, the first plan that serves Operations', async () => {
    const { db } = await company();
    const [key] = await db.select().from(subscriptions);
    expect((await staff(db)).map(a => a.subscriptionId)).toEqual([key!.id, key!.id, key!.id, key!.id]);
  });

  it('with a plan that waits for its machine puts them on it all the same', async () => {
    const { db } = await company({ orchestrator: { mode: 'personal', provider: 'claude' } });
    const [plan] = await db.select().from(subscriptions);
    expect(plan!.status).toBe('waiting_machine');
    expect((await staff(db)).find(a => a.roleKey === 'OPS-PROGRAM')!.subscriptionId).toBe(plan!.id);
  });

  it('with no subscription yet has the operator wait without one', async () => {
    const { db } = await company({ orchestrator: { mode: 'later' } });
    expect(await roles(db)).toEqual(FOUR);
    expect((await staff(db)).map(a => a.subscriptionId)).toEqual([null, null, null, null]);
  });
});
