import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { formerAgentRole, HIDDEN, openAgentSql, readerRole, SECRET, type AgentSql, type SqlMode } from '../../src/db/agent-sql.js';
import { companies, people } from '../../src/db/schema.js';
import { privatePostgres } from './helpers.js';

/* Operations reads no hidden table and no secret column; the orchestrator, as Hornhoof itself, reads every table and column, the keys too. */
async function secretReads(sql: AgentSql, mode: SqlMode): Promise<void> {
  for (const table of HIDDEN) {
    if (mode === 'read') await expect(sql.run(`SELECT 1 FROM "${table}"`, mode)).rejects.toMatchObject({ code: '42501' });
    else expect((await sql.run(`SELECT * FROM "${table}"`, mode))[0]!.changed, table).toBe(0);
  }
  for (const [table, columns] of Object.entries(SECRET)) {
    for (const column of columns) {
      if (mode === 'read') await expect(sql.run(`SELECT "${column}" FROM "${table}"`, mode)).rejects.toMatchObject({ code: '42501' });
      else expect((await sql.run(`SELECT "${column}" FROM "${table}"`, mode))[0]!.changed, `${table}.${column}`).toBe(0);
    }
  }
  if (mode === 'write') expect((await sql.run('SELECT password_hash FROM people', mode))[0]!.rows).toEqual([{ password_hash: 'fixture-only-password-hash' }]);
}

async function rejectsWrongPassword(url: string, role: string): Promise<void> {
  const wrong = new URL(url);
  wrong.username = role;
  wrong.password = randomBytes(24).toString('hex');
  /* No limit of its own (pg's default 0): the refusal comes as an answer, and only the runner's limit ends a hang. */
  const client = new pg.Client({ connectionString: wrong.toString() });
  try {
    /* A trust or peer socket cannot pass as proof of the production password login. */
    await expect(client.connect()).rejects.toMatchObject({ code: '28P01' });
  } finally {
    await client.end();
  }
}

async function identity(sql: AgentSql, mode: SqlMode, name: string): Promise<void> {
  const [identity] = await sql.run('SELECT current_user AS role, session_user AS login, rolcanlogin FROM pg_roles WHERE rolname = current_user', mode);
  expect(identity!.rows).toEqual([{ role: name, login: name, rolcanlogin: true }]);
  const [metadata] = await sql.run('SELECT name FROM people', mode);
  expect(metadata!.rows).toEqual([{ name: 'Role fixture owner' }]);
  await secretReads(sql, mode);
}

it("authenticates Operations' role with SCRAM, keeps its reads, and runs the orchestrator's SQL as Hornhoof itself", async () => {
  const fixture = await privatePostgres();
  /* A role an older build gave the orchestrator goes at the start. */
  await fixture.admin.query(`CREATE ROLE "${formerAgentRole(fixture.name)}" NOLOGIN`);
  await fixture.admin.query(`GRANT SELECT ON companies TO "${formerAgentRole(fixture.name)}"`);
  const [company] = await fixture.db.insert(companies).values({ name: 'Role fixture' }).returning();
  await fixture.db.insert(people).values({ companyId: company!.id, name: 'Role fixture owner', email: 'roles@example.test', status: 'active', scopeKind: 'company', passwordHash: 'fixture-only-password-hash' });
  expect((await fixture.admin.query<{ password_encryption: string }>('SHOW password_encryption')).rows[0]!.password_encryption).toBe('scram-sha-256');
  const sql = await openAgentSql(fixture.url);
  expect(sql, 'Production openAgentSql must create both LOGIN pools').not.toBeNull();
  if (!sql) throw new Error('Production openAgentSql returned no SQL access');
  fixture.cleanup(() => sql.close());
  expect((await fixture.admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [formerAgentRole(fixture.name)])).rows).toEqual([]);
  const reader = readerRole(fixture.name);
  const password = (await fixture.admin.query<{ scram: boolean }>('SELECT rolpassword LIKE $1 AS scram FROM pg_authid WHERE rolname = $2', ['SCRAM-SHA-256$%', reader])).rows;
  expect(password).toEqual([{ scram: true }]);
  await rejectsWrongPassword(fixture.url, reader);
  await identity(sql, 'read', reader);
  await identity(sql, 'write', decodeURIComponent(new URL(fixture.url).username));
  expect((await sql.run('SHOW transaction_read_only', 'read'))[0]!.rows).toEqual([{ transaction_read_only: 'on' }]);
  await expect(sql.run("UPDATE companies SET name = 'reader-forged'", 'read')).rejects.toHaveProperty('code', expect.stringMatching(/^(42501|25006)$/));
  for (const statement of [
    "UPDATE people SET name = 'Role fixture owner'",
    "UPDATE people SET password_hash = 'fixture-only-password-hash'",
    'DELETE FROM test_runs',
    'DELETE FROM net.pulse WHERE false',
    'CREATE TABLE orchestrator_scratch (id int); DROP TABLE orchestrator_scratch',
  ]) await expect(sql.run(statement, 'write'), statement).resolves.toBeDefined();
  expect((await sql.run('SELECT name FROM companies', 'read'))[0]!.rows).toEqual([{ name: 'Role fixture' }]);
  expect((await sql.run('SELECT name FROM people', 'write'))[0]!.rows).toEqual([{ name: 'Role fixture owner' }]);
});
