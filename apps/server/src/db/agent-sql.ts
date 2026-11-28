import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { APP_NAME, openPool, stripSettings } from './client.js';
import { confirmCommits, keepErrors } from './confirm.js';
import { writeGate } from './gate.js';
import { REFUSED_FUNCTIONS } from './sql-check.js';

export { REFUSED_FUNCTIONS };

/* What one statement gave back: its rows, and how many rows it added, changed or removed. */
export type SqlAnswer = { rows: Record<string, unknown>[]; changed: number };

/* write: the orchestrator's, with Hornhoof's own rights over its own connection. read: the head of Operations', which only reads. */
export type SqlMode = 'write' | 'read';

/* A tool call with an id of its own: the answer the agent will read, made from what the statements answered. */
export type SqlCall = { invocation: string; jobId: string; answer: (results: SqlAnswer[]) => unknown };

/* Agents' own way into the database. Each call is one transaction, the orchestrator's as Hornhoof itself, Operations' under its role. */
export type AgentSql = { run: (text: string, mode: SqlMode, call?: SqlCall) => Promise<SqlAnswer[]>; close: () => Promise<void> };

/* Tables Operations does not read at all. Signing in, joining and installing a node stay out of its reach, and so does
   the public link, whose address goes into machine commands. Plans' sealed sign-ins too: a row put there would reach a
   node as its plan's sign-in. Waits' owners, dates and policies too: a row written by hand could move a promise or quiet
   an alarm, and they name private work. The link's certificate too: it holds the sealed keys, and its mode decides how
   the link runs. And the count of failed sign-ins, as a row taken out of it would give a guesser more tries. The keys of
   git hosts Hornhoof creates repositories with too: a row put there would send a new repository and its key to another
   account. */
export const HIDDEN = ['secret_redactions', 'sessions', 'invites', 'node_codes', 'public_links', 'plan_credentials', 'request_internal', 'task_waits', 'wait_policies', 'sign_in_attempts', 'link_tls', 'applied', 'tool_calls', 'authority', 'certificates', 'revoked_certificate_serials', 'peer_secrets', 'machine_tickets', 'machine_online', 'person_keys', 'machine_access', 'computer_runs', 'recovery_keys', 'repo_hosts', 'google_sheets', 'vault_entries', 'vault_log', 'company_phones', 'phone_sessions', 'phone_frames'];
/* Columns that hold a password, a token or a key, or private words: Operations reads none of them. A machine's key goes with
   every join from it, so it is one too. The account a node is signed in to names a person's email. A file's hash names
   its content, so with it a guess at a person's file could be confirmed. */
export const SECRET: Record<string, string[]> = {
  people: ['password_hash'],
  jobs: ['tool_token_hash'],
  subscriptions: ['secret_enc'],
  nodes: ['key_hash', 'account'],
  machines: ['machine_key'],
  departments: ['repo_token_enc', 'repo_token_revision'],
  program_operator_cases: ['capability'],
  attachments: ['bytes', 'sha256'],
  assistants: ['key_hash', 'wake_secret_enc'],
  telegram_bots: ['token_enc'],
  telegram_incoming: ['payload_enc'],
  requests: ['text', 'options', 'explained', 'answer', 'link', 'source_key', 'source_job_id', 'source_sequence', 'triage_agent_id', 'classification'],
  proposals: ['material_snapshot', 'brief', 'items', 'source_key', 'source_job_id', 'source_sequence', 'triage_agent_id', 'classification'],
};
/* Personal assistants' tables, which Operations does not read. */
export const ASSISTANT_TABLES = ['assistants', 'assistant_events', 'assistant_seqs', 'assistant_replies', 'assistant_requests'];
const READER_SECRET = Object.keys(SECRET).filter(table => !ASSISTANT_TABLES.includes(table));
const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/* The rights stay the first guard, whatever the check of the text sees: PUBLIC loses EXECUTE on every overload of these, in the
   catalog of this database, so Operations' role cannot call them. Runs at every start, so a new overload is covered too. */
export const REFUSED_NAME_PATTERN = `^(${REFUSED_FUNCTIONS.map(name => name.replace('*', '.*')).join('|')})$`;
export const PUBLIC_REVOKES = `DO $revokes$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pg_catalog' AND p.proname ~ '${REFUSED_NAME_PATTERN}' LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $revokes$`;

