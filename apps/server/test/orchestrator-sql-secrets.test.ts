import { expect, it } from 'vitest';
import { agentRole, grantsFor, isKey } from '../src/db/agent-sql.js';
import { createTestDb, ownDatabases } from './helpers-db.js';

ownDatabases();

async function access() {
  const { $client: client } = await createTestDb();
  const role = agentRole('postgres');
  await client.exec(grantsFor(role));
  const run = (text: string) => client.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE "${role}"`);
    return tx.exec(text);
  });
  return { client, role, run };
}

it('keeps secrets closed through expressions and older grants while ordinary reads and writes stay open', async () => {
  const { client, role, run } = await access();
  for (const text of [
    'SELECT data FROM assistant_events',
    "SELECT e.data->'files' AS harmless FROM assistant_events e",
    'SELECT to_jsonb(e) FROM assistant_events e',
    'SELECT row_to_json(e) FROM assistant_events e',
    'SELECT e.* FROM assistant_events e',
    'SELECT answer FROM tool_calls',
    'SELECT events_url, skills_url FROM assistants',
    'SELECT to_jsonb(a) FROM assistants a',
  ]) await expect(run(text), text).rejects.toThrow(/permission denied/);
  expect((await run('SELECT id, seq, kind FROM assistant_events'))[0]!.rows).toEqual([]);
  expect((await run('SELECT id, job_id FROM tool_calls'))[0]!.rows).toEqual([]);
  expect((await run('SELECT person_id, program FROM assistants'))[0]!.rows).toEqual([]);
  expect((await run('SELECT id, email, telegram_username FROM people'))[0]!.rows).toEqual([]);
  const { rows } = await client.query<{ table_name: string; column_name: string; readable: boolean }>(`
    SELECT table_name, column_name, has_column_privilege('${role}', quote_ident(table_name), column_name, 'SELECT') AS readable
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position
  `);
  expect(rows.filter(row => isKey(row.column_name) && row.readable)).toEqual([]);
  expect((await run('SELECT id, name FROM agents'))[0]!.rows).toEqual([]);
  await expect(run('UPDATE agents SET name = name WHERE false')).resolves.toBeDefined();
  await client.exec(`GRANT SELECT (data) ON assistant_events TO "${role}"; GRANT SELECT (password_hash) ON people TO "${role}"`);
  await client.exec(grantsFor(role));
  for (const text of ['SELECT data FROM assistant_events', 'SELECT password_hash FROM people']) {
    await expect(run(text), text).rejects.toThrow(/permission denied/);
  }
});

/* A hidden value's fingerprint is its sha256 with no salt; with its length, a weak password is found again by trying. The
   orchestrator reads who hid what and when, never these two, nor the window's hash, a key by its name. */
it('keeps the fingerprint and the length of a hidden value from the orchestrator', async () => {
  const { role, run, client } = await access();
  for (const text of [
    'SELECT fingerprint FROM secret_redactions',
    'SELECT characters FROM secret_redactions',
    'SELECT window_hash FROM secret_redactions',
    'SELECT r.* FROM secret_redactions r',
    'SELECT to_jsonb(r) FROM secret_redactions r',
    "SELECT id FROM secret_redactions WHERE fingerprint = 'x'",
    'SELECT id FROM secret_redactions WHERE characters > 7',
  ]) await expect(run(text), text).rejects.toThrow(/permission denied/);
  expect((await run('SELECT id, company_id, person_id, created_at FROM secret_redactions'))[0]!.rows).toEqual([]);
  const { rows } = await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'secret_redactions'
      AND has_column_privilege('${role}', 'secret_redactions', column_name, 'SELECT') ORDER BY column_name
  `);
  expect(rows.map(row => row.column_name)).toEqual(['company_id', 'created_at', 'id', 'person_id']);
});
