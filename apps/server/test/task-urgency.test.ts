import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentRole, grantsFor, readerGrantsFor, readerRole, type SqlMode } from '../src/db/agent-sql.js';
import { MIGRATIONS } from '../src/db/client.js';
import { agents, companies, departments, jobs, people, subscriptions, taskEvents, tasks, teams, turns } from '../src/db/schema.js';
import { applyTeams } from '../src/modules/departments/routes.js';
import { cancel, createTask, submit, type NewTask } from '../src/modules/tasks/engine.js';
import { mayHoldTask, setUrgent, urgentOnlyAgents } from '../src/modules/tasks/urgency.js';
import { ONLY_CEO } from '../src/modules/tools/control.js';
import { as, createTestDb, invitePerson, listen, mcp, setUpCompany, testApp } from './helpers.js';

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Res;
const text = (r: Res) => r.content[0]!.text;
const reason = (p: Promise<unknown>) => p.then(() => 'ok', (err: { reason?: string }) => err.reason);

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
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  await hire('Sal', 'head', 'SAL-HEAD', sales!.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const simon = await hire('Simon', 'worker', 'DEV-BE');
  const [quick] = await db.insert(teams).values({ companyId, departmentId: dev!.id, name: 'Quick' }).returning();
  await db.update(agents).set({ teamId: quick!.id }).where(eq(agents.id, simon.id));
  let n = 0;
  /* Hornhoof's tools as a running turn of this agent sees them; a turn the CEO started answers the CEO. */
  const tools = async (agent: { id: string }, answersCeo = false) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token), answersCeo, createdBy: answersCeo ? ceo!.id : null });
    return mcp(app, token);
  };
  const CEO = { personId: ceo!.id };
  const root = async (more: Partial<NewTask> = {}, actor: Parameters<typeof createTask>[1] = CEO) =>
    (await createTask(app.ctx, actor, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head.id, ...more })).task;
  const under = async (parentId: string, more: Partial<NewTask> = {}) =>
    (await createTask(app.ctx, { agentId: head.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev!.id, parentId, assigneeAgentId: bruno.id, executor: true, ...more })).task;
  const read = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const elsewhere = async () => {
    const [other] = await db.insert(companies).values({ name: 'Other' }).returning();
    const [theirs] = await db.insert(departments).values({ companyId: other!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const [team] = await db.insert(teams).values({ companyId: other!.id, departmentId: theirs!.id, name: 'Theirs', urgentOnly: true }).returning();
    const [agent] = await db.insert(agents).values({ companyId: other!.id, kind: 'worker', name: 'Olga', roleKey: 'DEV-BE', departmentId: theirs!.id, teamId: team!.id, model: '' }).returning();
    const [task] = await db.insert(tasks).values({ companyId: other!.id, number: 1, title: 'Theirs', departmentId: theirs!.id }).returning();
    return { company: other!, department: theirs!, team: team!, agent: agent!, task: task! };
  };
  return { app, db, ctx: app.ctx, companyId, ceoToken, ceo: ceo!, CEO, orchestrator: orchestrator!, dev: dev!, sales: sales!, head, bruno, simon, quick: quick!, tools, root, under, read, elsewhere };
}

const makeTurn = (db: Awaited<ReturnType<typeof company>>['db'], companyId: string) =>
  db.insert(turns).values({ companyId, number: 4, title: 'Payments', goal: 'Card payments.', status: 'open', openedAt: new Date() });

describe('a new task', () => {
  it('is not urgent unless someone who may says so, whatever its title says', async () => {
    const c = await company();
    expect((await c.root({ title: 'URGENT: срочно, critical' }, { agentId: c.head.id })).urgent).toBe(false);
    const parent = await c.root();
    const client = await c.tools(c.head);
    const res = await call(client, 'create_task', { title: 'URGENT', brief: 'срочно', body: 'urgent', executor: c.simon.id, gates: [], parent: parent.number, urgent: true });
    expect(res.isError, text(res)).toBeFalsy();
    const [made] = await c.db.select().from(tasks).where(eq(tasks.title, 'URGENT'));
    expect(made!.urgent).toBe(false);
  });

  it('under an urgent task is urgent, at every depth', async () => {
    const c = await company();
    const top = await c.root({ urgent: true });
    const part = await c.under(top.id);
    const inner = await c.under(part.id, { title: 'Inner' });
    expect([top.urgent, part.urgent, inner.urgent]).toEqual([true, true, true]);
  });

  it('under a task that is not urgent is not urgent, whatever is asked', async () => {
    const c = await company();
    expect((await c.under((await c.root()).id, { urgent: true })).urgent).toBe(false);
  });

  it('that reviews a turn of urgent work is urgent too', async () => {
    const c = await company();
    await c.db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, c.dev.id));
    const [rita, rex] = await c.db
      .insert(agents)
      .values(['Rita', 'Rex'].map(name => ({ companyId: c.companyId, kind: 'worker' as const, name, roleKey: 'DEV-REV', departmentId: c.dev.id, model: '', subscriptionId: c.bruno.subscriptionId })))
      .returning();
    expect([rita, rex]).toHaveLength(2);
    await makeTurn(c.db, c.companyId);
    const top = await c.root({ urgent: true, riskClass: 'access' });
    const code = await c.under(top.id, { inTurnReview: true });
    await submit(c.ctx, c.bruno.id, code.id, { summary: 'Done.', evidence: 'npm test' });
    await submit(c.ctx, c.bruno.id, code.id, { summary: 'Merged.', evidence: 'git log: 1a2b3c4' });
    const [review] = await c.db.select().from(tasks).where(and(eq(tasks.companyId, c.companyId), eq(tasks.title, 'Review of turn 4')));
    expect(review!.urgent).toBe(true);
  });

  it.each(['head', 'worker'] as const)('with nothing above it is refused as urgent from a %s', async who => {
    const c = await company();
    const actor = { agentId: who === 'head' ? c.head.id : c.bruno.id };
    expect(await reason(c.root({ urgent: true }, actor))).toBe('urgent_not_allowed');
  });

  it('with nothing above it is urgent when the orchestrator or the CEO says so', async () => {
    const c = await company();
    expect((await c.root({ urgent: true }, { agentId: c.orchestrator.id })).urgent).toBe(true);
    expect((await c.root({ urgent: true })).urgent).toBe(true);
  });

  it('is refused as urgent from people and agents of another company', async () => {
    const c = await company();
    const { agent } = await c.elsewhere();
    const [theirOrchestrator] = await c.db.insert(agents).values({ companyId: agent.companyId, kind: 'orchestrator', name: 'Theirs', roleKey: 'ORCH', model: '' }).returning();
    expect(await reason(c.root({ urgent: true }, { agentId: theirOrchestrator!.id }))).toBe('urgent_not_allowed');
  });
});

