import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { loadConfig } from '../src/config.js';
import { agentRole, grantsFor, readerGrantsFor, readerRole } from '../src/db/agent-sql.js';
import { createTestDb, TEST_SECRET } from './helpers.js';

const TABLES = ['external_operations', 'external_recovery_attempts', 'external_recovery_cases', 'external_recovery_members', 'external_recovery_notices'];
const COMPANY = '00000000-0000-4000-8000-000000000001';
const CASE = '00000000-0000-4000-8000-000000000002';
const SCOPE = 'a'.repeat(64);

async function privateTables(client: PGlite): Promise<void> {
  const found = await client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'external_%' ORDER BY tablename`);
  expect(found.rows.map(row => row.tablename)).toEqual(TABLES);
}

async function seedCase(client: PGlite): Promise<void> {
  await privateTables(client);
  await client.exec(`INSERT INTO companies(id,name) VALUES('${COMPANY}','Retained company');
    INSERT INTO external_recovery_cases(id,company_id,scope_digest,adapter,endpoint_digest,credential_revision,failure_family,first_failure_at,ops_deadline_at,policy_revision)
    VALUES('${CASE}','${COMPANY}','${SCOPE}','git','${'b'.repeat(64)}',1,'transport','2026-11-06T03:00:00Z','2026-11-06T03:15:00Z',1);`);
}

describe('external recovery private foundation', () => {
  it('creates only private recovery records beside existing canonical jobs and tasks', async () => {
    const db = await createTestDb();
    await privateTables(db.$client);
    expect((await db.$client.query('SELECT id FROM jobs')).rows).toEqual([]);
    expect((await db.$client.query('SELECT id FROM tasks')).rows).toEqual([]);
  });

  it('keeps the first failure and deadline across a database restart', async () => {
    const db = await createTestDb();
    await seedCase(db.$client);
    const before = await db.$client.query(`SELECT * FROM external_recovery_cases WHERE id='${CASE}'`);
    const restarted = new PGlite({ loadDataDir: await db.$client.dumpDataDir('none') });
    onTestFinished(() => restarted.close());
    expect((await restarted.query(`SELECT * FROM external_recovery_cases WHERE id='${CASE}'`)).rows).toEqual(before.rows);
  });

  it('reserves one logical Operations notice per company and episode', async () => {
    const db = await createTestDb();
    await seedCase(db.$client);
    const reserve = `INSERT INTO external_recovery_notices(company_id,case_id,notice_kind,notification_id) VALUES('${COMPANY}','${CASE}','operations','00000000-0000-4000-8000-000000000003') ON CONFLICT DO NOTHING RETURNING notification_id`;
    expect((await db.$client.query(reserve)).rows).toHaveLength(1);
    expect((await db.$client.query(reserve)).rows).toHaveLength(0);
    expect((await db.$client.query('SELECT * FROM external_recovery_notices')).rows).toHaveLength(1);
  });

  it('allows only one open episode for the same immutable scope', async () => {
    const db = await createTestDb();
    await seedCase(db.$client);
    const insert = `INSERT INTO external_recovery_cases(company_id,scope_digest,adapter,endpoint_digest,credential_revision,failure_family,first_failure_at,ops_deadline_at,policy_revision) VALUES('${COMPANY}','${SCOPE}','git','${'b'.repeat(64)}',1,'transport','2026-11-06T03:00:00Z','2026-11-06T03:15:00Z',1)`;
    await expect(db.$client.exec(insert)).rejects.toThrow(/unique/);
    await db.$client.exec(`UPDATE external_recovery_cases SET resolved_at='2026-11-06T03:14:00Z' WHERE id='${CASE}'`);
    await db.$client.exec(insert);
    expect((await db.$client.query('SELECT * FROM external_recovery_cases')).rows).toHaveLength(2);
  });

  it('hides all private recovery rows from the actual agent and reader SQL roles', async () => {
    const db = await createTestDb();
    await seedCase(db.$client);
    const names = [agentRole('postgres'), readerRole('postgres')];
    await db.$client.exec(`${grantsFor(names[0]!)};\n${readerGrantsFor(names[1]!)}`);
    for (const role of names) for (const table of TABLES) for (const statement of [
      `SELECT * FROM ${table}`,
      `INSERT INTO ${table} SELECT * FROM ${table} WHERE false`,
      `UPDATE ${table} SET company_id=company_id WHERE false`,
      `DELETE FROM ${table} WHERE false`,
    ]) {
      await expect(db.$client.transaction(async tx => {
        await tx.exec(`SET LOCAL ROLE "${role}"`);
        return tx.exec(statement);
      }), `${role}: ${statement}`).rejects.toThrow(/permission denied/);
    }
  });
});

describe('external recovery Operations deadline configuration', () => {
  const config = (value?: string) => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, ...(value === undefined ? {} : { EXTERNAL_FAILURE_OPS_MS: value }) }) as unknown as Record<string, unknown>;

  it('starts at fifteen minutes and accepts an explicit bounded interval', () => {
    expect(config().externalFailureOpsMs).toBe(900000);
    expect(config('').externalFailureOpsMs).toBe(900000);
    expect(config('60000').externalFailureOpsMs).toBe(60000);
  });

  it.each(['0', '-1', '1.5', 'later', '2147483648'])('rejects invalid Operations interval %s', value => {
    expect(() => config(value)).toThrow('EXTERNAL_FAILURE_OPS_MS must be a whole number of milliseconds');
  });
});
