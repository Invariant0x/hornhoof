import pg from 'pg';
import { readerRole, REFUSED_NAME_PATTERN } from '../../db/agent-sql.js';
import { APP_NAME, KEEPER_NAME, stripSettings } from '../../db/client.js';
import { keepErrors } from '../../db/confirm.js';
import { FENCE_TRIGGER, JOURNAL_TRIGGER, type LeaseKind, type LeaseSync, type Term } from '../../db/net.js';

/* The keeper's own way to the database: plain statements, one after another. */
export type Sql = { query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }> };

/* What a session that sets nothing itself commits under in this database, and where that comes from, as Postgres words
   it: 'configuration file' for a postgresql.conf or postgresql.auto.conf, 'command line', 'database' or 'user'. */
export type CommitSetting = { setting: string; source: string };

/* The lease as the database holds it. The keeper alone writes it: the app and the agents only stand on it, through
   net.assert_lease, and have no right to these tables. */
export type LeaseStore = {
  /* Ends what was held, then a new term above every one this database has seen, in this machine's name. term: the
     term to take, when the keeper was promised one: exactly it, and nothing changes when it is not this machine's or
     not above every term this database has seen. */
  take(kind: LeaseKind, until: Date, sync?: LeaseSync, term?: Term): Promise<Term>;
  /* False when the lease is no longer that term's or has ended: a lease that lapsed is never brought back, only taken anew. */
  renew(term: Term, kind: LeaseKind, until: Date, endSessions: boolean, sync?: LeaseSync): Promise<boolean>;
  fence(): Promise<void>;
  /* How many sessions of the app and the agents it ended. */
  endSessions(): Promise<number>;
  /* What keeps this machine from leading, a line each; none when every fence holds. */
  problems(): Promise<string[]>;
  /* What a session that sets no commit setting of its own gets here. net.assert_lease lets a commit through only under on. */
  commitSetting(): Promise<CommitSetting>;
  /* Puts it right for the sessions there are and the ones to come, as the server's own file: ALTER SYSTEM and a reload. */
  commitOn(): Promise<void>;
  /* How many rows past their day it removed, of the journal, the sources and the kept answers of tool calls, while this
     machine keeps the data alone and nobody reads them. */
  prune(batch?: number): Promise<number>;
  /* Whether another machine is listed as keeping the company's data. Null: it cannot be told now. */
  othersHoldData(): Promise<boolean | null>;
  close(): Promise<void>;
};

export const PRUNE_BATCH = 10_000;

/* The highest term this database has seen, 0 for one that saw none. */
const SEEN_TERM = `SELECT COALESCE(GREATEST((SELECT max(term_number) FROM net_local.state), (SELECT max(term_number) FROM net_local.lease)), 0)::int AS number`;

/* $5: the term's number when one is given, which is taken only while it is above every term seen; else the next. */
const TAKE = `WITH seen AS (
    SELECT COALESCE(GREATEST((SELECT max(term_number) FROM net_local.state), (SELECT max(term_number) FROM net_local.lease)), 0) AS number
  ), next AS (
    SELECT COALESCE($5::bigint, seen.number + 1) AS number FROM seen WHERE $5::bigint IS NULL OR $5::bigint > seen.number
  ), st AS (
    INSERT INTO net_local.state (term_number, term_machine, term_split, machine, cluster)
    SELECT next.number, $1, false, $1, (SELECT system_identifier::text FROM pg_control_system()) FROM next
    ON CONFLICT (id) DO UPDATE SET term_number = EXCLUDED.term_number, term_machine = EXCLUDED.term_machine, term_split = false, machine = EXCLUDED.machine
    RETURNING term_number
  )
  INSERT INTO net_local.lease (term_number, term_machine, term_split, kind, until, sync)
  SELECT st.term_number, $1, false, $2, $3, $4 FROM st
  ON CONFLICT (id) DO UPDATE SET term_number = EXCLUDED.term_number, term_machine = EXCLUDED.term_machine, term_split = false, kind = EXCLUDED.kind, until = EXCLUDED.until, sync = EXCLUDED.sync
  RETURNING term_number::int AS number`;