describe('the task route', () => {
  it('takes urgent only from the CEO or the CEO delegate', async () => {
    const c = await company();
    const post = (token: string, urgent?: unknown) => c.app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Fix', department: c.dev.id, ...(urgent === undefined ? {} : { urgent }) }, ...as(token) });
    const whole = await invitePerson(c.app, c.ceoToken, { name: 'Wes', email: 'wes@acme.com', access: { whole: true } });
    const listed = await invitePerson(c.app, c.ceoToken, { name: 'Lee', email: 'lee@acme.com', access: { departments: [c.dev.id] } });
    const made = await post(c.ceoToken, true);
    expect(made.statusCode).toBe(201);
    expect(made.json().task.urgent).toBe(true);
    expect((await post(c.ceoToken)).json().task.urgent).toBe(false);
    expect((await post(whole, true)).statusCode).toBe(403);
    expect((await post(listed, true)).statusCode).toBe(403);
    expect((await post(listed)).json().task.urgent).toBe(false);
    expect((await post(c.ceoToken, 'yes')).statusCode).toBe(400);
  });

  it('sets a task urgent for the CEO, and for nobody else or in another company', async () => {
    const c = await company();
    const top = await c.root();
    const put = (id: string, token: string, urgent: unknown = true) => c.app.inject({ method: 'PUT', url: `/api/tasks/${id}/urgent`, payload: { urgent }, ...as(token) });
    const whole = await invitePerson(c.app, c.ceoToken, { name: 'Wes', email: 'wes@acme.com', access: { whole: true } });
    expect((await put(top.id, whole)).statusCode).toBe(403);
    expect((await c.read(top.id)).urgent).toBe(false);
    expect((await put((await c.elsewhere()).task.id, c.ceoToken)).statusCode).toBe(404);
    expect((await put(top.id, c.ceoToken, 'yes')).statusCode).toBe(400);
    const set = await put(top.id, c.ceoToken);
    expect(set.statusCode).toBe(200);
    expect(set.json().task.urgent).toBe(true);
  });
});

