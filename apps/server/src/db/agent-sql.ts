import { randomBytes } from 'node:crypto';
import pg from 'pg';

/* What one statement gave back: its rows, and how many rows it added, changed or removed. */
export type SqlAnswer = { rows: Record<string, unknown>[]; changed: number };

/* The orchestrator's own way into the database. Each call is one transaction under a role of its own. */
export type AgentSql = { run: (text: string) => Promise<SqlAnswer[]>; close: () => Promise<void> };

/* Signing in, joining and installing a node stay out of reach, and so do passwords and the public link, whose address
   goes into machine commands. */
const HIDDEN = ['sessions', 'invites', 'node_codes', 'public_links'];
const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/* One role per database, so two Hornhoofs on one Postgres do not share it. */
export const agentRole = (database: string) => `${database.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_agent`.slice(0, 63);

/* Makes the role or brings its rights up to date, for tables later updates added too: it reads and changes the rows of
   every table but the hidden ones, and of people all but the password. It owns nothing, so it cannot change the tables
   themselves, and as no superuser it reads no server files and runs no programs. A call may take 15 seconds and may not
   sit in an open transaction. */
export const grantsFor = (role: string) => `DO $grants$
DECLARE t text; cols text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE "${role}" NOLOGIN; END IF;
  ALTER ROLE "${role}" SET statement_timeout = '15s';
  ALTER ROLE "${role}" SET idle_in_transaction_session_timeout = '30s';
  GRANT USAGE ON SCHEMA public TO "${role}";
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN (${[...HIDDEN, 'people'].map(t => `'${t}'`).join(', ')}) LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO "${role}"', t);
  END LOOP;
  SELECT string_agg(quote_ident(column_name), ', ') INTO cols FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'people' AND column_name <> 'password_hash';
  EXECUTE format('GRANT SELECT (%s), INSERT (%s), UPDATE (%s), DELETE ON people TO "${role}"', cols, cols, cols);
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}";
END $grants$`;

/* The role signs in with a password made fresh at every start and kept only here, over its own small pool. Null, with a
   warning, when the database does not let Hornhoof make roles. */
export async function openAgentSql(url: string): Promise<AgentSql | null> {
  const admin = new pg.Client({ connectionString: url });
  try {
    await admin.connect();
    const role = agentRole((await admin.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db);
    const password = randomBytes(24).toString('hex');
    await admin.query(grantsFor(role));
    await admin.query(`ALTER ROLE "${role}" WITH LOGIN CONNECTION LIMIT 4 PASSWORD '${password}'`);
    const own = new URL(url);
    own.username = role;
    own.password = password;
    const pool = new pg.Pool({ connectionString: own.toString(), max: 2, idleTimeoutMillis: 60_000 });
    pool.on('error', err => console.warn(`Lost the orchestrator's database connection, will open another: ${err.message}`));
    return {
      run: async text => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = (await client.query(text)) as unknown as pg.QueryResult | pg.QueryResult[];
          await client.query('COMMIT');
          return (Array.isArray(result) ? result : [result]).map(r => ({ rows: r.rows ?? [], changed: WRITES.has(r.command) ? (r.rowCount ?? 0) : 0 }));
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } catch (err) {
    console.warn(`The orchestrator gets no database access: ${(err as Error).message}`);
    return null;
  } finally {
    await admin.end().catch(() => {});
  }
}
