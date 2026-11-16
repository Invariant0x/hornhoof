import { eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, people, personAccess, proposals, subscriptions, tasks, teams } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { as, connectNode, invitePerson, listen, openStream, SETUP, setUpCompany, statements, TEST_API_KEY, testApp, until, type FakeNode } from './helpers.js';
import { rowsRead, statementReads } from './rows-read.js';
import { applyTeams } from '../src/modules/departments/routes.js';
import { checkItems } from '../src/modules/tools/structure.js';

const NODE_KEY = 'k'.repeat(40);

const ITEMS = [
  { template: 'operations', note: 'Tools and accounts' },
  { template: 'development', note: 'Builds both products', products: ['Mascot', 'Characters'] },
  { template: 'design', note: 'Characters need a look' },
  { template: 'marketing', note: 'Schools need to hear of it' },
  { template: 'sales', note: 'Sells to schools' },
];

async function withOrchestrator() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
  await until(async () => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(ceo) })).json().state.ready);
  const [acme] = await db.select().from(companies);
  const [orchestrator] = await db.select().from(agents);
  return { app, db, ceo, builtin, acme: acme!, orchestrator: orchestrator! };
}

const build = (app: Awaited<ReturnType<typeof testApp>>['app'], token: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/departments/build', payload, ...as(token) });

async function nextPrompt(node: FakeNode): Promise<string> {
  const m = await node.next();
  if (m.type !== 'job.run') throw new Error(`Expected job.run, got ${m.type}`);
  return m.prompt;
}

describe('POST /api/departments/build', () => {
  it('builds the proposed departments with their products and tells the orchestrator', async () => {
    const { app, db, ceo, builtin, acme, orchestrator } = await withOrchestrator();
    const [proposal] = await db.insert(proposals).values({ companyId: acme.id, agentId: orchestrator.id, brief: 'Acme makes characters for schools.', items: ITEMS }).returning();
    const stream = await openStream(app, ceo);

    const res = await build(app, ceo, { proposalId: proposal!.id, items: ITEMS });
    expect(res.statusCode).toBe(201);
    expect(res.json().created).toHaveLength(5);
    expect(res.json().removed).toEqual([]);

    const all = await db.select().from(departments);
    const top = all.filter(d => !d.parentId).sort((a, b) => a.position - b.position);
    expect(top.map(d => [d.templateKey, d.name, d.roleCode])).toEqual([
      ['operations', null, 'OPS'],
      ['development', null, 'DEV'],
      ['design', null, 'DSN'],
      ['marketing', null, 'MKT'],
      ['sales', null, 'SAL'],
    ]);
    expect(top[1]!.about).toBe('Builds both products');
    const products = all.filter(d => d.parentId === top[1]!.id);
    expect(products.map(d => [d.name, d.roleCode]).sort()).toEqual([['Characters', 'DEV'], ['Mascot', 'DEV']]);

    const [after] = await db.select().from(proposals);
    expect(after).toMatchObject({ status: 'applied', appliedBy: expect.any(String) });
    expect((await db.select().from(companies))[0]!.brief).toBe('Acme makes characters for schools.');

    const [applied] = await db.select().from(agentEvents).where(eq(agentEvents.kind, 'applied'));
    expect(applied!.data).toMatchObject({ proposalId: proposal!.id, removed: [] });
    expect((applied!.data as { created: { template: string; products: string[] }[] }).created[1]).toMatchObject({ template: 'development', products: ['Mascot', 'Characters'] });
    expect(applied!.personId).not.toBeNull();

    await until(() => stream.messages.filter(m => m.type === 'pulse').length === 5);
    expect(stream.messages.some(m => m.type === 'org')).toBe(true);
    const note = await nextPrompt(builtin);
    expect(note).toContain('Hornhoof applied the CEO\'s click.');
    expect(note).toContain('Development (products: Mascot, Characters)');
    expect(note).toContain('offer to staff the new departments, one department at a time');
  });

  /* Development with Dana as its owner, who changes it from her screen. */
  async function ownedByDana() {
    const made = await withOrchestrator();
    const [dev] = await made.db.insert(departments).values({ companyId: made.acme.id, templateKey: 'development', roleCode: 'DEV', position: 1 }).returning();
    const dana = await invitePerson(made.app, made.ceo, { name: 'Dana', email: 'dana@acme.com', access: { departments: [dev!.id] } });
    const [person] = await made.db.select(idOnly(people)).from(people).where(eq(people.name, 'Dana'));
    expect((await made.app.inject({ method: 'PUT', url: `/api/departments/${dev!.id}/owner`, payload: { personId: person!.id }, ...as(made.ceo) })).statusCode).toBe(200);
    return { ...made, dev: dev!, dana };
  }

  it('tells the orchestrator who clicked when the owner of a department changes it, not the CEO', async () => {
    const { app, builtin, dev, dana } = await ownedByDana();
    expect((await build(app, dana, { items: [{ department: dev.id, products: ['App'] }] })).statusCode).toBe(201);
    const note = await nextPrompt(builtin);
    expect(note).toContain('Hornhoof applied the click of Dana, responsible for Development.');
    expect(note).not.toContain('CEO\'s click');
  });

  it('tells the orchestrator who clicked when the owner of a department hires in it, not the CEO', async () => {
    const { app, builtin, dev, dana } = await ownedByDana();
    const skills = app.ctx.templates.roles.get('DEV-BE')!.skills.filter(s => s.on).map(s => s.id);
    const hired = await app.inject({ method: 'POST', url: `/api/departments/${dev.id}/staff`, payload: { people: [{ role: 'DEV-BE', name: 'Ira', model: '', subscription: null, skills }] }, ...as(dana) });
    expect(hired.statusCode, hired.body).toBe(201);
    const note = await nextPrompt(builtin);
    expect(note).toContain('Hornhoof applied the click of Dana, responsible for Development.');
    expect(note).toContain('Hired in Development: Ira');
    expect(note).not.toContain('CEO\'s click');
  });

  it('applies a proposal only once', async () => {
    const { app, db, ceo, acme, orchestrator } = await withOrchestrator();
    const [proposal] = await db.insert(proposals).values({ companyId: acme.id, agentId: orchestrator.id, brief: 'Acme.', items: ITEMS }).returning();
    expect((await build(app, ceo, { proposalId: proposal!.id, items: ITEMS })).statusCode).toBe(201);
    const again = await build(app, ceo, { proposalId: proposal!.id, items: ITEMS });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.reason).toBe('proposal_closed');
    expect(await db.select().from(departments)).toHaveLength(7);
  });

  it('builds by hand when the orchestrator has no subscription, and queues nothing', async () => {
    const { app, db } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'later' } } });
    const ceo = res.cookies[0]!.value;
    const built = await build(app, ceo, { items: [{ template: 'sales', note: '' }] });
    expect(built.statusCode).toBe(201);
    expect(await db.select().from(departments)).toHaveLength(2);
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it('removes an empty department and keeps Operations', async () => {
    const { app, db, ceo } = await withOrchestrator();
    await build(app, ceo, { items: [{ template: 'operations' }, { template: 'finance' }] });
    const [finance] = await db.select().from(departments).where(eq(departments.templateKey, 'finance'));
    const [ops] = await db.select().from(departments).where(eq(departments.templateKey, 'operations'));

    const removed = await build(app, ceo, { items: [{ department: finance!.id, note: 'Not yet', remove: true }] });
    expect(removed.statusCode).toBe(201);
    expect(removed.json().removed).toEqual([finance!.id]);
    expect(await db.select().from(departments).where(isNull(departments.parentId))).toHaveLength(1);

    const refused = await build(app, ceo, { items: [{ department: ops!.id, note: '', remove: true }] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.reason).toBe('structure_invalid');
    expect(refused.json().error.message).toContain('Operations');
  });

  it('removes a product that once had an employee, and keeps one that has one', async () => {
    const { app, db, ceo, acme } = await withOrchestrator();
    await build(app, ceo, { items: [{ template: 'operations' }, { template: 'development', products: ['Mascot', 'Characters'] }] });
    const [dev] = await db.select().from(departments).where(eq(departments.templateKey, 'development'));
    const [mascot] = await db.select().from(departments).where(eq(departments.name, 'Mascot'));
    const [characters] = await db.select().from(departments).where(eq(departments.name, 'Characters'));
    const hire = (name: string, productId: string, removedAt: Date | null) =>
      db.insert(agents).values({ companyId: acme.id, kind: 'worker', name, roleKey: 'DEV-FE', departmentId: dev!.id, productId, model: '', removedAt });
    await hire('Ira', mascot!.id, new Date());
    await hire('Lev', characters!.id, null);
    const kept = await build(app, ceo, { items: [{ department: characters!.id, note: '', remove: true }] });
    expect(kept.statusCode).toBe(400);
    expect(kept.json().error.message).toContain('has agents');
    const removed = await build(app, ceo, { items: [{ department: mascot!.id, note: 'Renamed', remove: true }] });
    expect(removed.statusCode).toBe(201);
    expect((await db.select().from(agents).where(eq(agents.name, 'Ira')))[0]!.productId).toBe(null);
  });

  it('keeps a department that people work in', async () => {
    const { app, db, ceo } = await withOrchestrator();
    await build(app, ceo, { items: [{ template: 'operations' }, { template: 'support' }] });
    const [support] = await db.select().from(departments).where(eq(departments.templateKey, 'support'));
    await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [support!.id] } });
    const refused = await build(app, ceo, { items: [{ department: support!.id, note: '', remove: true }] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.reason).toBe('structure_invalid');
  });

  it('refuses removing or renaming a sub-unit of another department and keeps its access and subscription target', async () => {
    const { app, db, ceo, acme } = await withOrchestrator();
    await build(app, ceo, { items: [{ template: 'development' }, { template: 'sales' }] });
    const [dev] = await db.select().from(departments).where(eq(departments.templateKey, 'development'));
    const [sales] = await db.select().from(departments).where(eq(departments.templateKey, 'sales'));
    const [inbound] = await db.insert(teams).values({ companyId: acme.id, departmentId: sales!.id, name: 'Inbound' }).returning();
    await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { teams: [inbound!.id] } });
    const keyRes = await app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      payload: { provider: 'anthropic_api', kind: 'api_key', label: 'Inbound key', apiKey: TEST_API_KEY, target: { kind: 'team', id: inbound!.id } },
      ...as(ceo),
    });
    expect(keyRes.statusCode).toBe(201);
    const keyId = keyRes.json().subscription.id as string;

    const removeForeign = await build(app, ceo, {
      items: [{ department: dev!.id, note: '', teams: ['Valid team', { id: inbound!.id, remove: true }] }],
    });
    expect(removeForeign.statusCode).toBe(400);
    expect(removeForeign.json().error.reason).toBe('structure_invalid');

    const renameForeign = await build(app, ceo, {
      items: [{ department: dev!.id, note: '', teams: [{ id: inbound!.id, name: 'Stolen' }] }],
    });
    expect(renameForeign.statusCode).toBe(400);
    expect(renameForeign.json().error.reason).toBe('structure_invalid');

    const deleteRoute = await app.inject({ method: 'DELETE', url: `/api/departments/${dev!.id}/teams/${inbound!.id}`, ...as(ceo) });
    expect(deleteRoute.statusCode).toBe(404);
    expect(deleteRoute.json().error.reason).toBe('unknown_place');

    const [ceoPerson] = await db.select().from(people).where(eq(people.isOwner, true));
    await expect(
      db.transaction(tx => applyTeams(tx, ceoPerson!, dev!.id, ['Rolled back', { id: inbound!.id, remove: true }])),
    ).rejects.toMatchObject({ status: 404, reason: 'unknown_place' });
    await expect(
      db.transaction(tx => applyTeams(tx, ceoPerson!, dev!.id, ['Rolled back', { id: inbound!.id, name: 'Stolen' }])),
    ).rejects.toMatchObject({ status: 404, reason: 'unknown_place' });

    expect(await db.select().from(teams).where(eq(teams.departmentId, dev!.id))).toEqual([]);
    const [stillThere] = await db.select().from(teams).where(eq(teams.id, inbound!.id));
    expect(stillThere).toMatchObject({ departmentId: sales!.id, name: 'Inbound' });
    expect(await db.select().from(personAccess).where(eq(personAccess.teamId, inbound!.id))).toHaveLength(1);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, keyId));
    expect(sub).toMatchObject({ targetKind: 'team', targetId: inbound!.id });

    const renameOwn = await build(app, ceo, { items: [{ department: sales!.id, note: '', teams: [{ id: inbound!.id, name: 'Inbound EU' }] }] });
    expect(renameOwn.statusCode).toBe(201);
    const removeOwn = await build(app, ceo, { items: [{ department: sales!.id, note: '', teams: [{ id: inbound!.id, remove: true }] }] });
    expect(removeOwn.statusCode).toBe(201);
    expect(await db.select().from(teams).where(eq(teams.id, inbound!.id))).toEqual([]);
  });

  it('is only for people who see the whole company', async () => {
    const { app, db, ceo, acme } = await withOrchestrator();
    const [sales] = await db.insert(departments).values({ companyId: acme.id, name: 'Sales', roleCode: 'SAL' }).returning();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
    const res = await build(app, maria, { items: [{ template: 'operations' }] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.reason).toBe('company_scope_only');
  });
});

