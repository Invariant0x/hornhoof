import { expect, it } from 'vitest';
import type { SqlMode } from '../src/db/agent-sql.js';
import { agentSqlOn } from './helpers.js';
import { createTestDb } from './helpers-db.js';

/* write: the orchestrator's, as Hornhoof itself (Ivan's word of 17 November 2026). read: Operations', under its role. */
async function roles() {
  const sql = agentSqlOn((await createTestDb()).$client);
  return (mode: SqlMode, statement: string) => sql.run(statement, mode);
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
])('keeps %s writes from Operations, and the orchestrator makes them as Hornhoof does', async table => {
  const run = await roles();
  const column = { program_operator_signals: 'agent_id', turn_snapshots: 'turn_id', test_part_timings: 'part_id', test_file_results: 'file', test_suite_memory: 'suite_id', harness_products: 'department_id', turn_tokens: 'job_id', assistant_seqs: 'company_id' }[table] ?? 'id';
  const writes = [
    `INSERT INTO ${table} (${column}) SELECT ${column} FROM ${table} WHERE false`,
    `UPDATE ${table} SET ${column} = ${column} WHERE false`,
    `DELETE FROM ${table} WHERE false`,
  ];
  for (const statement of writes) {
    await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied|read-only/);
    await expect(run('write', statement), `write: ${statement}`).resolves.toBeDefined();
  }
});

it.each(['task_waits', 'wait_policies'])('keeps %s from Operations, and lets the orchestrator read and change it', async table => {
  const run = await roles();
  const writes = [`INSERT INTO ${table} (id) SELECT id FROM ${table} WHERE false`, `UPDATE ${table} SET id = id WHERE false`, `DELETE FROM ${table} WHERE false`];
  for (const statement of [`SELECT * FROM ${table}`, `SELECT id FROM ${table}`, ...writes]) {
    await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied|read-only/);
  }
  expect((await run('write', `SELECT * FROM ${table}`))[0]!.rows).toEqual([]);
  for (const statement of writes) await expect(run('write', statement), `write: ${statement}`).resolves.toBeDefined();
});

it.each(['wait_id', 'generation', 'level', 'purpose', 'route_revision'])('keeps the new %s of a notice readable to both, and changed only by the orchestrator, as the rest of it', async column => {
  const run = await roles();
  for (const mode of ['write', 'read'] as const) expect((await run(mode, `SELECT ${column} FROM wait_notices`))[0]!.rows).toEqual([]);
  await expect(run('read', `UPDATE wait_notices SET ${column} = ${column} WHERE false`)).rejects.toThrow(/permission denied|read-only/);
  await expect(run('write', `UPDATE wait_notices SET ${column} = ${column} WHERE false`)).resolves.toBeDefined();
});

it.each([
  { table: 'program_operator_cases', secret: 'capability', metadata: 'id, status, reason' },
  { table: 'attachments', secret: 'bytes', metadata: 'id, media_type, size, operator_case_id' },
])('hides the $secret column of $table from Operations, shows it to the orchestrator, and both read metadata', async ({ table, secret, metadata }) => {
  const run = await roles();
  await expect(run('read', `SELECT ${secret} FROM ${table}`)).rejects.toThrow(/permission denied|read-only/);
  expect((await run('write', `SELECT ${secret} FROM ${table}`))[0]!.rows).toEqual([]);
  for (const mode of ['write', 'read'] as const) expect((await run(mode, `SELECT ${metadata} FROM ${table}`))[0]!.rows).toEqual([]);
});

it('keeps request material history from Operations, and lets the orchestrator read and change it', async () => {
  const run = await roles();
  const writes = [
    'INSERT INTO request_internal (request_id,company_id) SELECT request_id,company_id FROM request_internal WHERE false',
    'UPDATE request_internal SET material_snapshot = null WHERE false',
    'DELETE FROM request_internal WHERE false',
  ];
  for (const statement of ['SELECT material_snapshot FROM request_internal', 'SELECT * FROM request_internal', ...writes]) {
    await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied|read-only/);
  }
  expect((await run('write', 'SELECT * FROM request_internal'))[0]!.rows).toEqual([]);
  for (const statement of writes) await expect(run('write', statement), `write: ${statement}`).resolves.toBeDefined();
});

it('exposes safe request/proposal digests, private proposal history to the orchestrator alone, and its writes alone', async () => {
  const run = await roles();
  for (const mode of ['write', 'read'] as const) {
    expect((await run(mode, 'SELECT id,material_revision,material_digest FROM requests'))[0]!.rows).toEqual([]);
    expect((await run(mode, 'SELECT id,material_revision,material_digest FROM proposals'))[0]!.rows).toEqual([]);
  }
  for (const statement of ['UPDATE proposals SET material_snapshot = null WHERE false', 'UPDATE requests SET material_digest = null WHERE false']) {
    await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied|read-only/);
    await expect(run('write', statement), `write: ${statement}`).resolves.toBeDefined();
  }
  for (const statement of ['SELECT material_snapshot FROM proposals', 'SELECT * FROM proposals']) {
    await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied|read-only/);
    expect((await run('write', statement))[0]!.rows, `write: ${statement}`).toEqual([]);
  }
});

it('keeps departments.autonomous_release readable to both and changed only by the orchestrator', async () => {
  const run = await roles();
  for (const mode of ['write', 'read'] as const) expect((await run(mode, 'SELECT autonomous_release FROM departments WHERE false'))[0]!.rows).toEqual([]);
  for (const statement of ['UPDATE departments SET autonomous_release = true WHERE false', 'INSERT INTO departments (company_id, autonomous_release) SELECT company_id, true FROM departments WHERE false']) {
    await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied|read-only/);
    await expect(run('write', statement), `write: ${statement}`).resolves.toBeDefined();
  }
});

it("keeps a head's Telegram bot token from Operations, lets the orchestrator read and change it, and the bot stays readable", async () => {
  const run = await roles();
  for (const mode of ['write', 'read'] as const) expect((await run(mode, 'SELECT id, agent_id FROM telegram_bots WHERE false'))[0]!.rows).toEqual([]);
  await expect(run('read', "UPDATE telegram_bots SET token_enc = 'x' WHERE false")).rejects.toThrow(/permission denied|read-only/);
  await expect(run('write', "UPDATE telegram_bots SET token_enc = 'x' WHERE false")).resolves.toBeDefined();
  for (const statement of ['SELECT token_enc FROM telegram_bots', 'SELECT * FROM telegram_bots']) {
    await expect(run('read', statement), `read: ${statement}`).rejects.toThrow(/permission denied|read-only/);
    expect((await run('write', statement))[0]!.rows, `write: ${statement}`).toEqual([]);
  }
});