describe('the orchestrator', () => {
  const item = (c: Awaited<ReturnType<typeof company>>, title: string, urgent?: boolean) => ({ department: c.dev.id, title, brief: '', body: '', ...(urgent === undefined ? {} : { urgent }) });

  it('lays out urgent tasks only in a turn that answers the CEO', async () => {
    const c = await company();
    const woken = await c.tools(c.orchestrator);
    const refused = await call(woken, 'plan_turn', { title: 'Fix', goal: 'Fix it.', tasks: [item(c, 'Forged', true)] });
    expect(text(refused)).toBe(ONLY_CEO);
    expect(await c.db.select().from(tasks).where(eq(tasks.title, 'Forged'))).toEqual([]);
    const plain = await call(woken, 'plan_turn', { title: 'Plain', goal: 'Plain work.', tasks: [item(c, 'Plain work')] });
    expect(plain.isError, text(plain)).toBeFalsy();
    const answering = await c.tools(c.orchestrator, true);
    const urgent = await call(answering, 'add_tasks', { turn: 1, tasks: [item(c, 'Real', true)] });
    expect(urgent.isError, text(urgent)).toBeFalsy();
    const rows = await c.db.select().from(tasks);
    expect(rows.find(t => t.title === 'Real')!.urgent).toBe(true);
    expect(rows.find(t => t.title === 'Plain work')!.urgent).toBe(false);
    expect(text(await call(woken, 'add_tasks', { turn: 1, tasks: [item(c, 'Forged again', true)] }))).toBe(ONLY_CEO);
  });

  it('alone has set_urgent and set_team_urgent_only', async () => {
    const c = await company();
    const names = async (agent: { id: string }) => (await (await c.tools(agent)).listTools()).tools.map(t => t.name);
    expect(await names(c.orchestrator)).toEqual(expect.arrayContaining(['set_urgent', 'set_team_urgent_only']));
    for (const agent of [c.head, c.bruno]) {
      const has = await names(agent);
      expect(has).not.toContain('set_urgent');
      expect(has).not.toContain('set_team_urgent_only');
    }
  });

  it('sets a task urgent, only in a turn that answers the CEO, with all that is under it', async () => {
    const c = await company();
    const top = await c.root();
    const part = await c.under(top.id);
    expect(text(await call(await c.tools(c.orchestrator), 'set_urgent', { task: top.number, urgent: true }))).toBe(ONLY_CEO);
    expect((await c.read(top.id)).urgent).toBe(false);
    const res = await call(await c.tools(c.orchestrator, true), 'set_urgent', { task: top.number, urgent: true });
    expect(res.isError, text(res)).toBeFalsy();
    expect([(await c.read(top.id)).urgent, (await c.read(part.id)).urgent]).toEqual([true, true]);
  });

  it('sets a team to urgent work only, only in a turn that answers the CEO', async () => {
    const c = await company();
    const args = { department: c.dev.id, team: c.quick.id, urgentOnly: true };
    expect(text(await call(await c.tools(c.orchestrator), 'set_team_urgent_only', args))).toBe(ONLY_CEO);
    expect((await c.db.select().from(teams).where(eq(teams.id, c.quick.id)))[0]!.urgentOnly).toBe(false);
    const res = await call(await c.tools(c.orchestrator, true), 'set_team_urgent_only', args);
    expect(res.isError, text(res)).toBeFalsy();
    expect((await c.db.select().from(teams).where(eq(teams.id, c.quick.id)))[0]!.urgentOnly).toBe(true);
  });
});

