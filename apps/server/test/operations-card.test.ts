import { and, asc, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import type { Db } from '../src/db/client.js';
import { agentChanges, agentEvents, agents, companies, departments, jobs, proposals, subscriptions, tasks } from '../src/db/schema.js';
import { as, connectNode, listen, mcp, sessionFrom, SETUP, statements, testApp, until } from './helpers.js';

const TOKEN = 'tool-token-0123456789abcdef0123456789';
const FOUR = ['OPS-BUGS', 'OPS-HEAD', 'OPS-PROGRAM', 'OPS-WATCH'];

const NODE_KEY = 'k'.repeat(40);

async function company() {
  const { app, db } = await testApp({ NODE_KEY });
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP });
  expect(res.statusCode).toBe(201);
  const ceo = sessionFrom(res);
  const built = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'development' }] }, ...as(ceo) });
  expect(built.statusCode).toBe(201);
  const [acme] = await db.select().from(companies);
  const [ops] = await db.select().from(departments).where(eq(departments.templateKey, 'operations'));
  const [dev] = await db.select().from(departments).where(eq(departments.templateKey, 'development'));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  return { app, db, ceo, companyId: acme!.id, ops: ops!, dev: dev!, orchestrator: orchestrator! };
}
type Company = Awaited<ReturnType<typeof company>>;

const staff = (db: Db, departmentId: string) => db.select().from(agents).where(and(eq(agents.departmentId, departmentId), isNull(agents.removedAt))).orderBy(asc(agents.createdAt), asc(agents.id));
const holder = async (c: Company, role: string) => (await staff(c.db, c.ops.id)).find(a => a.roleKey === role)!;

/* The company as if one who holds a required role went away by hand, before the next check. */
const gone = async (c: Company, ...roles: string[]) => {
  for (const role of roles) await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, (await holder(c, role)).id));
};

/* A card's line for a role, with the skills its role starts with. */
const lineOf = (c: Company, role: string, name = role) => ({ role, name, model: '', subscription: null, skills: c.app.ctx.templates.roles.get(role)!.skills.filter(s => s.on).map(s => s.id) });
const apply = (c: Company, body: object, departmentId = c.ops.id) => c.app.inject({ method: 'POST', url: `/api/departments/${departmentId}/staff`, payload: body, ...as(c.ceo) });

/* A card someone proposed before Hornhoof brought Operations to its full staff. */
async function oldCard(c: Company, roles: string[]) {
  const [card] = await c.db
    .insert(proposals)
    .values({ audience: 'human', companyId: c.companyId, agentId: c.orchestrator.id, kind: 'staff', departmentId: c.ops.id, brief: 'Old', items: roles.map(role => ({ role, checked: true })) })
    .returning({ id: proposals.id });
  return card!.id;
}

/* The orchestrator's tools as his running turn sees them. */
async function tools(c: Company) {
  await listen(c.app);
  await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.orchestrator.subscriptionId!, agentId: c.orchestrator.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(TOKEN) });
  return mcp(c.app, TOKEN);
}
const text = (res: unknown) => (res as { content: { text: string }[] }).content[0]!.text;
const failed = (res: unknown) => Boolean((res as { isError?: boolean }).isError);
const propose = async (c: Company, people: object[]) => {
  const client = await tools(c);
  return client.callTool({ name: 'propose_staff', arguments: { department: c.ops.id, brief: 'Staff it.', people } });
};

describe('the roster of Operations', () => {
  it('marks the four roles required and says who holds each, in the card and for the orchestrator', async () => {
    const c = await company();
    await c.db.update(agents).set({ name: 'Argus' }).where(eq(agents.id, (await holder(c, 'OPS-WATCH')).id));
    await gone(c, 'OPS-BUGS');
    const roster = (await c.app.inject({ method: 'GET', url: `/api/departments/${c.ops.id}/roster`, ...as(c.ceo) })).json();
    const role = (id: string) => roster.roles.find((r: { id: string }) => r.id === id);
    expect(role('OPS-WATCH')).toMatchObject({ required: true, holder: 'Argus' });
    expect(role('OPS-HEAD')).toMatchObject({ required: true, holder: 'Head of operations' });
    expect(role('OPS-BUGS')).toMatchObject({ required: true, holder: null });
    expect(role('OPS-FIX')).toMatchObject({ required: false, holder: null });
    const options = JSON.parse(text(await (await tools(c)).callTool({ name: 'staffing_options', arguments: { department: c.ops.id } })));
    const option = (id: string) => options.roster.find((r: { role: string }) => r.role === id);
    expect(option('OPS-WATCH')).toMatchObject({ required: true, holder: 'Argus' });
    expect(option('OPS-BUGS')).toMatchObject({ required: true, holder: null });
    expect(option('OPS-FIX')).toMatchObject({ required: false, holder: null });
  });

  it('counts an old head with no role key, and a switched off employee, as the holder', async () => {
    const c = await company();
    await c.db.update(agents).set({ roleKey: null, name: 'Old head' }).where(eq(agents.kind, 'head'));
    await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, (await holder(c, 'OPS-WATCH')).id));
    const { roles } = (await c.app.inject({ method: 'GET', url: `/api/departments/${c.ops.id}/roster`, ...as(c.ceo) })).json();
    expect(roles.find((r: { id: string }) => r.id === 'OPS-HEAD').holder).toBe('Old head');
    expect(roles.find((r: { id: string }) => r.id === 'OPS-WATCH').holder).toBe('Task watchdog');
  });

  it('marks nothing required in another department', async () => {
    const c = await company();
    const { roles } = (await c.app.inject({ method: 'GET', url: `/api/departments/${c.dev.id}/roster`, ...as(c.ceo) })).json();
    expect(roles.every((r: { required: boolean; holder: unknown }) => r.required === false && r.holder === null)).toBe(true);
  });
});