/* What the orchestrator's call runs right before its COMMIT. Its text may have set any of these for the transaction, and the lease must
   still hold after what the text took: a margin, as the commit itself still takes a moment. */
export const PRE_COMMIT_SETTINGS = 'SET LOCAL synchronous_commit = on; SET LOCAL statement_timeout = 0; SET LOCAL client_min_messages = warning';
export const PRE_COMMIT = `${PRE_COMMIT_SETTINGS}; SELECT net.assert_lease('2 s', NULL)`;
/* The same check for a tool call that front gave an id: it also keeps the call's answer and lists the call as applied, in
   the change's own commit. */
export const RECORD_CALL = "SELECT net.assert_lease('2 s', $1, $2, $3::jsonb)";

/* One role per database, so two Hornhoofs on one Postgres do not share it. */
const roleOf = (database: string, suffix: string) => `${database.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63 - suffix.length)}${suffix}`;
export const readerRole = (database: string) => roleOf(database, '_reader');
/* The role builds before 0.32.0 gave the orchestrator, with fewer rights than Hornhoof's own. */
export const formerAgentRole = (database: string) => roleOf(database, '_agent');

/* The orchestrator has every right of Hornhoof itself (Ivan's word of 17 November 2026), so the role it had goes at the
   start, with what it held, its policies, and its guards on agents. */
export const dropFormerRole = (name: string) => `DO $former$
BEGIN
  DROP TRIGGER IF EXISTS "${name}_head_stays" ON agents;
  DROP TRIGGER IF EXISTS "${name}_assistant_kept" ON agents;
  DROP FUNCTION IF EXISTS hornhoof_head_stays();
  DROP FUNCTION IF EXISTS hornhoof_assistant_kept();
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${name}') THEN
    DROP OWNED BY "${name}";
    DROP ROLE "${name}";
  END IF;
END $former$`;

const quoted = (names: string[]) => `ARRAY[${names.map(n => `'${n}'`).join(', ')}]::text[]`;
/* A table's columns but some, as SQL that lists them for a column grant. */
const columns = (table: string, but: string[] = []) =>
  `(SELECT string_agg(quote_ident(column_name), ', ') FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name <> ALL (${quoted(but)}))`;
const visible = (table: string) => columns(table, SECRET[table] ?? []);
/* A right to read these tables, column by column, without the secret columns. */
const readVisible = (tables: string[], name: string) =>
  tables.map(table => `  EXECUTE format('GRANT SELECT (%s) ON ${table} TO "${name}"', ${visible(table)});`).join('\n');

/* Makes the role or brings its rights up to date, for tables later updates added too, starting from none. It owns
   nothing, so it cannot change the tables themselves, and as no superuser it reads no server files and runs no programs.
   A call may not sit in an open transaction, and how long it may take is the role's own setting. */
const role = (settings: string[], rights: (name: string) => string) => (name: string) => `DO $grants$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE "${name}" NOLOGIN; END IF;
${settings.map(setting => `  ALTER ROLE "${name}" ${setting};`).join('\n')}
  ALTER ROLE "${name}" SET idle_in_transaction_session_timeout = '30s';
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${name}";
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM "${name}";
  GRANT USAGE ON SCHEMA public TO "${name}";
${rights(name)}
END $grants$`;

/* Every table but the hidden ones and those named, one by one. */
const eachTable = (but: string[], grant: string) => `  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> ALL (${quoted([...HIDDEN, ...but])}) LOOP
    EXECUTE format('${grant}', t);
  END LOOP;`;

/* The head of Operations' role reads the rows of every table but the hidden ones, the assistant tables, the assistant
   rows of agents and the secrets, and changes nothing: it has no right to, and each of its transactions is read-only too,
   so a write is told apart from a closed table. It commits nothing, so nothing of the fence is its, and a call may take
   15 seconds. */
export const readerGrantsFor = role(
  ["SET statement_timeout = '15s'"],
  name =>
    `  ALTER ROLE "${name}" SET default_transaction_read_only = on;
${eachTable([...Object.keys(SECRET), ...ASSISTANT_TABLES], `GRANT SELECT ON %I TO "${name}"`)}
${readVisible(READER_SECRET, name)}
  ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS "${name}_agents" ON agents;
  CREATE POLICY "${name}_agents" ON agents FOR SELECT TO "${name}" USING (kind <> 'assistant');`,
);

