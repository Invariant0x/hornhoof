import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMPANY_TEMPLATES, COMPANY_TEMPLATE_KEYS } from '@hornhoof/protocol';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agentChanges, agentEvents, agents, companies, departments, jobs, people, subscriptions } from '../src/db/schema.js';
import { FIRST_TURN } from '../src/modules/conversation/prompt.js';
import { checkOperations, ensureOperations } from '../src/modules/operations/ensure.js';
import { PROGRAM_OPERATOR_ROLE, REQUIRED_OPERATIONS_ROLES } from '../src/modules/operations/required.js';
import { appOn, as, connectNode, createTestDb, listen, sessionFrom, SETUP, statements, testApp, until } from './helpers.js';

const FOUR = ['OPS-BUGS', 'OPS-HEAD', 'OPS-PROGRAM', 'OPS-WATCH'];
const NODE_KEY = 'k'.repeat(40);

async function opsDepartments(db: Db) {
  return db.select().from(departments).where(and(eq(departments.templateKey, 'operations'), isNull(departments.parentId)));
}

/* The live employees of Operations. */
async function staff(db: Db) {
  const [ops] = await opsDepartments(db);
  return db.select().from(agents).where(and(eq(agents.departmentId, ops!.id), isNull(agents.removedAt))).orderBy(asc(agents.createdAt), asc(agents.id));
}
const roles = async (db: Db) => (await staff(db)).map(a => a.roleKey).sort();

async function company(payload: object = {}) {
  const { app, db } = await testApp();
  expect((await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, ...payload } })).statusCode).toBe(201);
  const [acme] = await db.select().from(companies);
  return { app, db, companyId: acme!.id };
}

/* A company as it stood before Operations was required, with what the test leaves in it. */
async function staffedLike(db: Db, companyId: string, keep: (a: typeof agents.$inferSelect) => boolean) {
  for (const a of await staff(db)) {
    if (keep(a)) continue;
    await db.delete(agentChanges).where(eq(agentChanges.agentId, a.id));
    await db.delete(agents).where(eq(agents.id, a.id));
  }
  await db.delete(agentEvents).where(eq(agentEvents.companyId, companyId));
}

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
    expect(byRole('OPS-PROGRAM')).toMatchObject({ timerMinutes: null, model: '', name: 'Program operator', createdBy: null });
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

