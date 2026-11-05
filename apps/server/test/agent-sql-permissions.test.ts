import { expect, it } from 'vitest';
import { agentRole, grantsFor, readerGrantsFor, readerRole, type SqlMode } from '../src/db/agent-sql.js';
import { createTestDb } from './helpers.js';

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
  'program_operator_actions',
  'program_operator_signals',
  'wait_notices',
  'person_changes',
  'attachments',
])('keeps %s writes behind the service API for both SQL roles', async table => {
  const run = await roles();
  const column = table === 'program_operator_signals' ? 'agent_id' : 'id';
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
