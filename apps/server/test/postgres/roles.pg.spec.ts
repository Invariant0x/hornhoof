import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { agentRole, HIDDEN, openAgentSql, readerRole, SECRET, type AgentSql, type SqlMode } from '../../src/db/agent-sql.js';
import { companies, people } from '../../src/db/schema.js';
import { privatePostgres } from './helpers.js';

/* Operations reads no hidden table and no secret column; the orchestrator reads every table and column, the keys too. */
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

async function restrictedIdentity(sql: AgentSql, mode: SqlMode, name: string): Promise<void> {
  const [identity] = await sql.run('SELECT current_user AS role, session_user AS login, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = current_user', mode);
  expect(identity!.rows).toEqual([{ role: name, login: name, rolsuper: false, rolcanlogin: true }]);
  const [metadata] = await sql.run('SELECT name FROM people', mode);
  expect(metadata!.rows).toEqual([{ name: 'Role fixture owner' }]);
  await secretReads(sql, mode);
}

it('authenticates production SQL roles with SCRAM and enforces metadata, secrets and write permissions', async () => {
  const fixture = await privatePostgres();
  const [company] = await fixture.db.insert(companies).values({ name: 'Role fixture' }).returning();
  await fixture.db.insert(people).values({ companyId: company!.id, name: 'Role fixture owner', email: 'roles@example.test', status: 'active', scopeKind: 'company', passwordHash: 'fixture-only-password-hash' });
  expect((await fixture.admin.query<{ password_encryption: string }>('SHOW password_encryption')).rows[0]!.password_encryption).toBe('scram-sha-256');
  const sql = await openAgentSql(fixture.url);
  expect(sql, 'Production openAgentSql must create both LOGIN pools').not.toBeNull();
  if (!sql) throw new Error('Production openAgentSql returned no SQL access');
  fixture.cleanup(() => sql.close());
  for (const mode of ['read', 'write'] as const) {
    const name = mode === 'read' ? readerRole(fixture.name) : agentRole(fixture.name);
    const password = (await fixture.admin.query<{ scram: boolean }>('SELECT rolpassword LIKE $1 AS scram FROM pg_authid WHERE rolname = $2', ['SCRAM-SHA-256$%', name])).rows;
    expect(password).toEqual([{ scram: true }]);
    await rejectsWrongPassword(fixture.url, name);
    await restrictedIdentity(sql, mode, name);
  }
  expect((await sql.run('SHOW transaction_read_only', 'read'))[0]!.rows).toEqual([{ transaction_read_only: 'on' }]);
  await expect(sql.run("UPDATE companies SET name = 'reader-forged'", 'read')).rejects.toHaveProperty('code', expect.stringMatching(/^(42501|25006)$/));
  for (const statement of [
    "UPDATE people SET name = 'agent-forged'",
    "UPDATE agents SET role_key = 'agent-forged'",
    "UPDATE departments SET repo_url = 'https://forged.example.test/repo.git'",
    'DELETE FROM test_runs',
    'DELETE FROM test_parts',
  ]) await expect(sql.run(statement, 'write')).rejects.toMatchObject({ code: '42501' });
  expect((await sql.run('SELECT name FROM companies', 'read'))[0]!.rows).toEqual([{ name: 'Role fixture' }]);
  expect((await sql.run('SELECT name FROM people', 'write'))[0]!.rows).toEqual([{ name: 'Role fixture owner' }]);
});