describe('a company that lives already', () => {
  it('gets who is missing when the server starts, with its one head kept', async () => {
    const db = await createTestDb();
    const first = await appOn(db.$client);
    expect((await first.app.inject({ method: 'POST', url: '/api/setup', payload: SETUP })).statusCode).toBe(201);
    const [acme] = await db.select().from(companies);
    await staffedLike(db as unknown as Db, acme!.id, a => a.kind === 'head');
    const [head] = await staff(db as unknown as Db);
    await db.update(agents).set({ name: 'Hanna', model: 'claude-sonnet-5-5' }).where(eq(agents.id, head!.id));
    await first.app.close();

    const second = await appOn(db.$client);
    await second.app.ready();
    const after = await staff(db as unknown as Db);
    expect(after.map(a => a.roleKey).sort()).toEqual(FOUR);
    expect(after.find(a => a.id === head!.id)).toMatchObject({ name: 'Hanna', model: 'claude-sonnet-5-5', kind: 'head' });
    expect(after.filter(a => a.kind === 'head')).toHaveLength(1);
  });

  it('creates Operations when it has none, first in a company without departments', async () => {
    const { app, db, companyId } = await company();
    await staffedLike(db, companyId, () => false);
    await db.delete(departments).where(eq(departments.companyId, companyId));
    await ensureOperations(app.ctx, companyId);
    const [ops] = await opsDepartments(db);
    expect(ops!.position).toBe(0);
    expect(await roles(db)).toEqual(FOUR);
  });

  it('puts an Operations it creates after the departments the company has', async () => {
    const { app, db, companyId } = await company();
    await staffedLike(db, companyId, () => false);
    await db.delete(departments).where(eq(departments.companyId, companyId));
    await db.insert(departments).values({ companyId, templateKey: 'sales', roleCode: 'SAL', position: 0 });
    await ensureOperations(app.ctx, companyId);
    expect((await opsDepartments(db))[0]!.position).toBe(1);
    await staffedLike(db, companyId, () => false);
    await db.delete(departments).where(eq(departments.templateKey, 'operations'));
    await db.update(departments).set({ position: 4 }).where(eq(departments.templateKey, 'sales'));
    await ensureOperations(app.ctx, companyId);
    expect((await opsDepartments(db))[0]!.position).toBe(5);
  });

  it('counts an old head with no role key as the head, and does not break the one head rule', async () => {
    const { app, db, companyId } = await company();
    await staffedLike(db, companyId, a => a.kind === 'head');
    const [head] = await staff(db);
    await db.update(agents).set({ roleKey: null, name: 'Old head' }).where(eq(agents.id, head!.id));
    await ensureOperations(app.ctx, companyId);
    const after = await staff(db);
    expect(after.filter(a => a.kind === 'head').map(a => a.name)).toEqual(['Old head']);
    expect(after.map(a => a.roleKey ?? 'none').sort()).toEqual(['OPS-BUGS', 'OPS-PROGRAM', 'OPS-WATCH', 'none']);
  });

  it('leaves extra employees, and the names, models and switches of those it finds, alone', async () => {
    const { app, db, companyId } = await company();
    const [ops] = await opsDepartments(db);
    const watch = (await staff(db)).find(a => a.roleKey === 'OPS-WATCH')!;
    const switchedOff = new Date('2026-01-02T03:04:05Z');
    await db.update(agents).set({ name: 'Argus', model: 'claude-opus-5-5', switchedOffAt: switchedOff }).where(eq(agents.id, watch.id));
    const [extra] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Fixer', model: '', departmentId: ops!.id, roleKey: 'OPS-FIX' }).returning();
    const [second] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Second watchdog', model: '', departmentId: ops!.id, roleKey: 'OPS-WATCH' }).returning();
    const before = await db.select().from(agentChanges);
    await ensureOperations(app.ctx, companyId);
    const after = await staff(db);
    expect(after.find(a => a.id === watch.id)).toMatchObject({ name: 'Argus', model: 'claude-opus-5-5', switchedOffAt: switchedOff });
    expect(after.find(a => a.id === extra!.id)).toMatchObject({ name: 'Fixer', subscriptionId: null });
    expect(after.find(a => a.id === second!.id)).toMatchObject({ name: 'Second watchdog', subscriptionId: null });
    expect(after).toHaveLength(6);
    expect(await db.select().from(agentChanges)).toEqual(before);
  });

  it('counts a switched off employee as there, and does not bring one back who was removed', async () => {
    const { app, db, companyId } = await company();
    const all = await staff(db);
    const watch = all.find(a => a.roleKey === 'OPS-WATCH')!;
    const bugs = all.find(a => a.roleKey === 'OPS-BUGS')!;
    await db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, watch.id));
    await db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, bugs.id));
    await ensureOperations(app.ctx, companyId);
    const after = await staff(db);
    expect(after.filter(a => a.roleKey === 'OPS-WATCH').map(a => a.id)).toEqual([watch.id]);
    const collectors = after.filter(a => a.roleKey === 'OPS-BUGS');
    expect(collectors).toHaveLength(1);
    expect(collectors[0]!.id).not.toBe(bugs.id);
    expect((await db.select().from(agents).where(eq(agents.id, bugs.id)))[0]!.removedAt).toBeInstanceOf(Date);
  });

  it('hires no one twice, run again or run at once', async () => {
    const { app, db, companyId } = await company();
    await staffedLike(db, companyId, a => a.kind === 'head');
    await Promise.all([ensureOperations(app.ctx, companyId), ensureOperations(app.ctx, companyId), ensureOperations(app.ctx, companyId)]);
    expect(await roles(db)).toEqual(FOUR);
    await ensureOperations(app.ctx, companyId);
    expect(await roles(db)).toEqual(FOUR);
    /* The head's from the setup, and one for each of the three it found missing. */
    expect(await db.select().from(agentChanges).where(eq(agentChanges.field, 'hired'))).toHaveLength(4);
  });

  it('holds the company while it looks at who is there, so another server waits its turn', async () => {
    const { app, companyId } = await company();
    const seen = statements();
    await ensureOperations(app.ctx, companyId);
    const lock = seen.findIndex(s => /from "companies".*for update/i.test(s.sql));
    const look = seen.findIndex(s => /from "agents"/i.test(s.sql));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(look);
  });

  it('tells the orchestrator in his window who came, once his conversation has begun', async () => {
    const { app, db, companyId } = await company();
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    await staffedLike(db, companyId, a => a.kind === 'head');
    /* The very first thing in his window counts. */
    await db.insert(agentEvents).values({ companyId, agentId: orchestrator!.id, seq: 1, kind: 'text', data: { text: 'Hello' } });
    await ensureOperations(app.ctx, companyId);
    const told = await db.select().from(agentEvents).where(eq(agentEvents.kind, 'applied'));
    expect(told).toHaveLength(1);
    expect(told[0]!.personId).toBeNull();
    expect(told[0]!.data).toMatchObject({ proposalId: null, kind: 'staff', hired: [{ role: 'OPS-WATCH' }, { role: 'OPS-BUGS' }, { role: 'OPS-PROGRAM' }] });
    await ensureOperations(app.ctx, companyId);
    expect(await db.select().from(agentEvents).where(eq(agentEvents.kind, 'applied'))).toHaveLength(1);
  });

  it('changes nothing and tells no map when Operations is whole', async () => {
    const { app, db, companyId } = await company();
    const before = await staff(db);
    const seen = statements();
    const told = vi.spyOn(app.ctx.bus, 'publish');
    await ensureOperations(app.ctx, companyId);
    expect(await staff(db)).toEqual(before);
    expect(seen.filter(s => /^(insert|update|delete)/i.test(s.sql))).toEqual([]);
    expect(told).not.toHaveBeenCalled();
  });

  it('tells the map when it hires someone', async () => {
    const { app, db, companyId } = await company();
    await staffedLike(db, companyId, a => a.kind === 'head');
    const told = vi.spyOn(app.ctx.bus, 'publish');
    await ensureOperations(app.ctx, companyId);
    expect(told).toHaveBeenCalledWith(companyId, { type: 'org' });
  });

  it('goes on with the rest of the check when one company fails, and reports it', async () => {
    const { app, db, companyId } = await company();
    await db.insert(companies).values({ name: 'Globex', singleton: false });
    await db.execute(sql`create function refuse_hire() returns trigger language plpgsql as $$ begin if new.company_id = ${sql.raw(`'${companyId}'`)} then raise exception 'no hire'; end if; return new; end $$`);
    await db.execute(sql`create trigger refuse_hire before insert on agents for each row execute function refuse_hire()`);
    await staffedLike(db, companyId, () => false);
    const failures: unknown[] = [];
    await checkOperations(app.ctx, err => failures.push(err));
    expect(failures).toHaveLength(1);
    const globex = (await db.select().from(companies)).find(c => c.name === 'Globex')!;
    const hired = await db.select().from(agents).where(eq(agents.companyId, globex.id));
    expect(hired.map(a => a.roleKey).sort()).toEqual(FOUR);
  });

  it('does not touch people or jobs', async () => {
    const { app, db, companyId } = await company();
    await staffedLike(db, companyId, a => a.kind === 'head');
    const before = { people: await db.select().from(people), jobs: await db.select().from(jobs) };
    await ensureOperations(app.ctx, companyId);
    expect({ people: await db.select().from(people), jobs: await db.select().from(jobs) }).toEqual(before);
  });
});
