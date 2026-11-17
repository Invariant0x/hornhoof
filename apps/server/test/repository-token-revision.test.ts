import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agentRole, grantsFor, readerGrantsFor, readerRole } from '../src/db/agent-sql.js';
import { companies, departments } from '../src/db/schema.js';
import { as, createTestDb, setUpCompany, testApp } from './helpers.js';
import { freshPglite, ownDatabases } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

/* One test adds a constraint to make the database refuse a write. */
ownDatabases();

async function fixture() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [department] = await db.insert(departments).values({ companyId: company!.id, roleCode: 'DEV', templateKey: 'development', position: 1 }).returning();
  const id = department!.id;
  const url = `/api/departments/${id}/repository`;
  const put = (body: object = {}) => app.inject({ method: 'PUT', url, payload: { url: 'https://example.test/acme/shop.git', branch: 'main', ...body }, ...as(ceo) });
  const clear = () => app.inject({ method: 'DELETE', url, ...as(ceo) });
  const revision = async (departmentId = id) => (await db.select({ revision: sql<number | null>`to_jsonb(departments)->'repo_token_revision'` }).from(departments).where(eq(departments.id, departmentId)))[0]!.revision;
  return { app, db, ceo, companyId: company!.id, id, url, put, clear, revision };
}

describe('private repository credential revision', () => {
  it('starts a server revision on a fresh department without exposing it to the person', async () => {
    const c = await fixture();
    expect(await c.revision()).toBe(1);
    const saved = await c.put();
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toMatch(/repoTokenRevision|repo_token_revision/);
    expect((await c.app.inject({ url: '/api/org', ...as(c.ceo) })).body).not.toMatch(/repoTokenRevision|repo_token_revision/);
  });

  it('advances on every explicit token write, including the same plaintext again', async () => {
    const c = await fixture();
    for (const [token, revision] of [['test-token-first', 2], ['test-token-first', 3], ['test-token-next', 4]] as const) {
      expect((await c.put({ token })).statusCode).toBe(200);
      expect(await c.revision()).toBe(revision);
    }
  });

  it('advances when a changed host clears the token, including an already empty token', async () => {
    const c = await fixture();
    expect((await c.put({ token: 'test-token-first' })).statusCode).toBe(200);
    expect((await c.put({ url: 'https://other.test/acme/shop.git' })).statusCode).toBe(200);
    expect(await c.revision()).toBe(3);
    expect((await c.db.select().from(departments).where(eq(departments.id, c.id)))[0]!.repoTokenEnc).toBeNull();
    expect((await c.put({ url: 'https://third.test/acme/shop.git' })).statusCode).toBe(200);
    expect(await c.revision()).toBe(4);
  });

  it('advances on disconnect and a repeated disconnect', async () => {
    const c = await fixture();
    await c.put({ token: 'test-token-first' });
    expect((await c.clear()).statusCode).toBe(204);
    expect(await c.revision()).toBe(3);
    expect((await c.clear()).statusCode).toBe(204);
    expect(await c.revision()).toBe(4);
  });

  it('keeps the token revision when only repository metadata changes', async () => {
    const c = await fixture();
    await c.put({ token: 'test-token-first' });
    expect((await c.put({ url: 'https://example.test/acme/other.git', branch: 'next', author: { name: 'Test Author', email: 'author@example.test' }, testMemoryGb: 8 })).statusCode).toBe(200);
    expect(await c.revision()).toBe(2);
  });

  it('does not lose a revision when two token writes arrive together', async () => {
    const c = await fixture();
    const responses = await Promise.all([c.put({ token: 'test-token-first' }), c.put({ token: 'test-token-next' })]);
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    expect(await c.revision()).toBe(3);
  });

  it('refuses a client revision and invalid or foreign writes without advancing the owner row', async () => {
    const c = await fixture();
    expect((await c.put({ repoTokenRevision: 999, token: 'test-token-first' })).statusCode).toBe(400);
    expect((await c.put({ url: 'http://example.test/repo.git', token: 'test-token-first' })).statusCode).toBe(400);
    const [foreignCompany] = await c.db.insert(companies).values({ name: 'Another company', singleton: false }).returning();
    const [foreign] = await c.db.insert(departments).values({ companyId: foreignCompany!.id, roleCode: 'DEV' }).returning();
    expect((await c.app.inject({ method: 'PUT', url: `/api/departments/${foreign!.id}/repository`, payload: { url: 'https://example.test/acme/shop.git', token: 'test-token-first' }, ...as(c.ceo) })).statusCode).toBe(404);
    expect(await c.revision()).toBe(1);
    expect(await c.revision(foreign!.id)).toBe(1);
  });

  it('keeps token and revision together when the database refuses their write', async () => {
    const c = await fixture();
    await c.db.execute(sql`alter table departments add constraint test_token_refusal check (repo_token_last4 is distinct from 'fail')`);
    expect((await c.put({ token: 'test-token-fail' })).statusCode).toBe(500);
    expect(await c.revision()).toBe(1);
    expect((await c.db.select().from(departments).where(eq(departments.id, c.id)))[0]!.repoTokenEnc).toBeNull();
  });

  it('shows the revision to the orchestrator alone, and keeps the token and any change of either from both SQL roles', async () => {
    const { $client: client } = await createTestDb();
    expect((await client.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'departments' and column_name = 'repo_token_revision'")).rows).toEqual([{ column_name: 'repo_token_revision' }]);
    const [orchestrator, operations] = [agentRole('postgres'), readerRole('postgres')];
    await client.exec(`${grantsFor(orchestrator)};\n${readerGrantsFor(operations)}`);
    const run = (role: string, statement: string) => client.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE "${role}"`);
      return tx.exec(statement);
    });
    expect((await run(orchestrator, 'select repo_token_revision from departments'))[0]!.rows).toEqual([]);
    await expect(run(operations, 'select repo_token_revision from departments')).rejects.toThrow(/permission denied/);
    for (const role of [orchestrator, operations]) for (const statement of ['select repo_token_enc from departments', 'update departments set repo_token_revision = 999']) {
      await expect(run(role, statement), `${role}: ${statement}`).rejects.toThrow(/permission denied|read-only/);
    }
  });

  it('initializes old rows without changing their encrypted token or other stored data', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsBefore('repo_token_revision') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Retained company') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into departments (company_id, role_code, repo_url, repo_token_enc) values (${company}, 'DEV', 'https://example.test/acme/shop.git', 'retained-test-ciphertext')`);
    const rows = async () => (await db.execute(sql`select to_jsonb(d) - 'repo_token_revision' as data from departments d`)).rows;
    const before = await rows();
    const target = await migrationsThrough('repo_token_revision');
    await migrate(db, { migrationsFolder: target });
    expect(await rows()).toEqual(before);
    expect((await db.execute(sql`select repo_token_revision from departments`)).rows).toEqual([{ repo_token_revision: 1 }]);
    await migrate(db, { migrationsFolder: target });
    expect(await rows()).toEqual(before);
  });
});