/* The flag in the same statement as the new end, so no lease ever stands longer under a flag that holds no more. A
   renewal that names no flag keeps the one the lease has. */
const RENEW = `UPDATE net_local.lease SET kind = $4, until = $5, sync = COALESCE($6, sync)
  WHERE (term_number, term_machine, term_split) = ($1, $2, $3) AND until > clock_timestamp() RETURNING 1`;

const FENCE = `UPDATE net_local.lease SET until = '-infinity'`;

const END_SESSIONS = `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS ended FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid() AND (application_name = $1 OR usename = ANY($2::text[]))`;

/* One statement, so that all three go or none: journal rows, the steps of sources, and the kept answers of tool calls whose
   job no longer runs, each older than the bound and a batch at most. Only while this machine's lease stands under a
   flag, and no merge waits to be applied or checked, as a merge reads the journal from where the two sides parted.
   The bound is a day ago. A page sends a change again for a minute after its first failure and front a tool call for
   50 seconds, so a day is far past every retry of theirs. A node sends a message again for as long as it is not
   confirmed, however long it was away: the steps of its messages go all the same, and its stream's floor rises to the
   last message whose steps went, below which a message counts as handled.
   Where other machines keep copies, the bound is a day before what the oldest copy that follows already holds: a copy
   knows by the leader's pulse how far it reaches, whatever is newer stays for it, and a merge of it reads the journal
   from a day before where the two parted. A copy still being made, one that stopped, one whose slot is lost, and one
   silent for over a week make themselves again from what the leader holds then, or are merged row by row, and hold
   nothing back. A prune that took a journal row says how far back the journal now goes, never less far than it said
   before, and lets go of what merges noted of rows older than that. */
const HELD = `EXISTS (SELECT FROM net_local.lease WHERE sync IS NOT NULL AND until > clock_timestamp()) AND NOT EXISTS (SELECT FROM net.merges WHERE status IN ('pending', 'applied'))`;
const KEPT = `interval '1 day'`;
const COPY_HOLDS = `interval '7 days'`;
const COPIES_HOLD = `COALESCE((
    SELECT min(m.copy_at) FROM public.machines m
    WHERE m.role = 'data' AND m.revoked_at IS NULL AND m.network_id IS DISTINCT FROM $2 AND m.copy_state = 'ready' AND m.copy_at > now() - ${COPY_HOLDS}
      AND NOT EXISTS (SELECT FROM pg_replication_slots slot WHERE slot.slot_name = m.copy_name AND slot.wal_status = 'lost')
  ), 'infinity') - ${KEPT}`;
/* A step of a node's message, node:<node>:<stream>:<message>: its stream and its message's number. */
const NODE_STEP = `'^(node:[^:]+:[^:]+):([0-9]+)$'`;
const pruneWith = (copies: boolean): string => `WITH bound AS (
    SELECT LEAST(now() - ${KEPT}${copies ? `, ${COPIES_HOLD}` : ''}) AS below
  ), journal_gone AS (
    DELETE FROM net.journal WHERE id IN (SELECT id FROM net.journal WHERE at < (SELECT below FROM bound) ORDER BY at LIMIT $1) AND ${HELD} RETURNING 1
  ), sources_gone AS (
    DELETE FROM public.applied WHERE source IN (SELECT source FROM public.applied WHERE at < (SELECT below FROM bound) ORDER BY at LIMIT $1) AND ${HELD} RETURNING base
  ), floors AS (
    INSERT INTO public.node_stream_floors (stream, upto)
    SELECT (regexp_match(base, ${NODE_STEP}))[1], max((regexp_match(base, ${NODE_STEP}))[2]::bigint) FROM sources_gone WHERE base ~ ${NODE_STEP} GROUP BY 1
    ON CONFLICT (stream) DO UPDATE SET upto = GREATEST(public.node_stream_floors.upto, EXCLUDED.upto) RETURNING 1
  ), calls_gone AS (
    DELETE FROM public.tool_calls WHERE id IN (
      SELECT c.id FROM public.tool_calls c JOIN public.jobs j ON j.id = c.job_id WHERE c.at < (SELECT below FROM bound) AND j.status <> 'running' ORDER BY c.at LIMIT $1
    ) AND ${HELD} RETURNING 1
  ), horizon AS (
    INSERT INTO net.horizon (below) SELECT below FROM bound WHERE EXISTS (SELECT FROM journal_gone)
    ON CONFLICT (id) DO UPDATE SET below = GREATEST(net.horizon.below, EXCLUDED.below) RETURNING below
  ), noted_gone AS (
    DELETE FROM net.merge_consumed WHERE at < (SELECT below FROM horizon) RETURNING 1
  ) SELECT ((SELECT count(*) FROM journal_gone) + (SELECT count(*) FROM sources_gone) + (SELECT count(*) FROM calls_gone))::int AS pruned, $2::text IS NOT NULL AS named`;