describe('removing a department of a company with a long history', () => {
  /* Development's 40 closed tasks, the one left open, and a few for the index to step over. */
  const DEV_TASKS = 50;

  /* Development with its products Mascot and Characters among four other departments, 2000 closed tasks of those, 40 of
     Development, and 20 open tasks of the other departments. */
  async function longHistory() {
    const c = await withOrchestrator();
    const { app, db, ceo, acme } = c;
    await build(app, ceo, { items: ITEMS });
    const all = await db.select().from(departments);
    const byName = (template: string) => all.find(d => d.templateKey === template)!;
    const dev = byName('development');
    const mascot = all.find(d => d.name === 'Mascot')!;
    const characters = all.find(d => d.name === 'Characters')!;
    const others = ['operations', 'design', 'marketing', 'sales'].map(byName);
    const closedAt = new Date(Date.now() - 86_400_000);
    let number = 10_000;
    for (let from = 0; from < 2000; from += 500) {
      await db.insert(tasks).values(Array.from({ length: 500 }, (_, k) => ({ companyId: acme.id, number: number++, departmentId: others[(from + k) % 4]!.id, title: `Old ${from + k}`, status: 'done' as const, closedAt })));
    }
    const productOf = (i: number) => (i % 4 === 0 ? mascot.id : i % 4 === 1 ? characters.id : null);
    const devTasks = await db
      .insert(tasks)
      .values(Array.from({ length: 40 }, (_, i) => ({ companyId: acme.id, number: number++, departmentId: dev.id, productId: productOf(i), title: `Dev ${i}`, status: i % 2 ? ('done' as const) : ('cancelled' as const), closedAt })))
      .returning({ id: tasks.id });
    /* A database holds one company, so the open work elsewhere is in its other departments. */
    await db.insert(tasks).values(Array.from({ length: 20 }, (_, i) => ({ companyId: acme.id, number: number++, departmentId: others[i % 4]!.id, title: `Elsewhere ${i}`, status: 'open' as const })));
    return { ...c, dev, mascot, characters, others, devTasks: devTasks.map(t => t.id) };
  }

  /* Where every task stands: its department and product. */
  const places = async (db: Awaited<ReturnType<typeof longHistory>>['db']) =>
    new Map((await db.select({ id: tasks.id, departmentId: tasks.departmentId, productId: tasks.productId }).from(tasks)).map(t => [t.id, `${t.departmentId}/${t.productId}`]));

  it('keeps a product with an open task, then removes it and its whole department as before', async () => {
    const h = await longHistory();
    const { app, db, ceo, acme, dev, mascot, characters } = h;
    const [open] = await db.insert(tasks).values({ companyId: acme.id, number: 99_999, departmentId: dev.id, productId: characters.id, title: 'Open on Characters', status: 'open' }).returning();
    const kept = await build(app, ceo, { items: [{ department: characters.id, note: '', remove: true }] });
    expect(kept.statusCode).toBe(400);
    expect(kept.json().error.message).toContain('has open tasks');

    /* Open tasks of other departments do not keep Mascot. */
    const before = await places(db);
    const mascotGone = await build(app, ceo, { items: [{ department: mascot.id, note: '', remove: true }] });
    expect(mascotGone.statusCode).toBe(201);
    const afterMascot = await places(db);
    for (const [id, place] of before) expect(afterMascot.get(id)).toBe(place.replace(`/${mascot.id}`, '/null'));

    await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, open!.id));
    const devGone = await build(app, ceo, { items: [{ department: dev.id, note: '', remove: true }] });
    expect(devGone.statusCode).toBe(201);
    const afterDev = await places(db);
    for (const [id, place] of afterMascot) expect(afterDev.get(id)).toBe(place.startsWith(`${dev.id}/`) ? 'null/null' : place);
    expect([...afterDev.values()].filter(p => p === 'null/null')).toHaveLength(41);
  });
  it('reads only the tasks of the department and its products', async () => {
    const h = await longHistory();
    const { app, db, ceo, acme, dev, mascot, characters } = h;
    const [open] = await db.insert(tasks).values({ companyId: acme.id, number: 99_999, departmentId: dev.id, productId: characters.id, title: 'Open on Characters', status: 'open' }).returning();
    const check = (department: string) => rowsRead(db, ['tasks'], () => checkItems(db, acme.id, [{ department, note: '', remove: true }]));
    /* Whether work is open there: Development's 41 tasks at most, for a product found through the department holding it,
       not the 2000 of the other departments. */
    const busy = await check(characters.id);
    expect(busy.result).toContain('has open tasks');
    expect(busy.read.tasks).toBeLessThanOrEqual(DEV_TASKS);
    await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, open!.id));
    for (const place of [mascot.id, dev.id]) {
      const free = await check(place);
      expect(free.result).toBeNull();
      expect(free.read.tasks).toBeLessThanOrEqual(DEV_TASKS);
    }
    /* The removal's own changes to tasks, each read through the department's index. Deleting the department rows also
       makes Postgres look for tasks still pointing at them, which reads every task until product_id has an index. */
    const seen = statements();
    for (const place of [mascot.id, dev.id]) {
      const from = seen.length;
      expect((await build(app, ceo, { items: [{ department: place, note: '', remove: true }] })).statusCode).toBe(201);
      const changes = seen.slice(from).filter(q => q.sql.startsWith('update "tasks"'));
      expect(changes).toHaveLength(2);
      for (const change of changes) expect(await statementReads(db, change, 'tasks')).toBeLessThanOrEqual(DEV_TASKS);
    }
  });
});