describe('setting a task urgent', () => {
  it('takes all that is under it along, both ways, closed work too, and what comes later follows', async () => {
    const c = await company();
    const top = await c.root();
    const part = await c.under(top.id);
    const inner = await c.under(part.id, { title: 'Inner' });
    const closed = await c.under(top.id, { title: 'Closed' });
    await cancel(c.ctx, c.CEO, closed.id, 'Not needed.');
    await setUrgent(c.ctx, c.CEO, top.id, true);
    const urgency = async () => Promise.all([top, part, inner, closed].map(async t => (await c.read(t.id)).urgent));
    expect(await urgency()).toEqual([true, true, true, true]);
    expect((await c.under(inner.id, { title: 'Later' })).urgent).toBe(true);
    await setUrgent(c.ctx, c.CEO, top.id, false);
    expect(await urgency()).toEqual([false, false, false, false]);
  });

  it('wakes nobody and takes no move from those who read the task, and the log says who did it', async () => {
    const c = await company();
    const top = await c.root();
    const moved = await setUrgent(c.ctx, { agentId: c.orchestrator.id }, top.id, true);
    expect(moved.wakes).toEqual([]);
    const after = await c.read(top.id);
    expect(after.version).toBe(top.version);
    expect(after.assigneeAgentId).toBe(top.assigneeAgentId);
    const log = await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, top.id)).orderBy(taskEvents.id);
    expect(log.at(-1)).toMatchObject({ kind: 'updated', agentId: c.orchestrator.id, data: { fields: ['urgent'], urgent: true } });
  });

  it('leaves the rest of the company as it is', async () => {
    const c = await company();
    const other = await c.root({ title: 'Other work' });
    const { task } = await c.elsewhere();
    await setUrgent(c.ctx, c.CEO, (await c.root()).id, true);
    expect((await c.read(other.id)).urgent).toBe(false);
    expect((await c.read(task.id)).urgent).toBe(false);
  });

  it('is refused for work under another task, which follows the task above it', async () => {
    const c = await company();
    const part = await c.under((await c.root()).id);
    expect(await reason(setUrgent(c.ctx, c.CEO, part.id, true))).toBe('urgent_follows_parent');
    expect((await c.read(part.id)).urgent).toBe(false);
  });

  it('is refused for a closed task', async () => {
    const c = await company();
    const top = await c.root();
    await cancel(c.ctx, c.CEO, top.id, 'Not needed.');
    expect(await reason(setUrgent(c.ctx, c.CEO, top.id, true))).toBe('task_invalid');
  });

  it('is refused to a head, a worker and a person who does not act as the CEO', async () => {
    const c = await company();
    const top = await c.root();
    const [person] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Wes', email: 'wes@acme.com', scopeKind: 'company' }).returning();
    for (const actor of [{ agentId: c.head.id }, { agentId: c.bruno.id }, { personId: person!.id }]) {
      expect(await reason(setUrgent(c.ctx, actor, top.id, true))).toBe('urgent_not_allowed');
    }
    expect((await c.read(top.id)).urgent).toBe(false);
  });

  it('is refused for a task of another company, and from another company', async () => {
    const c = await company();
    const { task } = await c.elsewhere();
    expect(await reason(setUrgent(c.ctx, c.CEO, task.id, true))).toBe('urgent_not_allowed');
    expect((await c.read(task.id)).urgent).toBe(false);
  });
});

describe('what people and agents read', () => {
  it('tells of a task\'s urgency in its line and in full', async () => {
    const c = await company();
    const top = await c.root({ urgent: true });
    const client = await c.tools(c.orchestrator);
    expect(JSON.parse(text(await call(client, 'task', { task: top.number }))).urgent).toBe(true);
    expect((JSON.parse(text(await call(client, 'tasks', {}))) as { number: number; urgent: boolean }[]).find(t => t.number === top.number)!.urgent).toBe(true);
    expect((await c.app.inject({ url: `/api/tasks/${top.id}`, ...as(c.ceoToken) })).json().task.urgent).toBe(true);
  });

  it('tells of a team\'s urgency in the company and the map', async () => {
    const c = await company();
    await c.db.update(teams).set({ urgentOnly: true }).where(eq(teams.id, c.quick.id));
    const inCompany = JSON.parse(text(await call(await c.tools(c.head), 'company', {}))) as { departments: { id: string; teams: { id: string; urgentOnly: boolean }[] }[] };
    expect(inCompany.departments.find(d => d.id === c.dev.id)!.teams).toEqual([{ id: c.quick.id, name: 'Quick', urgentOnly: true }]);
    const org = (await c.app.inject({ url: '/api/org', ...as(c.ceoToken) })).json() as { departments: { id: string; teams: { id: string; urgentOnly: boolean }[] }[] };
    expect(org.departments.find(d => d.id === c.dev.id)!.teams[0]!.urgentOnly).toBe(true);
  });
});