/* The keeper of a new build runs a while on the schema of the build before, which knows no copies: it prunes as one
   machine does until the app has migrated. */
const HAS_COPIES = `SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'machines' AND column_name = 'copy_at') AS there`;
/* The keeper of a new build runs a while on the schema of the build before, which has no record of merges or no floors of
   node streams: it prunes nothing until the app has migrated. */
const HAS_MERGES = `SELECT to_regclass('net.merges') IS NOT NULL AND to_regclass('net.horizon') IS NOT NULL AND to_regclass('net.merge_consumed') IS NOT NULL
  AND to_regclass('public.node_stream_floors') IS NOT NULL AS there`;

/* The keeper of a new build runs a while on the schema of the build before, which has no roles yet: it asks first. */
const HAS_ROLES = `SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'machines' AND column_name = 'role') AS there`;
const OTHER_DATA = `SELECT EXISTS (SELECT FROM public.machines WHERE role = 'data' AND revoked_at IS NULL AND network_id IS DISTINCT FROM $1) AS there`;

/* Any right on a table at all. */
const TABLE_RIGHTS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'].join(', ');
/* The tables of public that say where a change came from: an agent that could write them could make a retry run twice. */
const SOURCE_TABLES = ['applied', 'tool_calls', 'node_stream_floors'];

/* Every fence, in the order a person would mend them. A trigger counts only as Hornhoof leaves it: enabled the ordinary
   way, and the fence deferred to the commit. */
const PROBLEMS = `SELECT line FROM (
    SELECT 1 AS at, format('public.%s has no journal trigger', p.name) AS line FROM net.public_tables() p
      WHERE NOT EXISTS (SELECT FROM pg_trigger t WHERE t.tgrelid = p.tbl AND t.tgname = '${JOURNAL_TRIGGER}' AND t.tgenabled = 'O')
    UNION ALL
    SELECT 2, format('net.%s has no fence trigger', c.relname) FROM pg_class c
      WHERE c.relnamespace = 'net'::regnamespace AND c.relkind = 'r'
        AND NOT EXISTS (SELECT FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = '${FENCE_TRIGGER}' AND t.tgenabled = 'O' AND t.tgdeferrable AND t.tginitdeferred)
    UNION ALL
    SELECT 3, format('PUBLIC may still run %s', p.oid::regprocedure) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE ((n.nspname = 'pg_catalog' AND p.proname ~ $1) OR n.nspname = 'net') AND has_function_privilege('public', p.oid, 'EXECUTE')
    UNION ALL
    SELECT 4, format('%s is a superuser', r.rolname) FROM pg_roles r WHERE r.rolname = ANY($2::text[]) AND r.rolsuper
    UNION ALL
    SELECT 5, format('%s may signal other sessions', r.rolname) FROM pg_roles r
      WHERE r.rolname = ANY($2::text[]) AND pg_has_role(r.oid, 'pg_signal_backend', 'MEMBER')
    UNION ALL
    SELECT 6, format('%s may reach %s.%s', r.rolname, n.nspname, c.relname) FROM pg_roles r, pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE r.rolname = ANY($2::text[]) AND c.relkind = 'r'
        AND (n.nspname IN ('net', 'net_local') OR (n.nspname = 'public' AND c.relname = ANY($3::text[])))
        AND has_table_privilege(r.oid, c.oid, '${TABLE_RIGHTS}')
    UNION ALL
    SELECT 7, format('%s may run %s', r.rolname, p.oid::regprocedure) FROM pg_roles r, pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE r.rolname = ANY($2::text[]) AND n.nspname = 'net' AND p.proname <> 'assert_lease' AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
    UNION ALL
    SELECT 8, format('max_prepared_transactions is %s, not 0', current_setting('max_prepared_transactions'))
      WHERE current_setting('max_prepared_transactions') <> '0'
  ) found ORDER BY at, line`;

