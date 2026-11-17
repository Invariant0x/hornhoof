import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentRole, grantsFor, HIDDEN, readerGrantsFor, readerRole, type SqlMode } from '../src/db/agent-sql.js';
import { createTestDb } from './helpers.js';

/* The tables of the gateway, as a migration really made them. A new table of these families has to be named here, and
   then it has to be hidden. On PGlite a role is taken with SET LOCAL ROLE: real sign-ins are in the live spec beside
   this one, test/postgres/outbound-grants.pg.spec.ts. */
const GATEWAY = [
  'model_check_certificates', 'model_check_datasets', 'model_check_evaluations', 'model_check_revisions', 'model_checks',
  'outbound_accounts', 'outbound_approvals', 'outbound_attempts', 'outbound_bindings', 'outbound_catalog_revisions', 'outbound_channels',
  'outbound_contact_events', 'outbound_contact_fields', 'outbound_contacts', 'outbound_daily_usage', 'outbound_events', 'outbound_message_revisions', 'outbound_messages',
  'outbound_permissions', 'outbound_policies', 'outbound_review_receipts', 'outbound_sampling_counters', 'outbound_setup_events', 'support_classifications', 'support_tickets',
];
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const SEALED = ['outbound_contact_fields.fields_enc', 'outbound_accounts.config_enc', 'outbound_contacts.address_enc', 'outbound_message_revisions.sealed_enc', 'support_tickets.text_enc'];
const ROLE = { write: agentRole('postgres'), read: readerRole('postgres') };

async function roles() {
  const db = await createTestDb();
  const { $client: client } = db;
  await client.exec(`${grantsFor(ROLE.write)};\n${readerGrantsFor(ROLE.read)}`);
  const run = (mode: SqlMode, statement: string) => client.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE "${ROLE[mode]}"`);
    return tx.exec(statement);
  });
  return { db, client, run };
}

const writesOf = (table: string, column: string) => [
  `INSERT INTO ${table} (${column}) SELECT ${column} FROM ${table} WHERE false`,
  `UPDATE ${table} SET ${column} = ${column} WHERE false`,
  `DELETE FROM ${table} WHERE false`,
  `TRUNCATE ${table}`,
];

describe('the tables of the gateway in the database', () => {
  it('are all named, and all hidden: Operations reads none of them and the orchestrator changes none', async () => {
    const db = await createTestDb();
    const { rows } = await db.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^(outbound_|support_|model_check)' ORDER BY tablename`);
    const tables = rows.map(row => row.tablename);
    expect(tables).toEqual(GATEWAY);
    expect(HIDDEN).toEqual(expect.arrayContaining(tables));
  });

  it.each(GATEWAY)('give Operations no right on %s, and the orchestrator its columns to read alone', async table => {
    const { client } = await roles();
    const has = async (query: string) => (await client.query<{ has: boolean }>(query)).rows[0]!.has;
    for (const role of Object.values(ROLE)) {
      for (const privilege of PRIVILEGES) expect(await has(`SELECT has_table_privilege('${role}', 'public.${table}', '${privilege}') AS has`), `${role} ${privilege}`).toBe(false);
      expect(await has(`SELECT has_any_column_privilege('${role}', 'public.${table}', 'INSERT, UPDATE, REFERENCES') AS has`), role).toBe(false);
    }
    expect(await has(`SELECT has_any_column_privilege('${ROLE.read}', 'public.${table}', 'SELECT') AS has`)).toBe(false);
    expect(await has(`SELECT has_any_column_privilege('${ROLE.write}', 'public.${table}', 'SELECT') AS has`)).toBe(true);
  });

  it.each(GATEWAY)('refuse every write of both roles and every read of Operations on %s, and let the orchestrator read it', async table => {
    const { run } = await roles();
    for (const statement of [`SELECT * FROM ${table}`, ...writesOf(table, 'id')]) {
      await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied/);
    }
    for (const statement of writesOf(table, 'id')) {
      await expect(run('write', statement), `write: ${statement}`).rejects.toThrow(/permission denied/);
    }
    expect((await run('write', `SELECT id FROM ${table}`))[0]!.rows).toEqual([]);
  });

  it.each(SEALED)('keep what is sealed from the orchestrator too: %s', async name => {
    const { run } = await roles();
    const [table, column] = name.split('.') as [string, string];
    await expect(run('write', `SELECT ${column} FROM ${table}`)).rejects.toThrow(/permission denied/);
  });

  it('are owned by neither role, and no function of the schema runs with its owner\'s rights', async () => {
    const { client } = await roles();
    const owners = await client.query<{ tableowner: string }>(`SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(ARRAY[${GATEWAY.map(table => `'${table}'`).join(', ')}])`);
    expect(owners.rows.map(row => row.tableowner)).not.toEqual(expect.arrayContaining(Object.values(ROLE)));
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

  it('cannot be changed by either', async () => {
    const { run } = await roles();
    for (const mode of ['write', 'read'] as const) {
      for (const statement of writesOf('approval_policies', 'id')) {
        await expect(run(mode, statement), `${mode}: ${statement}`).rejects.toThrow(/permission denied/);
      }
    }
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
  ])('cannot be set by generic SQL: %s', async statement => {
    const { run } = await roles();
    for (const mode of ['write', 'read'] as const) {
      await expect(run(mode, statement), mode).rejects.toThrow(/permission denied/);
    }
  });

  it('leaves the rest of a department to the orchestrator, as before', async () => {
    const { run } = await roles();
    expect((await run('write', 'UPDATE departments SET about = about WHERE false'))[0]!.affectedRows).toBe(0);
    expect((await run('write', "INSERT INTO departments (company_id, role_code) SELECT company_id, 'X' FROM departments WHERE false"))[0]!.affectedRows).toBe(0);
  });
});