describe('a team that takes only urgent work', () => {
  const teamUrl = (c: Awaited<ReturnType<typeof company>>, department = c.dev.id, team = c.quick.id) => `/api/departments/${department}/teams/${team}`;

  it('is not one unless set, also when made new', async () => {
    const c = await company();
    const made = await c.app.inject({ method: 'POST', url: `/api/departments/${c.dev.id}/teams`, payload: { name: 'New' }, ...as(c.ceoToken) });
    expect(made.json().team.urgentOnly).toBe(false);
  });

  it('is set and cleared by whoever may change the team, and keeps its name', async () => {
    const c = await company();
    const on = await c.app.inject({ method: 'PATCH', url: teamUrl(c), payload: { urgentOnly: true }, ...as(c.ceoToken) });
    expect(on.statusCode).toBe(200);
    expect(on.json().team).toMatchObject({ name: 'Quick', urgentOnly: true });
    const off = await c.app.inject({ method: 'PATCH', url: teamUrl(c), payload: { urgentOnly: false }, ...as(c.ceoToken) });
    expect(off.json().team).toMatchObject({ name: 'Quick', urgentOnly: false });
  });

  it('keeps it when renamed, by the route and by a change of structure', async () => {
    const c = await company();
    await c.db.update(teams).set({ urgentOnly: true }).where(eq(teams.id, c.quick.id));
    const renamed = await c.app.inject({ method: 'PATCH', url: teamUrl(c), payload: { name: 'Faster' }, ...as(c.ceoToken) });
    expect(renamed.json().team).toMatchObject({ name: 'Faster', urgentOnly: true });
    await applyTeams(c.db, c.ceo, c.dev.id, [{ id: c.quick.id, name: 'Fastest' }]);
    expect((await c.db.select().from(teams).where(eq(teams.id, c.quick.id)))[0]).toMatchObject({ name: 'Fastest', urgentOnly: true });
  });

  it('refuses a person without the whole company, an empty change and another word for yes', async () => {
    const c = await company();
    const listed = await invitePerson(c.app, c.ceoToken, { name: 'Lee', email: 'lee@acme.com', access: { departments: [c.dev.id] } });
    expect((await c.app.inject({ method: 'PATCH', url: teamUrl(c), payload: { urgentOnly: true }, ...as(listed) })).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'PATCH', url: teamUrl(c), payload: {}, ...as(c.ceoToken) })).statusCode).toBe(400);
    expect((await c.app.inject({ method: 'PATCH', url: teamUrl(c), payload: { urgentOnly: 'yes' }, ...as(c.ceoToken) })).statusCode).toBe(400);
    expect((await c.db.select().from(teams).where(eq(teams.id, c.quick.id)))[0]!.urgentOnly).toBe(false);
  });

  it('is not reached through another department or company', async () => {
    const c = await company();
    const { department, team } = await c.elsewhere();
    expect((await c.app.inject({ method: 'PATCH', url: teamUrl(c, c.sales.id), payload: { urgentOnly: true }, ...as(c.ceoToken) })).statusCode).toBe(404);
    expect((await c.app.inject({ method: 'PATCH', url: teamUrl(c, department.id, team.id), payload: { urgentOnly: false }, ...as(c.ceoToken) })).statusCode).toBe(404);
    expect((await c.db.select().from(teams).where(eq(teams.id, team.id)))[0]!.urgentOnly).toBe(true);
  });
});

describe('who may hold what', () => {
  it.each([
    [false, false, true],
    [true, false, true],
    [true, true, true],
    [false, true, false],
  ])('a task urgent %s and a holder urgent only %s: %s', (urgent, urgentOnly, may) => {
    expect(mayHoldTask({ urgent }, { urgentOnly })).toBe(may);
  });

  it('follows the team an agent is in now, and that team\'s flag', async () => {
    const c = await company();
    const only = () => urgentOnlyAgents(c.db, c.companyId, [c.simon.id, c.bruno.id]);
    expect([...(await only())]).toEqual([]);
    await c.db.update(teams).set({ urgentOnly: true }).where(eq(teams.id, c.quick.id));
    expect([...(await only())]).toEqual([c.simon.id]);
    await c.db.update(agents).set({ teamId: c.quick.id }).where(eq(agents.id, c.bruno.id));
    expect([...(await only())].sort()).toEqual([c.simon.id, c.bruno.id].sort());
    await c.db.update(agents).set({ teamId: null }).where(eq(agents.id, c.simon.id));
    expect([...(await only())]).toEqual([c.bruno.id]);
    await c.db.update(teams).set({ urgentOnly: false }).where(eq(teams.id, c.quick.id));
    expect([...(await only())]).toEqual([]);
  });

  it('asks nothing of no agents, and stays in its company', async () => {
    const c = await company();
    const { agent } = await c.elsewhere();
    expect([...(await urgentOnlyAgents(c.db, c.companyId, []))]).toEqual([]);
    expect([...(await urgentOnlyAgents(c.db, c.companyId, [agent.id]))]).toEqual([]);
    expect([...(await urgentOnlyAgents(c.db, agent.companyId, [agent.id]))]).toEqual([agent.id]);
  });
});

