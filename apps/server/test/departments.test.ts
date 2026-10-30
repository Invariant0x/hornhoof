import { eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, proposals } from '../src/db/schema.js';
import { as, connectNode, invitePerson, listen, openStream, SETUP, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

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

const build = (app: Awaited<ReturnType<typeof testApp>>['app'], token: string, payload: unknown) => app.inject({ method: 'POST', url: '/api/departments/build', payload, ...as(token) });

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
    expect(note).toContain('Development (products: Mascot, Characters)');
    expect(note).toContain('offer to staff the new departments, one department at a time');
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
    const built = await build(app, ceo, { items: [{ template: 'operations' }, { template: 'sales', note: '' }] });
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

  it('is only for people who see the whole company', async () => {
    const { app, db, ceo, acme } = await withOrchestrator();
    const [sales] = await db.insert(departments).values({ companyId: acme.id, name: 'Sales', roleCode: 'SAL' }).returning();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
    const res = await build(app, maria, { items: [{ template: 'operations' }] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.reason).toBe('company_scope_only');
  });
});