const COMMIT_SETTING = `SELECT setting, source FROM pg_settings WHERE name = 'synchronous_commit'`;

/* plain: a session that sets nothing, for what a session gets of the database; without one the keeper's own session says,
   which holds a commit setting of its own. It is closed after each look, since a session keeps the settings it opened with. */
export function leaseStore(sql: Sql & { close?(): Promise<void> }, opts: { machineId: string; plain?: Sql & { close?(): Promise<void> } }): LeaseStore {
  /* Operations' role is named after the database, which does not change under a connection; the orchestrator's sessions are the app's. */
  let roles: Promise<string[]> | null = null;
  const agentRoles = (): Promise<string[]> =>
    (roles ??= sql.query<{ name: string }>('SELECT current_database() AS name').then(({ rows }) => [readerRole(rows[0]!.name)]));
  const endSessions = async (): Promise<number> => (await sql.query<{ ended: number }>(END_SESSIONS, [APP_NAME, await agentRoles()])).rows[0]!.ended;
  const fence = async (): Promise<void> => {
    await sql.query(FENCE);
    await endSessions();
  };
  return {
    async take(kind, until, sync = 'alone', term) {
      if (term) {
        /* Looked at before anything ends, so a term that cannot be taken leaves the lease as it stands. */
        const seen = (await sql.query<{ number: number }>(SEEN_TERM)).rows[0]!.number;
        if (term.machine !== opts.machineId || term.split || term.number <= seen) throw new Error(`the term ${term.number} of ${term.machine} cannot be taken here: this database stands under term ${seen}`);
      }
      await fence();
      const { rows } = await sql.query<{ number: number }>(TAKE, [opts.machineId, kind, until, sync, term?.number ?? null]);
      if (!rows[0]) throw new Error(`the term ${String(term?.number)} is not above every term this database has seen`);
      return { number: rows[0].number, machine: opts.machineId, split: false };
    },
    async renew(term, kind, until, ending, sync) {
      const { rows } = await sql.query(RENEW, [term.number, term.machine, term.split, kind, until, sync ?? null]);
      if (rows.length === 0) return false;
      if (ending) await endSessions();
      return true;
    },
    fence,
    endSessions,
    problems: async () => (await sql.query<{ line: string }>(PROBLEMS, [REFUSED_NAME_PATTERN, await agentRoles(), SOURCE_TABLES])).rows.map(row => row.line),
    async commitSetting() {
      try {
        return (await (opts.plain ?? sql).query<CommitSetting>(COMMIT_SETTING)).rows[0]!;
      } finally {
        await opts.plain?.close?.();
      }
    },
    async commitOn() {
      await sql.query(`ALTER SYSTEM SET synchronous_commit = 'on'`);
      await sql.query('SELECT pg_reload_conf()');
    },
    prune: async (batch = PRUNE_BATCH) => {
      if (!(await sql.query<{ there: boolean }>(HAS_MERGES)).rows[0]!.there) return 0;
      const copies = (await sql.query<{ there: boolean }>(HAS_COPIES)).rows[0]!.there;
      return (await sql.query<{ pruned: number }>(pruneWith(copies), [batch, opts.machineId])).rows[0]!.pruned;
    },
    /* The lease says this machine keeps the data alone. With another data machine listed that would be untrue, and the
       two could both lead: this machine then holds no such lease. */
    async othersHoldData() {
      try {
        if (!(await sql.query<{ there: boolean }>(HAS_ROLES)).rows[0]!.there) return false;
        return (await sql.query<{ there: boolean }>(OTHER_DATA, [opts.machineId])).rows[0]!.there;
      } catch {
        return null;
      }
    },
    close: async () => {
      await sql.close?.();
      await opts.plain?.close?.();
    },
  };
}

