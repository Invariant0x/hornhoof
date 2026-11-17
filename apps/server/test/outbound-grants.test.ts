import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { HIDDEN, type SqlMode } from '../src/db/agent-sql.js';
import { BOOKKEEPING, CLOSING, TABLE_RULES } from '../src/modules/merge/rules.js';
import { agentSqlOn, createTestDb } from './helpers.js';

/* The deleted gateway's tables, its checks made by a model and its support desk are dropped with their rows, a mailbox's
   sign-in among them, and so is the function that guarded them. The orchestrator runs as Hornhoof itself (Ivan's word of
   17 November 2026). On PGlite Operations' role is taken with SET LOCAL ROLE: real sign-ins are in the live spec beside
   this one, test/postgres/outbound-grants.pg.spec.ts. */
const GATEWAY = /^(?:outbound_|support_tickets$|support_classifications$|model_check)/;

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

describe('the tables of the deleted gateway', () => {
  it('are gone from the database, with the function that guarded them', async () => {
    const db = await createTestDb();
    const { rows } = await db.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename ~ '^(outbound_|support_|model_check)' ORDER BY tablename`);
    expect(rows).toEqual([]);
    expect((await db.execute(sql`SELECT proname FROM pg_proc WHERE proname = 'outbound_refuse_change'`)).rows).toEqual([]);
  });

  it('are named in no list of tables: neither hidden from Operations nor given a rule of a merge', () => {
    expect(HIDDEN.filter(name => GATEWAY.test(name))).toEqual([]);
    for (const list of [TABLE_RULES, CLOSING, BOOKKEEPING]) expect(Object.keys(list).filter(name => GATEWAY.test(name))).toEqual([]);
  });

  it("leave no function of the schema that runs with its owner's rights", async () => {
    const { client } = await roles();
    expect((await client.query(`SELECT proname FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace`)).rows).toEqual([]);
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
