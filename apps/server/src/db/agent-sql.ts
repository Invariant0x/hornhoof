import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { stripSettings } from './client.js';
import { confirmCommits, keepErrors } from './confirm.js';
import { writeGate } from './gate.js';
import { REFUSED_FUNCTIONS } from './sql-check.js';

export { REFUSED_FUNCTIONS };

/* What one statement gave back: its rows, and how many rows it added, changed or removed. */
export type SqlAnswer = { rows: Record<string, unknown>[]; changed: number };

/* write: the orchestrator's, which reads and changes rows. read: the head of Operations', which only reads. */
export type SqlMode = 'write' | 'read';

/* A tool call with an id of its own: the answer the agent will read, made from what the statements answered. */
export type SqlCall = { invocation: string; jobId: string; answer: (results: SqlAnswer[]) => unknown };

/* Agents' own way into the database. Each call is one transaction under the role of its mode. */
export type AgentSql = { run: (text: string, mode: SqlMode, call?: SqlCall) => Promise<SqlAnswer[]>; close: () => Promise<void> };

/* Signing in, joining and installing a node stay out of reach, and so does the public link, whose address goes into
   machine commands. Plans' sealed sign-ins too: a row put there would reach a node as its plan's sign-in. Checks made
   by a model too: their held-out examples stay away from who tunes a prompt, and no row put there can turn a check on.
   The outbound gateway too: contacts and payloads are private, and a row put there would forge an approval, a receipt,
   a consent, a day's count or a line of who set it up, even from a turn of the orchestrator answering the CEO. Waits'
   owners, dates and policies too: a row written by hand could move a promise or quiet an alarm, and they name private
   work. The link's certificate too: it holds the sealed keys, and its mode decides how the link runs. And the count of
   failed sign-ins, as a row taken out of it would give a guesser more tries. The keys of git hosts Hornhoof creates
   repositories with too: a row put there would send a new repository and its key to another account. */
const OUTBOUND = [
  'outbound_channels', 'outbound_policies', 'outbound_accounts', 'outbound_bindings', 'outbound_catalog_revisions', 'outbound_contacts', 'outbound_permissions', 'outbound_contact_events',
  'outbound_messages', 'outbound_message_revisions', 'outbound_approvals', 'outbound_review_receipts', 'outbound_daily_usage', 'outbound_attempts', 'outbound_events', 'outbound_sampling_counters',
  'outbound_setup_events',
  'support_tickets', 'support_classifications',
];
export const HIDDEN = ['sessions', 'invites', 'node_codes', 'public_links', 'plan_credentials', 'request_internal', 'model_checks', 'model_check_revisions', 'model_check_datasets', 'model_check_evaluations', 'model_check_certificates', 'task_waits', 'wait_policies', 'sign_in_attempts', 'link_tls', 'applied', 'tool_calls', 'authority', 'certificates', 'peer_secrets', 'machine_tickets', 'machine_online', 'person_keys', 'machine_access', 'computer_runs', 'recovery_keys', 'repo_hosts', 'google_sheets', 'vault_entries', 'vault_log', 'company_phones', 'phone_sessions', 'phone_frames', ...OUTBOUND];
/* Columns that hold a password, a token or a key: neither role reads or writes them. A machine's key goes with
   every join from it, so it is one too. The account a node is signed in to names a person's email. */
export const SECRET: Record<string, string[]> = {
  people: ['password_hash'],
  jobs: ['tool_token_hash'],
  subscriptions: ['secret_enc'],
  nodes: ['key_hash', 'account'],
  machines: ['machine_key'],
  departments: ['repo_token_enc', 'repo_token_revision'],
  program_operator_cases: ['capability'],
  attachments: ['bytes'],
  assistants: ['key_hash', 'wake_secret_enc'],
  telegram_bots: ['token_enc'],
  requests: ['text', 'options', 'explained', 'answer', 'link', 'source_key', 'source_job_id', 'source_sequence', 'triage_agent_id', 'classification'],
  proposals: ['material_snapshot', 'brief', 'items', 'source_key', 'source_job_id', 'source_sequence', 'triage_agent_id', 'classification'],
};
/* Who people are and what they reach, and the subscriptions, machines and nodes the company runs on: the orchestrator's
   role reads them, and they change only through the tools the CEO alone may ask for. The history of the nodes' connections,
   which only Hornhoof writes, so that it can be believed. Test and work runs too, as they
   carry a repository's token and the task's files to the machines lent to them. And what waits for people's decisions
   with the logs that say who wrote and who decided: a request closes only through answer_request, in a turn of a person
   who may take it, and a forged message would make a turn answer someone else. The numbers of the pipeline report, which
   only Hornhoof works out, so that they can be believed. Which test files passed and what their runs keep, as a forged row
   would let a test go unrun. Where a product's harness stands, as a forged row would hold its machines back from building
   or quiet what its head hears. A department's rules of approval, which say what a person must see first, and change only
   through a person's guarded API. An employee's inbox, whose letters name who wrote them: a forged one would put words in
   a person's or an employee's mouth, so only Hornhoof keeps it and the employee marks it with inbox_mark. What each turn
   used of its subscription, which Hornhoof writes as the node told it, so that what a connection costs can be believed. A
   head's Telegram bot, which only a person sets on its card, with its token kept from both roles. Which employee works on a
   fallback plan and the plan it goes back to, which only Hornhoof writes, as a forged row would move it to another plan. */