describe('the SQL roles', () => {
  async function roles() {
    const { $client: client } = await createTestDb();
    const names = { write: agentRole('postgres'), read: readerRole('postgres') };
    await client.exec(`${grantsFor(names.write)};\n${readerGrantsFor(names.read)}`);
    return (mode: SqlMode, statement: string) => client.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE "${names[mode]}"`);
      return tx.exec(statement);
    });
  }

  it.each(['write', 'read'] as const)('read urgency and never write it: %s', async mode => {
    const run = await roles();
    expect((await run(mode, 'SELECT urgent FROM tasks'))[0]!.rows).toEqual([]);
    expect((await run(mode, 'SELECT urgent_only FROM teams'))[0]!.rows).toEqual([]);
    for (const write of [
      'UPDATE tasks SET urgent = true WHERE false',
      'INSERT INTO tasks (company_id, number, title, urgent) SELECT company_id, number, title, true FROM tasks WHERE false',
      'UPDATE teams SET urgent_only = true WHERE false',
      'INSERT INTO teams (company_id, department_id, name, urgent_only) SELECT company_id, department_id, name, true FROM teams WHERE false',
    ]) await expect(run(mode, write)).rejects.toThrow(/permission denied/);
  });

  it('keep the orchestrator\'s other rights on tasks and teams', async () => {
    const run = await roles();
    for (const write of [
      "UPDATE tasks SET title = 'x', status = 'open' WHERE false",
      'INSERT INTO tasks (company_id, number, title) SELECT company_id, number, title FROM tasks WHERE false',
      'DELETE FROM tasks WHERE false',
      "UPDATE teams SET name = 'x' WHERE false",
      'INSERT INTO teams (company_id, department_id, name) SELECT company_id, department_id, name FROM teams WHERE false',
      'DELETE FROM teams WHERE false',
    ]) await expect(run('write', write)).resolves.toBeDefined();
  });
});

describe('the migration', () => {
  it('leaves old rows as they were, none of them urgent, and names no company', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hh-urgent-upgrade-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    await cp(MIGRATIONS, directory, { recursive: true });
    const file = join(directory, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(file, 'utf8')) as { entries: { tag: string }[] };
    const at = journal.entries.findIndex(entry => entry.tag.endsWith('_urgent_work'));
    expect(at).toBeGreaterThan(0);
    const target = journal.entries.slice(0, at + 1);
    journal.entries = target.slice(0, -1);
    await writeFile(file, JSON.stringify(journal));
    const client = new PGlite();
    onTestFinished(() => client.close());
    await migrate(drizzle(client), { migrationsFolder: directory });
    const ids = { company: '00000000-0000-4000-8000-000000000001', department: '00000000-0000-4000-8000-000000000002', team: '00000000-0000-4000-8000-000000000003' };
    await client.exec(`
      INSERT INTO companies (id, name) VALUES ('${ids.company}', 'Retained');
      INSERT INTO departments (id, company_id, template_key, role_code, name) VALUES ('${ids.department}', '${ids.company}', 'development', 'DEV', 'Retained');
      INSERT INTO teams (id, company_id, department_id, name, about, stage, gate) VALUES ('${ids.team}', '${ids.company}', '${ids.department}', 'Tiger Team', 'kept', 2, true);
      INSERT INTO tasks (company_id, number, title, brief, body, department_id, work_kind) VALUES ('${ids.company}', 7, 'URGENT old', 'срочно', 'kept', '${ids.department}', 'bug');
    `);
    const rows = async () => ({
      tasks: (await client.query<{ row: Record<string, unknown> }>('SELECT to_jsonb(t) AS row FROM tasks t')).rows.map(({ row }) => row),
      teams: (await client.query<{ row: Record<string, unknown> }>('SELECT to_jsonb(t) AS row FROM teams t')).rows.map(({ row }) => row),
    });
    const before = await rows();
    journal.entries = target;
    await writeFile(file, JSON.stringify(journal));
    await migrate(drizzle(client), { migrationsFolder: directory });
    const after = await rows();
    expect(after.tasks).toEqual(before.tasks.map(row => ({ ...row, urgent: false })));
    expect(after.teams).toEqual(before.teams.map(row => ({ ...row, urgent_only: false })));
    const sql = await readFile(join(directory, `${target.at(-1)!.tag}.sql`), 'utf8');
    expect(sql).not.toMatch(/INSERT|UPDATE|Tiger|[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});
