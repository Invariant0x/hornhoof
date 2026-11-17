import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { HIDDEN, readerRole, type SqlMode } from '../src/db/agent-sql.js';
import { agentSqlOn, createTestDb } from './helpers.js';

/* The tables of the gateway, as a migration really made them. A new table of these families has to be named here, and
   then it has to be hidden from Operations. The orchestrator runs as Hornhoof itself (Ivan's word of 17 November 2026).
   On PGlite Operations' role is taken with SET LOCAL ROLE: real sign-ins are in the live spec beside this one,
   test/postgres/outbound-grants.pg.spec.ts. */
const GATEWAY = [
  'model_check_certificates', 'model_check_datasets', 'model_check_evaluations', 'model_check_revisions', 'model_checks',
  'outbound_accounts', 'outbound_approvals', 'outbound_attempts', 'outbound_bindings', 'outbound_catalog_revisions', 'outbound_channels',
  'outbound_contact_events', 'outbound_contacts', 'outbound_daily_usage', 'outbound_events', 'outbound_message_revisions', 'outbound_messages',
  'outbound_permissions', 'outbound_policies', 'outbound_review_receipts', 'outbound_sampling_counters', 'outbound_setup_events', 'support_classifications', 'support_tickets',
];
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const SEALED = ['outbound_accounts.config_enc', 'outbound_contacts.address_enc', 'outbound_message_revisions.sealed_enc', 'support_tickets.text_enc'];
const READER = readerRole('postgres');

async function roles() {
  const db = await createTestDb();
  const { $client: client } = db;
  const sql = agentSqlOn(client);
  const run = (mode: SqlMode, statement: string) => sql.run(statement, mode);
  await run('read', 'SELECT 1');
  return { db, client, run };
}

const rowWritesOf = (table: string, column: string) => [
  `INSERT INTO ${table} (${column}) SELECT ${column} FROM ${table} WHERE false`,
  `UPDATE ${table} SET ${column} = ${column} WHERE false`,
  `DELETE FROM ${table} WHERE false`,
];
const writesOf = (table: string, column: string) => [...rowWritesOf(table, column), `TRUNCATE ${table}`];

describe('the tables of the gateway in the database', () => {
  it('are all named, and all hidden: Operations reads none of them', async () => {
    const db = await createTestDb();
    const { rows } = await db.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^(outbound_|support_|model_check)' ORDER BY tablename`);
    const tables = rows.map(row => row.tablename);
    expect(tables).toEqual(GATEWAY);
    expect(HIDDEN).toEqual(expect.arrayContaining(tables));
  });

  it.each(GATEWAY)('give Operations no right on %s', async table => {
    const { client } = await roles();
    const has = async (query: string) => (await client.query<{ has: boolean }>(query)).rows[0]!.has;
    for (const privilege of PRIVILEGES) expect(await has(`SELECT has_table_privilege('${READER}', 'public.${table}', '${privilege}') AS has`), privilege).toBe(false);
    expect(await has(`SELECT has_any_column_privilege('${READER}', 'public.${table}', 'SELECT, INSERT, UPDATE, REFERENCES') AS has`)).toBe(false);
  });

  it.each(GATEWAY)('refuse every read and write of Operations on %s, and let the orchestrator read and change it', async table => {
    const { run } = await roles();
    for (const statement of [`SELECT * FROM ${table}`, ...writesOf(table, 'id')]) {
      await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied|read-only/);
    }
    for (const statement of rowWritesOf(table, 'id')) await expect(run('write', statement), `write: ${statement}`).resolves.toBeDefined();
    expect((await run('write', `SELECT * FROM ${table}`))[0]!.rows).toEqual([]);
  });

  it.each(SEALED)('show what is sealed to the orchestrator and not to Operations: %s', async name => {
    const { run } = await roles();
    const [table, column] = name.split('.') as [string, string];
    expect((await run('write', `SELECT ${column} FROM ${table}`))[0]!.rows).toEqual([]);
    await expect(run('read', `SELECT ${column} FROM ${table}`)).rejects.toThrow(/permission denied|read-only/);
  });

  it('are not owned by Operations, and no function of the schema runs with its owner\'s rights', async () => {
    const { client } = await roles();
    const owners = await client.query<{ tableowner: string }>(`SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(ARRAY[${GATEWAY.map(table => `'${table}'`).join(', ')}])`);
    expect(owners.rows.map(row => row.tableowner)).not.toContain(READER);
    expect((await client.query(`SELECT proname FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace`)).rows).toEqual([]);
  });

  it.each(SEALED)('have nothing set in advance for what is sealed: %s', async name => {
    const db = await createTestDb();
    const [table, column] = name.split('.') as [string, string];
    const { rows } = await db.execute(sql`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${column}`);
    expect(rows).toEqual([{ is_nullable: 'NO', column_default: null }]);
  });
});

describe('the rules of approval', () => {
  it('can be read by both roles', async () => {
    const { run } = await roles();
    for (const mode of ['write', 'read'] as const) {
      expect((await run(mode, 'SELECT id, channel, mode FROM approval_policies'))[0]!.rows, mode).toEqual([]);
    }
  });

  it('cannot be changed by Operations, and are by the orchestrator', async () => {
    const { run } = await roles();
    for (const statement of writesOf('approval_policies', 'id')) await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied|read-only/);
    for (const statement of rowWritesOf('approval_policies', 'id')) await expect(run('write', statement), `write: ${statement}`).resolves.toBeDefined();
  });
});

describe('the owner of a department', () => {
  it('can be read by both roles', async () => {
    const { run } = await roles();
    for (const mode of ['write', 'read'] as const) {
      expect((await run(mode, 'SELECT owner_person_id FROM departments'))[0]!.rows, mode).toEqual([]);
    }
  });

  it.each([
    'UPDATE departments SET owner_person_id = owner_person_id WHERE false',
    "INSERT INTO departments (company_id, role_code, owner_person_id) SELECT company_id, 'X', owner_person_id FROM departments WHERE false",
  ])('cannot be set by Operations, and is by the orchestrator: %s', async statement => {
    const { run } = await roles();
    await expect(run('read', statement)).rejects.toThrow(/permission denied|read-only/);
    expect((await run('write', statement))[0]!.changed).toBe(0);
  });
});
