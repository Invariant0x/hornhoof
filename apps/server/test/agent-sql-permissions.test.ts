import { expect, it } from 'vitest';
import { agentRole, grantsFor, readerGrantsFor, readerRole, type SqlMode } from '../src/db/agent-sql.js';
import { createTestDb } from './helpers-db.js';

async function roles() {
  const { $client: client } = await createTestDb();
  const names = { write: agentRole('postgres'), read: readerRole('postgres') };
  await client.exec(`${grantsFor(names.write)};\n${readerGrantsFor(names.read)}`);
  return (mode: SqlMode, statement: string) => client.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE "${names[mode]}"`);
    return tx.exec(statement);
  });
}

it.each([
  'program_instances',
  'program_deliveries',
  'program_operator_cases',
  'program_operator_signals',
  'wait_notices',
  'person_changes',
  'attachments',
  'turn_snapshots',
  'test_part_timings',
  'test_file_results',
  'test_suite_memory',
  'harness_builds',
  'harness_products',
  'autonomous_releases',
  'agent_inbox',
  'turn_tokens',
  'assistant_seqs',
])('keeps %s writes behind the service API for both SQL roles', async table => {
  const run = await roles();
  const column = { program_operator_signals: 'agent_id', turn_snapshots: 'turn_id', test_part_timings: 'part_id', test_file_results: 'file', test_suite_memory: 'suite_id', harness_products: 'department_id', turn_tokens: 'job_id', assistant_seqs: 'company_id' }[table] ?? 'id';
  const writes = [
    `INSERT INTO ${table} (${column}) SELECT ${column} FROM ${table} WHERE false`,
    `UPDATE ${table} SET ${column} = ${column} WHERE false`,
    `DELETE FROM ${table} WHERE false`,
  ];
  for (const mode of ['write', 'read'] as const) {
    for (const statement of writes) {
      await expect(run(mode, statement), `${mode}: ${statement}`).rejects.toThrow(/permission denied/);
    }
  }
});

it.each(['task_waits', 'wait_policies'])('keeps %s from Operations, and lets the orchestrator read it but not change it', async table => {
  const run = await roles();
  const writes = [`INSERT INTO ${table} (id) SELECT id FROM ${table} WHERE false`, `UPDATE ${table} SET id = id WHERE false`, `DELETE FROM ${table} WHERE false`];
  for (const statement of [`SELECT * FROM ${table}`, `SELECT id FROM ${table}`, ...writes]) {
    await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied/);
  }
  expect((await run('write', `SELECT * FROM ${table}`))[0]!.rows).toEqual([]);
  for (const statement of writes) await expect(run('write', statement), `write: ${statement}`).rejects.toThrow(/permission denied/);
});

it.each(['wait_id', 'generation', 'level', 'purpose', 'route_revision'])('keeps the new %s of a notice readable and not writable, as the rest of it', async column => {
  const run = await roles();
  for (const mode of ['write', 'read'] as const) {
    expect((await run(mode, `SELECT ${column} FROM wait_notices`))[0]!.rows).toEqual([]);
    await expect(run(mode, `UPDATE wait_notices SET ${column} = ${column} WHERE false`), mode).rejects.toThrow(/permission denied/);
  }
});

it.each([
  { table: 'program_operator_cases', secret: 'capability', metadata: 'id, status, reason' },
  { table: 'attachments', secret: 'bytes', metadata: 'id, media_type, size, operator_case_id' },
])('hides $table.$secret while both SQL roles can read metadata', async ({ table, secret, metadata }) => {
  const run = await roles();
  for (const mode of ['write', 'read'] as const) {
    await expect(run(mode, `SELECT ${secret} FROM ${table}`), mode).rejects.toThrow(/permission denied/);
    expect((await run(mode, `SELECT ${metadata} FROM ${table}`))[0]!.rows).toEqual([]);
  }
});

it('keeps request material history from Operations and unchanged by either SQL role, and lets the orchestrator read it', async () => {
  const run = await roles();
  const writes = [
    'INSERT INTO request_internal (request_id,company_id) SELECT request_id,company_id FROM request_internal WHERE false',
    'UPDATE request_internal SET material_snapshot = null WHERE false',
    'DELETE FROM request_internal WHERE false',
  ];
  for (const statement of ['SELECT material_snapshot FROM request_internal', 'SELECT * FROM request_internal', ...writes]) {
    await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied/);
  }
  expect((await run('write', 'SELECT * FROM request_internal'))[0]!.rows).toEqual([]);
  for (const statement of writes) await expect(run('write', statement), `write: ${statement}`).rejects.toThrow(/permission denied/);
});

it('exposes safe request/proposal digests, private proposal history to the orchestrator alone, and refuses writes', async () => {
  const run = await roles();
  for (const mode of ['write', 'read'] as const) {
    expect((await run(mode, 'SELECT id,material_revision,material_digest FROM requests'))[0]!.rows).toEqual([]);
    expect((await run(mode, 'SELECT id,material_revision,material_digest FROM proposals'))[0]!.rows).toEqual([]);
    for (const statement of ['UPDATE proposals SET material_snapshot = null WHERE false', 'UPDATE requests SET material_digest = null WHERE false']) {
      await expect(run(mode, statement), `${mode}: ${statement}`).rejects.toThrow(/permission denied/);
    }
  }
  for (const statement of ['SELECT material_snapshot FROM proposals', 'SELECT * FROM proposals']) {
    await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied/);
    expect((await run('write', statement))[0]!.rows, `write: ${statement}`).toEqual([]);
  }
});

it.each(['model_checks', 'model_check_revisions', 'model_check_datasets', 'model_check_evaluations'])('closes %s to Operations, and to every change, but lets the orchestrator read it', async table => {
  const run = await roles();
  const writes = [`INSERT INTO ${table} (id) SELECT id FROM ${table} WHERE false`, `UPDATE ${table} SET id = id WHERE false`, `DELETE FROM ${table} WHERE false`];
  for (const statement of [`SELECT * FROM ${table}`, ...writes]) {
    await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied/);
  }
  expect((await run('write', `SELECT id FROM ${table}`))[0]!.rows).toEqual([]);
  for (const statement of writes) await expect(run('write', statement), `write: ${statement}`).rejects.toThrow(/permission denied/);
});

it('keeps departments.autonomous_release readable and not writable by either SQL role', async () => {
  const run = await roles();
  for (const mode of ['write', 'read'] as const) {
    expect((await run(mode, 'SELECT autonomous_release FROM departments WHERE false'))[0]!.rows).toEqual([]);
    for (const statement of ['UPDATE departments SET autonomous_release = true WHERE false', 'INSERT INTO departments (company_id, autonomous_release) SELECT company_id, true FROM departments WHERE false']) {
      await expect(run(mode, statement), `${mode}: ${statement}`).rejects.toThrow(/permission denied/);
    }
  }
});

it("keeps a head's Telegram bot token from both SQL roles, while the bot itself stays readable", async () => {
  const run = await roles();
  for (const mode of ['write', 'read'] as const) {
    expect((await run(mode, 'SELECT id, agent_id FROM telegram_bots WHERE false'))[0]!.rows).toEqual([]);
    for (const statement of ['SELECT token_enc FROM telegram_bots', 'SELECT * FROM telegram_bots', "UPDATE telegram_bots SET token_enc = 'x' WHERE false"]) {
      await expect(run(mode, statement), `${mode}: ${statement}`).rejects.toThrow(/permission denied/);
    }
  }
});