const answersOf = (result: pg.QueryResult | pg.QueryResult[]): SqlAnswer[] =>
  (Array.isArray(result) ? result : [result]).map(r => ({ rows: r.rows ?? [], changed: WRITES.has(r.command) ? (r.rowCount ?? 0) : 0 }));

/* The text runs between a BEGIN and a COMMIT it did not write. */
export async function inOneTransaction(client: pg.ClientBase, text: string, mode: SqlMode, call?: SqlCall): Promise<SqlAnswer[]> {
  await client.query(mode === 'read' ? 'BEGIN READ ONLY' : 'BEGIN');
  const answers = answersOf((await client.query(text)) as unknown as pg.QueryResult | pg.QueryResult[]);
  if (mode === 'write') await beforeCommit(client, answers, call);
  await client.query('COMMIT');
  return answers;
}

async function beforeCommit(client: pg.ClientBase, answers: SqlAnswer[], call?: SqlCall): Promise<void> {
  if (!call) return void (await client.query(PRE_COMMIT));
  await client.query(PRE_COMMIT_SETTINGS);
  await client.query(RECORD_CALL, [call.invocation, call.jobId, JSON.stringify(call.answer(answers))]);
}

/* The role signs in with a password made fresh at every start and kept only here, over its own small pool. */
async function poolOfRole(admin: pg.Client, url: string, name: string, grants: string): Promise<pg.Pool> {
  const password = randomBytes(24).toString('hex');
  await admin.query(grants);
  await admin.query(`ALTER ROLE "${name}" WITH LOGIN CONNECTION LIMIT 4 PASSWORD '${password}'`);
  const own = new URL(stripSettings(url));
  own.username = name;
  own.password = password;
  const pool = new pg.Pool({ connectionString: own.toString(), max: 2, idleTimeoutMillis: 60_000 });
  pool.on('error', err => console.warn(`Lost an agent's database connection, will open another: ${err.message}`));
  pool.on('connect', client => {
    keepErrors(client);
    confirmCommits(client);
  });
  return pool;
}

/* The orchestrator's text waits at the gate of the app's writes, as the app's own do; Operations' only reads and goes on. */
export const gated = <T>(mode: SqlMode, work: () => Promise<T>): Promise<T> => (mode === 'write' ? writeGate.through(work) : work());

async function runOn(pool: pg.Pool, text: string, mode: SqlMode, call?: SqlCall): Promise<SqlAnswer[]> {
  return gated(mode, () => inOwnTransaction(pool, text, mode, call));
}

async function inOwnTransaction(pool: pg.Pool, text: string, mode: SqlMode, call?: SqlCall): Promise<SqlAnswer[]> {
  const client = await pool.connect();
  try {
    return await inOneTransaction(client, text, mode, call);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* pools collects each one as it opens, so that the caller can end them when a later step fails. The orchestrator's goes as
   Hornhoof's own, fenced as the app is. */
async function openRoles(admin: pg.Client, url: string, fenced: boolean, pools: pg.Pool[]): Promise<AgentSql> {
  await admin.connect();
  await admin.query(PUBLIC_REVOKES);
  const database = (await admin.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
  await admin.query(dropFormerRole(formerAgentRole(database))).catch(err => console.warn(`The orchestrator's former database role stays: ${(err as Error).message}`));
  const write = openPool(url, err => console.warn(`Lost the orchestrator's database connection, will open another: ${err.message}`), APP_NAME, { fenced });
  pools.push(write);
  const read = await poolOfRole(admin, url, readerRole(database), readerGrantsFor(readerRole(database)));
  pools.push(read);
  const byMode = { write, read };
  return {
    run: (text, mode, call) => runOn(byMode[mode], text, mode, call),
    close: async () => {
      await Promise.all(pools.map(p => p.end()));
    },
  };
}

/* Null, with a warning, when the database does not let Hornhoof make the role of Operations. */
export async function openAgentSql(url: string, fenced = false): Promise<AgentSql | null> {
  const admin = new pg.Client({ connectionString: url });
  keepErrors(admin);
  const pools: pg.Pool[] = [];
  try {
    return await openRoles(admin, url, fenced, pools);
  } catch (err) {
    await Promise.all(pools.map(p => p.end().catch(() => {})));
    console.warn(`Agents get no database access: ${(err as Error).message}`);
    return null;
  } finally {
    await admin.end().catch(() => {});
  }
}