describe('a staff proposal for Operations', () => {
  it('lists the required roles ticked, whatever the orchestrator sent', async () => {
    const c = await company();
    const res = await propose(c, [{ role: 'OPS-WATCH', name: 'Argus', checked: false }, { role: 'OPS-FIX', checked: true }, { role: 'OPS-INTEG', checked: false }]);
    expect(failed(res)).toBe(false);
    const [card] = await c.db.select().from(proposals).where(eq(proposals.kind, 'staff'));
    const items = card!.items as { role: string; checked: boolean; name?: string }[];
    expect(items.filter(i => FOUR.includes(i.role)).map(i => i.role).sort()).toEqual(FOUR);
    expect(items.filter(i => FOUR.includes(i.role)).every(i => i.checked)).toBe(true);
    expect(items.find(i => i.role === 'OPS-WATCH')!.name).toBe('Argus');
    expect(items.find(i => i.role === 'OPS-FIX')!.checked).toBe(true);
    expect(items.find(i => i.role === 'OPS-INTEG')!.checked).toBe(false);
  });

  it('leaves another department as the orchestrator sent it', async () => {
    const c = await company();
    const client = await tools(c);
    const people = [{ role: 'DEV-HEAD', checked: false }];
    expect(failed(await client.callTool({ name: 'propose_staff', arguments: { department: c.dev.id, brief: 'Staff it.', people } }))).toBe(false);
    const [card] = await c.db.select().from(proposals).where(eq(proposals.kind, 'staff'));
    expect(card!.items).toEqual(people);
  });

  it('shows no card that has nobody to hire, and says who is there', async () => {
    const c = await company();
    const res = await propose(c, [{ role: 'OPS-WATCH', checked: true }, { role: 'OPS-FIX', checked: false }]);
    expect(failed(res)).toBe(true);
    expect(text(res)).toMatch(/Nothing to hire/);
    expect(await c.db.select().from(proposals).where(eq(proposals.kind, 'staff'))).toEqual([]);
  });

  it('shows the card when one of the four is missing, even with nothing else on it', async () => {
    const c = await company();
    await gone(c, 'OPS-PROGRAM');
    expect(failed(await propose(c, [{ role: 'OPS-WATCH', checked: true }]))).toBe(false);
  });

  it('still refuses a role that is not of the department', async () => {
    const c = await company();
    const res = await propose(c, [{ role: 'DEV-HEAD', checked: true }]);
    expect(failed(res)).toBe(true);
    expect(text(res)).toMatch(/not a role of/);
  });
});