/* One connection at a time under the keeper's name, with no statement timeout of the database's own: each connect and each
   query has timeoutMs, and one that fails or runs out drops its connection without waiting for it to end, so the next
   query opens a new one. A timeout given as a function is read at each connect and each query, so it can follow what
   the disk measures. A commit counts here once this machine wrote it (synchronous_commit local): the lease is a fact
   of this machine alone. Queries run one after another, each waiting for the one before to settle. plain: a session with
   no setting of its own, as any session left to the database's would be. */
export function keeperSql(url: string, opts: { timeoutMs?: number | (() => number); plain?: boolean } = {}): Sql & { close(): Promise<void> } {
  const given = opts.timeoutMs ?? 2000;
  const timeoutMs = (): number => (typeof given === 'function' ? given() : given);
  let client: pg.Client | null = null;
  let last: Promise<unknown> = Promise.resolve();
  const drop = (): void => {
    const gone = client;
    client = null;
    void gone?.end().catch(() => {});
  };
  const connected = async (): Promise<pg.Client> => {
    if (client) return client;
    const next = new pg.Client({ connectionString: stripSettings(url), application_name: KEEPER_NAME, ...(opts.plain ? {} : { options: '-c synchronous_commit=local' }), connectionTimeoutMillis: timeoutMs() });
    keepErrors(next);
    next.on('error', () => { if (client === next) client = null; });
    await next.connect();
    client = next;
    return next;
  };
  const run = async <R>(text: string, params?: unknown[]): Promise<{ rows: R[] }> => {
    try {
      const client = await connected();
      const statement: pg.QueryConfig & { query_timeout: number } = { text, values: params, query_timeout: timeoutMs() };
      const { rows } = await client.query(statement);
      return { rows: rows as R[] };
    } catch (err) {
      drop();
      throw err;
    }
  };
  return {
    query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }> {
      const answer = last.then(() => run<R>(text, params));
      last = answer.catch(() => {});
      return answer;
    },
    async close() {
      await last;
      drop();
    },
  };
}

/* The name a lease is held under on a machine that was given no id. */
export const UNNAMED_MACHINE = 'unnamed';

/* The lease is held in this machine's database, so without one there is none to hold. A machine without an id, as a
   company started from the compose file by hand is, still leads: under a name of its own, alone, and in no network. */
export function leaseOfMachine(
  config: { databaseUrl?: string | null; machineId: string | null },
  log: (line: string) => void,
  open: (url: string) => Sql & { close?(): Promise<void> } = keeperSql,
  plain: (url: string) => Sql & { close?(): Promise<void> } = url => keeperSql(url, { plain: true, timeoutMs: 5000 }),
): LeaseStore | null {
  if (!config.databaseUrl) {
    log('The keeper takes no lease: DATABASE_URL is not set.');
    return null;
  }
  if (!config.machineId) log('HORNHOOF_MACHINE_ID is not set, so this machine leads under a name of its own and joins no network. Run the install command to give it one.');
  return leaseStore(open(config.databaseUrl), { machineId: config.machineId ?? UNNAMED_MACHINE, plain: plain(config.databaseUrl) });
}
