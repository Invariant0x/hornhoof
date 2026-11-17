import { expect, it } from 'vitest';
import { dropFormerRole, formerAgentRole } from '../src/db/agent-sql.js';
import { agentSqlOn } from './helpers.js';
import { createTestDb, ownDatabases } from './helpers-db.js';

ownDatabases();

/* Ivan's word of 17 November 2026: the orchestrator can do everything, as Hornhoof itself, so it reads and changes the
   keys and the payloads that carry one. Operations still reads none of them and changes nothing. */
const PAYLOADS = [
  'SELECT data FROM assistant_events',
  'SELECT answer FROM tool_calls',
  'SELECT key_hash, wake_secret_enc FROM assistants',
  'SELECT password_hash FROM people',
  'SELECT tool_token_hash FROM jobs',
  'SELECT key_hash, account FROM nodes',
  'SELECT machine_key FROM machines',
  'SELECT secret_enc FROM subscriptions',
  'SELECT repo_token_enc FROM departments',
  'SELECT token_enc FROM telegram_bots',
  'SELECT key_enc FROM authority',
  'SELECT secret_enc FROM peer_secrets',
  'SELECT wrapped, salt, iv FROM person_keys',
  'SELECT * FROM sessions',
  'SELECT * FROM plan_credentials',
  'SELECT password_enc FROM vault_entries',
  'SELECT * FROM net.pulse',
];

it('lets the orchestrator read and change the keys and what carries one, and keeps them from Operations', async () => {
  const sql = agentSqlOn((await createTestDb()).$client);
  for (const text of PAYLOADS) {
    expect((await sql.run(text, 'write'))[0]!.rows, text).toEqual([]);
    await expect(sql.run(text, 'read'), text).rejects.toThrow(/permission denied/);
  }
  await sql.run("INSERT INTO peer_secrets (kind, secret_enc) VALUES ('app', 'sealed-app-secret')", 'write');
  expect((await sql.run('DELETE FROM peer_secrets', 'write'))[0]!.changed).toBe(1);
});

it('drops the role older builds gave the orchestrator, with its rights, policies and guards on agents, and again finds nothing to drop', async () => {
  const { $client: client } = await createTestDb();
  const role = formerAgentRole('postgres');
  await client.exec(`CREATE ROLE "${role}" NOLOGIN;
    GRANT SELECT ON peer_secrets TO "${role}"; GRANT SELECT (password_hash) ON people TO "${role}";
    CREATE POLICY "${role}_agents" ON agents TO "${role}" USING (true);
    CREATE FUNCTION hornhoof_head_stays() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER "${role}_head_stays" BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION hornhoof_head_stays();`);
  await client.exec(dropFormerRole(role));
  await client.exec(dropFormerRole(role));
  const left = await client.query(`SELECT 'role' AS what FROM pg_roles WHERE rolname = '${role}'
    UNION ALL SELECT 'policy' FROM pg_policies WHERE policyname = '${role}_agents'
    UNION ALL SELECT 'trigger' FROM pg_trigger WHERE tgname LIKE '${role}%'
    UNION ALL SELECT 'function' FROM pg_proc WHERE proname IN ('hornhoof_head_stays', 'hornhoof_assistant_kept')`);
  expect(left.rows).toEqual([]);
});

/* The orchestrator uses the application's own connection, including suppression fingerprints. Operations keeps no
   access to the suppression records. */
it('lets the orchestrator read hidden-value fingerprints and keeps them from Operations', async () => {
  const sql = agentSqlOn((await createTestDb()).$client);
  for (const text of [
    'SELECT fingerprint FROM secret_redactions',
    'SELECT characters FROM secret_redactions',
    'SELECT window_hash FROM secret_redactions',
    'SELECT r.* FROM secret_redactions r',
    'SELECT to_jsonb(r) FROM secret_redactions r',
    "SELECT id FROM secret_redactions WHERE fingerprint = 'x'",
    'SELECT id FROM secret_redactions WHERE characters > 7',
    'SELECT id, company_id, person_id, created_at FROM secret_redactions',
  ]) {
    expect((await sql.run(text, 'write'))[0]!.rows, text).toEqual([]);
    await expect(sql.run(text, 'read'), text).rejects.toThrow(/permission denied/);
  }
});
