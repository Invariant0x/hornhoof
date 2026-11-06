import { existsSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, inject, it } from 'vitest';
import { isUniqueViolation } from '../src/db/errors.js';
import { agentChanges, agentEvents, agents, companies, departments, machines, people, personAccess, requests, subscriptions, tasks } from '../src/db/schema.js';
import { createTestDb } from './helpers-db.js';

describe('database', () => {
  it('runs migrations and stores a company', async () => {
    const db = await createTestDb();
    await db.insert(companies).values({ name: 'Acme' });
    const rows = await db.select().from(companies);
    expect(rows.map(r => r.name)).toEqual(['Acme']);
  });

  it('refuses rows that cannot happen: a second head, a task in review without its executor, a task under itself', async () => {
    const db = await createTestDb();
    const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
    const companyId = company!.id;
    const [dev] = await db.insert(departments).values({ companyId, name: 'Dev', roleCode: 'DEV' }).returning();
    const head = { companyId, kind: 'head' as const, name: 'Hana', model: '', departmentId: dev!.id };
    await db.insert(agents).values(head);
    expect(isUniqueViolation(await db.insert(agents).values({ ...head, name: 'Hugo' }).catch((e: unknown) => e))).toBe(true);
    const [bruno] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Bruno', model: '', departmentId: dev!.id }).returning();
    let n = 0;
    const kept = (p: Promise<unknown>) => p.then(() => 'kept', () => 'refused');
    const task = (row: Partial<typeof tasks.$inferInsert>) => kept(db.insert(tasks).values({ companyId, number: ++n, title: 'Checkout', ...row }));
    expect(await task({ status: 'review', stage: 1 })).toBe('refused');
    expect(await task({ stage: -1 })).toBe('refused');
    expect(await task({ silent: -1 })).toBe('refused');
    expect(await task({ status: 'done' })).toBe('refused');
    const [mine] = await db.insert(tasks).values({ companyId, number: ++n, title: 'Checkout', executorAgentId: bruno!.id, assigneeAgentId: bruno!.id }).returning();
    expect(await kept(db.update(tasks).set({ parentId: mine!.id }).where(eq(tasks.id, mine!.id)))).toBe('refused');
    expect(await kept(db.insert(requests).values({ companyId, taskId: mine!.id, agentId: bruno!.id, kind: 'approval', text: 'Merge it?' }))).toBe('refused');
    /* A head who left makes room for the next one. */
    await db.update(agents).set({ removedAt: new Date() }).where(eq(agents.name, 'Hana'));
    expect(await kept(db.insert(agents).values({ ...head, name: 'Hugo' }))).toBe('kept');
  });

  it('refuses a second company in one deployment', async () => {
    const db = await createTestDb();
    await db.insert(companies).values({ name: 'Acme' });
    await expect(db.insert(companies).values({ name: 'Other' })).rejects.toThrow();
  });

  it('keeps one access row per person and place, and the changes to an employee', async () => {
    const db = await createTestDb();
    const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
    const [person] = await db.insert(people).values({ companyId: company!.id, name: 'Maria', email: 'maria@acme.com', status: 'active', scopeKind: 'listed' }).returning();
    const [sales] = await db.insert(departments).values({ companyId: company!.id, name: 'Sales', roleCode: 'SAL' }).returning();
    const place = { companyId: company!.id, personId: person!.id, departmentId: sales!.id };
    await db.insert(personAccess).values(place);
    expect(isUniqueViolation(await db.insert(personAccess).values(place).catch((e: unknown) => e))).toBe(true);
    const [agent] = await db.insert(agents).values({ companyId: company!.id, kind: 'worker', name: 'Lena', model: 'default', departmentId: sales!.id, roleKey: 'SAL-SDR', skills: ['sal-cold-outreach'] }).returning();
    expect(agent).toMatchObject({ skills: ['sal-cold-outreach'], overrides: {}, templateHashes: {}, removedAt: null });
    await db.insert(agentChanges).values({ companyId: company!.id, agentId: agent!.id, personId: person!.id, field: 'model', before: 'default', after: 'opus' });
    expect((await db.select().from(agentChanges)).map(c => [c.field, c.before, c.after])).toEqual([['model', 'default', 'opus']]);
  });

  it('keeps one machine row per person and machine key', async () => {
    const db = await createTestDb();
    const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
    const [person] = await db.insert(people).values({ companyId: company!.id, name: 'Ivan', email: 'ivan@acme.com', status: 'active', scopeKind: 'company' }).returning();
    const machine = { companyId: company!.id, personId: person!.id, machineKey: 'mac-1', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };
    await db.insert(machines).values(machine);
    const err = await db.insert(machines).values(machine).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('stores a personal subscription without a target', async () => {
    const db = await createTestDb();
    const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
    const [person] = await db.insert(people).values({ companyId: company!.id, name: 'Ivan', email: 'ivan@acme.com', status: 'active', scopeKind: 'company' }).returning();
    const [sub] = await db.insert(subscriptions).values({ companyId: company!.id, provider: 'glm', kind: 'personal', label: 'GLM', ownerPersonId: person!.id, status: 'waiting_machine' }).returning();
    expect(sub).toMatchObject({ targetKind: null, targetId: null, limits: null, removedAt: null });
  });
});

describe('conversations', () => {
  it('number an agent\'s events in the order they were written', async () => {
    const db = await createTestDb();
    const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, kind: 'orchestrator', name: 'Orchestrator', model: 'claude-opus-5-5' }).returning();
    const [first] = await db.insert(agentEvents).values({ companyId: company!.id, agentId: agent!.id, kind: 'message', data: { text: 'hi' } }).returning();
    const [second] = await db.insert(agentEvents).values({ companyId: company!.id, agentId: agent!.id, kind: 'text', data: { text: 'hello' } }).returning();
    expect(second!.seq).toBeGreaterThan(first!.seq);
    expect(typeof first!.seq).toBe('number');
  });

  it('keep a template department without a typed name', async () => {
    const db = await createTestDb();
    const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
    const [sales] = await db.insert(departments).values({ companyId: company!.id, name: null, templateKey: 'sales', roleCode: 'SAL' }).returning();
    expect(sales).toMatchObject({ name: null, templateKey: 'sales', parentId: null, about: '' });
    const [europe] = await db.insert(departments).values({ companyId: company!.id, name: 'Sales Europe', roleCode: 'SAL', parentId: sales!.id }).returning();
    expect(europe!.parentId).toBe(sales!.id);
  });
});

