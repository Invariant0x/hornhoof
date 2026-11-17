import { expect, it } from 'vitest';
import { HIDDEN, openAgentSql, readerRole, type AgentSql, type SqlMode } from '../../src/db/agent-sql.js';
import { privatePostgres, type PostgresFixture } from './helpers.js';

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

const gatewayTables = async (fixture: PostgresFixture): Promise<string[]> =>
  (await fixture.admin.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^(outbound_|support_|model_check)' ORDER BY tablename")).rows.map(row => row.tablename);

/* No right of Operations on a table or on any column of it. */
async function nothingGranted(fixture: PostgresFixture, role: string, table: string, mode: SqlMode): Promise<void> {
  for (const privilege of PRIVILEGES) {
    const { rows } = await fixture.admin.query<{ has: boolean }>('SELECT has_table_privilege($1, $2, $3) AS has', [role, `public.${table}`, privilege]);
    expect(rows, `${role} ${privilege} ${table}`).toEqual([{ has: false }]);
  }
  const { rows } = await fixture.admin.query('SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = $2', [role, table]);
  expect(rows, `${role} ${table}`).toEqual([]);
  const columns = await fixture.admin.query<{ every: boolean }>(
    "SELECT bool_and(has_column_privilege($1, $2, column_name, 'SELECT')) AS every FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $3",
    [role, `public.${table}`, table],
  );
  expect(columns.rows, `${role} reads ${table}`).toEqual([{ every: mode === 'write' }]);
  /* Only Operations' role is checked here: the orchestrator runs as Hornhoof itself (Ivan's word of 17 November 2026). */
}

/* A write by the reader may be refused for its read-only transaction before its rights are looked at: both are refusals. */
const refused = (mode: SqlMode) => ({ code: expect.stringMatching(mode === 'read' ? /^(42501|25006)$/ : /^42501$/) });

const noRowsChanged = [{ rows: [], changed: 0 }];

/* Operations reads none of these tables; the orchestrator reads all of them, their keys too. Neither changes them. */
async function statementsRefused(sql: AgentSql, mode: SqlMode, table: string): Promise<void> {
  if (mode === 'read') await expect(sql.run(`SELECT * FROM "${table}"`, mode), `${mode} reads ${table}`).rejects.toMatchObject({ code: '42501' });
  else expect(await sql.run(`SELECT * FROM "${table}"`, mode), `${mode} reads ${table}`).toEqual(noRowsChanged);
  for (const statement of [`INSERT INTO "${table}" (id) SELECT id FROM "${table}" WHERE false`, `UPDATE "${table}" SET id = id WHERE false`, `DELETE FROM "${table}" WHERE false`, `TRUNCATE "${table}"`]) {
    await expect(sql.run(statement, mode), `${mode}: ${statement}`).rejects.toMatchObject(refused(mode));
  }
}

async function settingsClosed(sql: AgentSql, mode: SqlMode): Promise<void> {
  expect(await sql.run('SELECT id, channel, mode FROM approval_policies', mode)).toEqual(noRowsChanged);
  expect((await sql.run('SELECT owner_person_id FROM departments', mode))[0]!.changed).toBe(0);
  for (const statement of ['INSERT INTO approval_policies (id) SELECT id FROM approval_policies WHERE false', 'UPDATE approval_policies SET mode = mode WHERE false', 'DELETE FROM approval_policies WHERE false', 'UPDATE departments SET owner_person_id = owner_person_id WHERE false']) {
    await expect(sql.run(statement, mode), `${mode}: ${statement}`).rejects.toMatchObject(refused(mode));
  }
}

it("gives Operations' production SQL role no right on the gateway and no change, signed in as itself, and the orchestrator reads it as Hornhoof", { timeout: 180000 }, async () => {
  const fixture = await privatePostgres();
  const sql = await openAgentSql(fixture.url);
  expect(sql, 'Production openAgentSql must create both LOGIN pools').not.toBeNull();
  if (!sql) throw new Error('Production openAgentSql returned no SQL access');
  fixture.cleanup(() => sql.close());
  const tables = await gatewayTables(fixture);
  expect(tables.length).toBeGreaterThanOrEqual(23);
  const owners = await fixture.admin.query<{ tableowner: string }>('SELECT DISTINCT tableowner FROM pg_tables WHERE tablename = ANY($1)', [tables]);
  const reader = readerRole(fixture.name);
  expect(owners.rows.map(row => row.tableowner)).not.toContain(reader);
  for (const table of tables) {
    await nothingGranted(fixture, reader, table, 'read');
    await statementsRefused(sql, 'read', table);
  }
  await settingsClosed(sql, 'read');
  for (const name of ['outbound_accounts.config_enc', 'outbound_contacts.address_enc', 'outbound_message_revisions.sealed_enc', 'support_tickets.text_enc']) {
    const [table, column] = name.split('.') as [string, string];
    expect(await sql.run(`SELECT ${column} FROM ${table}`, 'write'), name).toEqual(noRowsChanged);
    await expect(sql.run(`SELECT ${column} FROM ${table}`, 'read'), name).rejects.toMatchObject({ code: '42501' });
  }
  expect((await fixture.admin.query("SELECT proname FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace")).rows).toEqual([]);
  /* Last, so that an open table shows up as the right it really has, not as a name missing from a list. */
  expect(HIDDEN).toEqual(expect.arrayContaining(tables));
});