describe('applying a staff card for Operations', () => {
  it('hires a required role that is missing', async () => {
    const c = await company();
    await gone(c, 'OPS-PROGRAM');
    const res = await apply(c, { people: [lineOf(c, 'OPS-PROGRAM', 'Otto')] });
    expect(res.statusCode).toBe(201);
    expect((await holder(c, 'OPS-PROGRAM')).name).toBe('Otto');
  });

  it('refuses a request that leaves out a missing required role, whatever else it asks, and hires no one', async () => {
    const c = await company();
    await gone(c, 'OPS-PROGRAM', 'OPS-BUGS');
    const before = await staff(c.db, c.ops.id);
    const card = await oldCard(c, ['OPS-FIX']);
    const res = await apply(c, { proposalId: card, people: [lineOf(c, 'OPS-FIX'), lineOf(c, 'OPS-BUGS')] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.reason).toBe('staff_invalid');
    expect(res.json().error.message).toContain('Program operator');
    expect(res.json().error.message).not.toContain('Weak point collector');
    expect(await staff(c.db, c.ops.id)).toEqual(before);
    const [row] = await c.db.select().from(proposals).where(eq(proposals.id, card));
    expect(row!.status).toBe('pending');
  });

  it('lets another role in when the four are there', async () => {
    const c = await company();
    const res = await apply(c, { people: [lineOf(c, 'OPS-FIX', 'Fixer')] });
    expect(res.statusCode).toBe(201);
    expect((await staff(c.db, c.ops.id)).map(a => a.roleKey).sort()).toEqual([...FOUR, 'OPS-FIX'].sort());
  });

  it('does not ask another department for them', async () => {
    const c = await company();
    await gone(c, 'OPS-PROGRAM');
    expect((await apply(c, { people: [lineOf(c, 'DEV-HEAD')] }, c.dev.id)).statusCode).toBe(201);
  });

  it('applies an old card as far as it goes: no second head, no second of anyone Hornhoof hired meanwhile', async () => {
    const c = await company();
    const head = await holder(c, 'OPS-HEAD');
    const watch = await holder(c, 'OPS-WATCH');
    await c.db.update(agents).set({ name: 'Hanna' }).where(eq(agents.id, head.id));
    const card = await oldCard(c, ['OPS-HEAD', 'OPS-WATCH', 'OPS-FIX']);
    const res = await apply(c, { proposalId: card, people: [lineOf(c, 'OPS-HEAD', 'New head'), lineOf(c, 'OPS-WATCH', 'New watchdog'), lineOf(c, 'OPS-FIX', 'Fixer')] });
    expect(res.statusCode).toBe(201);
    expect(res.json().present).toEqual([{ role: 'OPS-HEAD', name: 'Hanna' }, { role: 'OPS-WATCH', name: watch.name }]);
    const after = await staff(c.db, c.ops.id);
    expect(after.filter(a => a.kind === 'head').map(a => a.id)).toEqual([head.id]);
    expect(after.filter(a => a.roleKey === 'OPS-WATCH').map(a => a.id)).toEqual([watch.id]);
    expect(after.filter(a => a.roleKey === 'OPS-FIX').map(a => a.name)).toEqual(['Fixer']);
    expect(res.json().hired).toEqual(after.filter(a => a.roleKey === 'OPS-FIX').map(a => a.id));
    const [row] = await c.db.select().from(proposals).where(eq(proposals.id, card));
    expect(row!.status).toBe('applied');
  });

  it('closes an old card with nobody left to hire, and tells the orchestrator who is there', async () => {
    const c = await company();
    const url = await listen(c.app);
    const builtin = await connectNode(url, NODE_KEY);
    builtin.send({ type: 'hello', version: '0.4.0', loggedIn: true, running: [] });
    await until(async () => (await c.app.inject({ url: '/api/agents/orchestrator/events', ...as(c.ceo) })).json().state.ready);
    const card = await oldCard(c, ['OPS-HEAD', 'OPS-WATCH']);
    const res = await apply(c, { proposalId: card, people: [lineOf(c, 'OPS-HEAD'), lineOf(c, 'OPS-WATCH')] });
    expect(res.statusCode).toBe(201);
    expect(res.json().hired).toEqual([]);
    expect((await staff(c.db, c.ops.id)).map(a => a.roleKey).sort()).toEqual(FOUR);
    const [row] = await c.db.select().from(proposals).where(eq(proposals.id, card));
    expect(row!.status).toBe('applied');
    const told = (await c.db.select().from(agentEvents).where(eq(agentEvents.kind, 'applied'))).find(e => (e.data as { proposalId?: string }).proposalId === card);
    expect(told!.data).toMatchObject({ proposalId: card, hired: [], present: [{ role: 'OPS-HEAD' }, { role: 'OPS-WATCH' }] });
    let run = await builtin.next();
    while (run.type !== 'job.run') run = await builtin.next();
    expect(run.prompt).toContain('Nobody new in Operations.');
    expect(run.prompt).toContain('Already there, so not hired again: Head of operations, Task watchdog.');
  });

  it('skips a line of an old card for a required role even when that line is bad, as it hires no one', async () => {
    const c = await company();
    const card = await oldCard(c, ['OPS-WATCH']);
    const res = await apply(c, { proposalId: card, people: [{ ...lineOf(c, 'OPS-WATCH'), subscription: '00000000-0000-4000-8000-000000000000' }] });
    expect(res.statusCode).toBe(201);
  });

  it('keeps refusing a second head without a card, and lets a second of the others in as a replacement', async () => {
    const c = await company();
    const second = await apply(c, { people: [lineOf(c, 'OPS-HEAD', 'Second head')] });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.message).toMatch(/already has a head/);
    const replacement = await apply(c, { people: [lineOf(c, 'OPS-WATCH', 'New watchdog')] });
    expect(replacement.statusCode).toBe(201);
    expect((await staff(c.db, c.ops.id)).filter(a => a.roleKey === 'OPS-WATCH')).toHaveLength(2);
  });

  it('holds the company while it reads who is there', async () => {
    const c = await company();
    const seen = statements();
    await apply(c, { people: [lineOf(c, 'OPS-FIX')] });
    const lock = seen.findIndex(s => /from "companies".*for update/i.test(s.sql));
    const look = seen.findIndex(s => /"role_key".*from "agents"/i.test(s.sql));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(look);
  });
});

