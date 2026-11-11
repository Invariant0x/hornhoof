/* eslint-disable hornhoof/no-ddl-on-shared-database -- These run on a Postgres database each of them makes and drops, shared with no other test. */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { agentRole, readerRole } from '../../src/db/agent-sql.js';
import type { Db } from '../../src/db/client.js';

export interface RealDatabase {
  url: string;
  admin: pg.Client;
  drop(): Promise<void>;
}

export function realServer(): string {
  const url = process.env.HH_REAL_PG;
  if (!url) throw new Error('run with npm run test:real');
  return url;
}

async function connected(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/* Every statement gets its try, so one that fails leaves nothing else behind; the caller gets the first failure. */
async function onServer(statements: string[]): Promise<void> {
  const server = await connected(realServer());
  const failures: unknown[] = [];
  for (const statement of statements) await server.query(statement).catch((failure: unknown) => failures.push(failure));
  await server.end();
  if (failures.length > 0) throw failures[0];
}

const urlOf = (database: string): string => {
  const url = new URL(realServer());
  url.pathname = `/${database}`;
  return url.href;
};

/* Each test file gets a database of its own on the one container, so the files leave nothing behind for one another. The
   roles of the agents belong to the server, not to the database, and would outlive it. */
export async function realDatabase(): Promise<RealDatabase> {
  const name = `hh_${randomBytes(6).toString('hex')}`;
  await onServer([`CREATE DATABASE ${name}`]);
  const url = urlOf(name);
  const admin = await connected(url);
  const drop = async (): Promise<void> => {
    await admin.end();
    await onServer([`DROP DATABASE ${name} WITH (FORCE)`, `DROP ROLE IF EXISTS ${agentRole(name)}`, `DROP ROLE IF EXISTS ${readerRole(name)}`]);
  };
  return { url, admin, drop };
}

/* A copy of a database as it is now, with its connections off, as a restore leaves the database it sets aside. Every
   other session on the one it is copied from is ended first, which a copy needs: the test closes its own pools on it
   before, and connects anew after. A test that writes the copy turns its connections on first. */
export async function forkDatabase(from: string, name: string): Promise<string> {
  await onServer([
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${from}' AND pid <> pg_backend_pid()`,
    `CREATE DATABASE ${name} TEMPLATE ${from}`,
    `ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS false`,
  ]);
  return urlOf(name);
}

/* Statements run on the server itself, outside every database of the tests. */
export const onRealServer = onServer;
export const realUrlOf = urlOf;

/* How many sessions of a process, told apart by the name it connects with, wait for a lock right now. */
export const sessionsWaitingOnALock = async (real: RealDatabase, name: string): Promise<number> => {
  const { rows } = await real.admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'",
    [name],
  );
  return rows[0]!.n;
};

/* openDb answers the database alone, and a test has to end the connections behind it. */
export const poolOf = (db: Db): pg.Pool => (db as unknown as { $client: pg.Pool }).$client;