export const ASSISTANT_TABLES = ['assistants', 'assistant_events', 'assistant_seqs', 'assistant_replies', 'assistant_requests'];
const READ_ONLY = [
  'people', 'person_access', 'subscriptions', 'machines', 'nodes', 'node_connections', 'test_runs', 'test_parts',
  'requests', 'proposals', 'agent_events', 'task_events', 'goal_events', 'program_instances', 'program_deliveries',
  'program_operator_cases', 'program_operator_signals', 'wait_notices', 'person_changes', 'attachments',
  'turn_snapshots', 'test_part_timings', 'test_file_results', 'test_suite_memory', 'harness_builds', 'harness_products', 'approval_policies',
  'autonomous_releases', 'agent_inbox', 'turn_tokens', 'telegram_bots', 'agent_fallbacks',
  ...ASSISTANT_TABLES,
];
const READER_SECRET = Object.keys(SECRET).filter(table => !ASSISTANT_TABLES.includes(table));
/* An employee's fields that give it tools, a place or the machine its turns and their tokens go to: they change only by
   hiring and on its card, which make the CEO's checks. A head's department is held by a trigger, as a column right
   cannot tell a head from a worker. */
const AGENT_FIXED = ['kind', 'role_key', 'skills', 'subscription_id', 'node_id'];
/* Where a department's agents push their work, and what lets a commit past GitHub's tests: set only with set_repository. */
const REPOSITORY = ['repo_url', 'repo_branch', 'repo_token_last4', 'repo_author_name', 'repo_author_email', 'repo_full_test_command'];
/* Settings change only through a person's guarded API, never through generic SQL. So does who owns a department, as its
   owner decides what its agents send out, and its autonomous release, which lets its commits reach main without a person. */
const DEPARTMENT_SETTINGS = [...REPOSITORY, 'owner_person_id', 'autonomous_release'];
/* What of a turn the orchestrator may change, to close one that hangs. */
const JOB_STATUS = ['status', 'error', 'finished_at'];
/* How urgent work is changes only through the CEO's route and tools, which keep a tree of tasks as urgent as its top. */
const URGENCY: Record<string, string[]> = { tasks: ['urgent'], teams: ['urgent_only'] };
const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/* Whether the orchestrator's own SQL may change this column: what its role is granted below, said once more for
   whatever else lets the orchestrator write a value of its own. */
export function orchestratorWrites(table: string, column: string): boolean {
  if (HIDDEN.includes(table) || READ_ONLY.includes(table) || SECRET[table]?.includes(column)) return false;
  if (table === 'departments') return !DEPARTMENT_SETTINGS.includes(column);
  if (table === 'agents') return !AGENT_FIXED.includes(column);
  if (table === 'jobs') return JOB_STATUS.includes(column);
  return !URGENCY[table]?.includes(column);
}

/* The rights stay the first guard, whatever the check of the text sees: PUBLIC loses EXECUTE on every overload of these, in the
   catalog of this database, so neither role can call them. Runs at every start, so a new overload is covered too. */
export const REFUSED_NAME_PATTERN = `^(${REFUSED_FUNCTIONS.map(name => name.replace('*', '.*')).join('|')})$`;
export const PUBLIC_REVOKES = `DO $revokes$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pg_catalog' AND p.proname ~ '${REFUSED_NAME_PATTERN}' LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $revokes$`;

/* What the write role runs right before its COMMIT. Its text may have set any of these for the transaction, and the lease must
   still hold after what the text took: a margin, as the commit itself still takes a moment. */
export const PRE_COMMIT_SETTINGS = 'SET LOCAL synchronous_commit = on; SET LOCAL statement_timeout = 0; SET LOCAL client_min_messages = warning';
export const PRE_COMMIT = `${PRE_COMMIT_SETTINGS}; SELECT net.assert_lease('2 s', NULL)`;
/* The same check for a tool call that front gave an id: it also keeps the call's answer and lists the call as applied, in
   the change's own commit. */
export const RECORD_CALL = "SELECT net.assert_lease('2 s', $1, $2, $3::jsonb)";

/* One pair of roles per database, so two Hornhoofs on one Postgres do not share them. */
const roleOf = (database: string, suffix: string) => `${database.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63 - suffix.length)}${suffix}`;
export const agentRole = (database: string) => roleOf(database, '_agent');
export const readerRole = (database: string) => roleOf(database, '_reader');

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

/* The orchestrator's role reads and changes the rows of every table but the hidden ones and the secrets, with these
   exceptions. People, their access, subscriptions, machines and repositories only change through the tools the CEO alone
   may ask for, which make the CEO's checks. An employee is added by hiring, keeps its kind, role, skills and
   subscription but by its card, and a head stays in its department. Of a turn only its status changes, so no token is
   forged or swapped. An assistant and its own agent are their owner's: neither changes here, nor what the assistant reads,
   so no key is forged and no answer goes elsewhere. A call may take 5 seconds before its commit, and the only thing of
   the fence it reaches is the check right before that commit. */
