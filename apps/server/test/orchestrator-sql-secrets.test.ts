import { expect, it } from 'vitest';
import { agentRole, grantsFor, readerGrantsFor, readerRole } from '../src/db/agent-sql.js';
import { createTestDb, ownDatabases } from './helpers-db.js';

ownDatabases();

async function access() {
  const { $client: client } = await createTestDb();
  const role = agentRole('postgres');
  const reader = readerRole('postgres');
  await client.exec(`${grantsFor(role)};\n${readerGrantsFor(reader)}`);
  const as = (name: string) => (text: string) => client.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE "${name}"`);
    return tx.exec(text);
  });
  return { client, role, run: as(role), read: as(reader) };
}

/* Ivan's word of 17 November 2026: the orchestrator sees everything of the system, its keys and the payloads that carry
   one included. Operations still reads none of them, and what either role may change stays as it was. */
const PAYLOADS = [
  'SELECT data FROM assistant_events',
  'SELECT to_jsonb(e) FROM assistant_events e',
  'SELECT e.* FROM assistant_events e',
  'SELECT answer FROM tool_calls',
  'SELECT events_url, skills_url FROM assistants',
  'SELECT to_jsonb(a) FROM assistants a',
  'SELECT key_hash, wake_secret_enc FROM assistants',
  'SELECT password_hash FROM people',
  'SELECT * FROM people',
  'SELECT tool_token_hash FROM jobs',
  'SELECT key_hash, account FROM nodes',
  'SELECT machine_key FROM machines',
  'SELECT secret_enc FROM subscriptions',
  'SELECT repo_token_enc FROM departments',
  'SELECT token_enc FROM telegram_bots',
  'SELECT capability FROM program_operator_cases',
  'SELECT bytes FROM attachments',
  'SELECT key_enc FROM authority',
  'SELECT secret_enc FROM peer_secrets',
  'SELECT wrapped, salt, iv FROM person_keys',
  'SELECT * FROM sessions',
  'SELECT * FROM plan_credentials',
  'SELECT password_enc FROM vault_entries',
  'SELECT config_enc FROM outbound_accounts',
];

it('lets the orchestrator read every column of every table, keys and secret-bearing payloads too', async () => {
  const { client, role, run } = await access();
  for (const text of PAYLOADS) expect((await run(text))[0]!.rows, text).toEqual([]);
  const { rows } = await client.query<{ table_name: string; column_name: string; readable: boolean }>(`
    SELECT table_name, column_name, has_column_privilege('${role}', quote_ident(table_name), column_name, 'SELECT') AS readable
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position
  `);
  expect(rows.length).toBeGreaterThan(1000);
  expect(rows.filter(row => !row.readable)).toEqual([]);
  /* Column by column: the keeper takes a right on the whole of these for a fence that does not hold. */
  for (const table of ['applied', 'tool_calls']) {
    expect((await client.query<{ has: boolean }>(`SELECT has_table_privilege('${role}', 'public.${table}', 'SELECT') AS has`)).rows, table).toEqual([{ has: false }]);
  }
});

it('keeps those columns from Operations, and every write of the orchestrator as it was', async () => {
  const { run, read } = await access();
  for (const text of ['SELECT data FROM assistant_events', 'SELECT answer FROM tool_calls', 'SELECT password_hash FROM people', 'SELECT key_enc FROM authority', 'SELECT * FROM net.pulse']) {
    await expect(read(text), text).rejects.toThrow(/permission denied/);
  }
  for (const text of [
    "UPDATE people SET password_hash = 'x' WHERE false",
    "UPDATE jobs SET tool_token_hash = 'x' WHERE false",
    "UPDATE assistants SET events_url = 'x' WHERE false",
    "UPDATE departments SET repo_token_enc = 'x' WHERE false",
    "UPDATE tool_calls SET answer = '{}' WHERE false",
    'DELETE FROM assistant_events WHERE false',
    "UPDATE peer_secrets SET secret_enc = 'x' WHERE false",
    'DELETE FROM net.pulse WHERE false',
  ]) await expect(run(text), text).rejects.toThrow(/permission denied/);
  expect((await run('SELECT id, name FROM agents'))[0]!.rows).toEqual([]);
  await expect(run('UPDATE agents SET name = name WHERE false')).resolves.toBeDefined();
});

it('reads every row of a table that keeps its rows from other roles, after an older build granted the whole table too', async () => {
  const { client, role, run } = await access();
  await client.exec("INSERT INTO peer_secrets (kind, secret_enc) VALUES ('app', 'sealed-app-secret')");
  await client.exec(`GRANT SELECT ON assistant_events, peer_secrets TO "${role}"; GRANT SELECT (password_hash) ON people TO "${role}"`);
  await client.exec(grantsFor(role));
  expect((await run('SELECT kind, secret_enc FROM peer_secrets'))[0]!.rows).toEqual([{ kind: 'app', secret_enc: 'sealed-app-secret' }]);
  for (const text of ['SELECT data FROM assistant_events', 'SELECT password_hash FROM people']) expect((await run(text))[0]!.rows, text).toEqual([]);
  await expect(run('DELETE FROM peer_secrets')).rejects.toThrow(/permission denied/);
  expect((await client.query<{ n: number }>('SELECT count(*)::int AS n FROM peer_secrets')).rows).toEqual([{ n: 1 }]);
});