describe('removing an employee of Operations', () => {
  const fire = (c: Company, id: string) => c.app.inject({ method: 'DELETE', url: `/api/agents/${id}`, ...as(c.ceo) });

  it.each(FOUR)('refuses the last %s, and keeps it', async role => {
    const c = await company();
    const last = await holder(c, role);
    const res = await fire(c, last.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.reason).toBe('required_role');
    expect((await c.db.select().from(agents).where(eq(agents.id, last.id)))[0]!.removedAt).toBeNull();
    expect(await c.db.select().from(agentChanges).where(and(eq(agentChanges.agentId, last.id), eq(agentChanges.field, 'removed')))).toEqual([]);
  });

  it('refuses an old head with no role key as the last head', async () => {
    const c = await company();
    const head = await holder(c, 'OPS-HEAD');
    await c.db.update(agents).set({ roleKey: null }).where(eq(agents.id, head.id));
    expect((await fire(c, head.id)).json().error.reason).toBe('required_role');
  });

  it('lets one go once a replacement is there, and then not the replacement', async () => {
    const c = await company();
    const old = await holder(c, 'OPS-WATCH');
    expect((await apply(c, { people: [lineOf(c, 'OPS-WATCH', 'New watchdog')] })).statusCode).toBe(201);
    expect((await fire(c, old.id)).statusCode).toBe(204);
    const fresh = await holder(c, 'OPS-WATCH');
    expect(fresh.name).toBe('New watchdog');
    expect((await fire(c, fresh.id)).statusCode).toBe(409);
  });

  it('counts a replacement who is switched off, but not one in another department', async () => {
    const c = await company();
    const old = await holder(c, 'OPS-WATCH');
    await c.db.insert(agents).values({ companyId: c.companyId, kind: 'worker', name: 'Elsewhere', model: '', departmentId: c.dev.id, roleKey: 'OPS-WATCH' });
    expect((await fire(c, old.id)).statusCode).toBe(409);
    await c.db.insert(agents).values({ companyId: c.companyId, kind: 'worker', name: 'Resting', model: '', departmentId: c.ops.id, roleKey: 'OPS-WATCH', switchedOffAt: new Date() });
    expect((await fire(c, old.id)).statusCode).toBe(204);
  });

  it('lets an extra employee of Operations, and a head of another department, go', async () => {
    const c = await company();
    const [extra] = await c.db.insert(agents).values({ companyId: c.companyId, kind: 'worker', name: 'Fixer', model: '', departmentId: c.ops.id, roleKey: 'OPS-FIX' }).returning();
    expect((await fire(c, extra!.id)).statusCode).toBe(204);
    const [head] = await c.db.insert(agents).values({ companyId: c.companyId, kind: 'head', name: 'Dev head', model: '', departmentId: c.dev.id, roleKey: 'DEV-HEAD' }).returning();
    expect((await fire(c, head!.id)).statusCode).toBe(204);
  });

  it('lets the last one be switched off', async () => {
    const c = await company();
    const last = await holder(c, 'OPS-PROGRAM');
    const res = await c.app.inject({ method: 'PATCH', url: `/api/agents/${last.id}`, payload: { on: false }, ...as(c.ceo) });
    expect(res.statusCode).toBe(200);
    expect((await holder(c, 'OPS-PROGRAM')).switchedOffAt).toBeInstanceOf(Date);
  });

  it('says it before saying anything about its tasks, but not before saying it works', async () => {
    const c = await company();
    const last = await holder(c, 'OPS-BUGS');
    await c.db.insert(tasks).values({ companyId: c.companyId, number: 901, title: 'T', brief: '', body: '', departmentId: c.ops.id, assigneeAgentId: last.id, status: 'open' });
    expect((await fire(c, last.id)).json().error.reason).toBe('agent_has_tasks');
    const [sub] = await c.db.select().from(subscriptions);
    await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: sub!.id, agentId: last.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running' });
    expect((await fire(c, last.id)).json().error.reason).toBe('agent_working');
  });
});