describe('indexes', () => {
  it('cover the columns that sign-in, cleanups and lists look up', async () => {
    const db = await createTestDb();
    const res = await db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where schemaname = 'public'`);
    const defs = res.rows.map(r => r.indexdef);
    for (const [table, column] of [['sessions', 'person_id'], ['invites', 'person_id'], ['people', 'company_id'], ['subscriptions', 'owner_person_id'], ['jobs', 'subscription_id'], ['agent_events', 'job_id']]) {
      expect(defs.some(d => d.includes(`ON public.${table} USING btree (${column})`)), `${table}.${column}`).toBe(true);
    }
  });
});

/* Each PGlite is a whole Postgres in WASM memory; a file that leaves them open grows by gigabytes and gets killed on a small CI runner. */
describe('test databases', () => {
  let opened: { closed: boolean } | undefined;

  it('opens one for the test', async () => {
    const client = (await createTestDb()).$client;
    opened = client;
    expect(client.closed).toBe(false);
  });

  it('closes it once that test ends', () => {
    expect(opened?.closed).toBe(true);
  });

  it('starts each from a copy of one database the run migrated before any test, and keeps what one test writes from the next', async () => {
    expect(existsSync(inject('migratedDataDir'))).toBe(true);
    const first = await createTestDb();
    await first.insert(companies).values({ name: 'Acme' });
    const second = await createTestDb();
    expect(await second.select().from(companies)).toEqual([]);
  });
});