export const grantsFor = role(
  ['RESET statement_timeout', "SET transaction_timeout = '5s'"],
  name =>
    `${eachTable([...READ_ONLY, 'agents', 'jobs', 'departments', ...Object.keys(URGENCY), ...Object.keys(SECRET)], `GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO "${name}"`)}
${Object.entries(URGENCY).map(([table, but]) => `  EXECUTE format('GRANT SELECT (%1$s), DELETE ON ${table} TO "${name}"; GRANT INSERT (%2$s), UPDATE (%2$s) ON ${table} TO "${name}"', ${visible(table)}, ${columns(table, [...but, ...(SECRET[table] ?? [])])});`).join('\n')}
${readVisible(READ_ONLY, name)}
  EXECUTE format('GRANT SELECT (%1$s), INSERT (%2$s), UPDATE (%2$s), DELETE ON departments TO "${name}"', ${visible('departments')}, ${columns('departments', [...SECRET.departments!, ...DEPARTMENT_SETTINGS])});
  EXECUTE format('GRANT SELECT (%s), UPDATE (%s) ON agents TO "${name}"', ${visible('agents')}, ${columns('agents', AGENT_FIXED)});
  EXECUTE format('GRANT SELECT (%s), UPDATE (${JOB_STATUS.join(', ')}) ON jobs TO "${name}"', ${visible('jobs')});
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${name}";
  GRANT USAGE ON SCHEMA net TO "${name}";
  GRANT EXECUTE ON FUNCTION net.assert_lease(interval, uuid) TO "${name}";
  GRANT EXECUTE ON FUNCTION net.assert_lease(interval, uuid, uuid, jsonb) TO "${name}";
  EXECUTE $trigger$
    CREATE OR REPLACE FUNCTION hornhoof_head_stays() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      RAISE EXCEPTION 'permission denied for table agents: a head stays in its department' USING ERRCODE = 'insufficient_privilege';
    END $body$
  $trigger$;
  DROP TRIGGER IF EXISTS "${name}_head_stays" ON agents;
  EXECUTE $trigger$
    CREATE TRIGGER "${name}_head_stays" BEFORE UPDATE OF department_id ON agents FOR EACH ROW
      WHEN (OLD.kind = 'head' AND OLD.department_id IS DISTINCT FROM NEW.department_id AND current_user = '${name}')
      EXECUTE FUNCTION hornhoof_head_stays()
  $trigger$;
  EXECUTE $trigger$
    CREATE OR REPLACE FUNCTION hornhoof_assistant_kept() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      RAISE EXCEPTION 'permission denied for table agents: an assistant''s own agent belongs to its owner' USING ERRCODE = 'insufficient_privilege';
    END $body$
  $trigger$;
  DROP TRIGGER IF EXISTS "${name}_assistant_kept" ON agents;
  EXECUTE $trigger$
    CREATE TRIGGER "${name}_assistant_kept" BEFORE UPDATE ON agents FOR EACH ROW
      WHEN (OLD.kind = 'assistant' AND current_user = '${name}')
      EXECUTE FUNCTION hornhoof_assistant_kept()
  $trigger$;
  ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS "${name}_agents" ON agents;
  CREATE POLICY "${name}_agents" ON agents TO "${name}" USING (true) WITH CHECK (true);`,
);

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

/* Each role signs in with a password made fresh at every start and kept only here, over its own small pool. */
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

/* An agent's text that may write waits at the gate of the app's writes, as the app's own do; one that reads goes on. */
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

/* pools collects each one as it opens, so that the caller can end them when a later step fails. */
async function openRoles(admin: pg.Client, url: string, pools: pg.Pool[]): Promise<AgentSql> {
  await admin.connect();
  await admin.query(PUBLIC_REVOKES);
  const open = async (name: string, grants: string): Promise<pg.Pool> => {
    const pool = await poolOfRole(admin, url, name, grants);
    pools.push(pool);
    return pool;
  };
  const database = (await admin.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
  const byMode = { write: await open(agentRole(database), grantsFor(agentRole(database))), read: await open(readerRole(database), readerGrantsFor(readerRole(database))) };
  return {
    run: (text, mode, call) => runOn(byMode[mode], text, mode, call),
    close: async () => {
      await Promise.all(pools.map(p => p.end()));
    },
  };
}

/* Null, with a warning, when the database does not let Hornhoof make roles. */
export async function openAgentSql(url: string): Promise<AgentSql | null> {
  const admin = new pg.Client({ connectionString: url });
  keepErrors(admin);
  const pools: pg.Pool[] = [];
  try {
    return await openRoles(admin, url, pools);
  } catch (err) {
    await Promise.all(pools.map(p => p.end().catch(() => {})));
    console.warn(`Agents get no database access: ${(err as Error).message}`);
    return null;
  } finally {
    await admin.end().catch(() => {});
  }
}
