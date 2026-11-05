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

async function onServer(statements: string[]): Promise<void> {
  const server = await connected(realServer());
  try {
    for (const statement of statements) await server.query(statement);
  } finally {
    await server.end();
  }
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

/* openDb answers the database alone, and a test has to end the connections behind it. */
export const poolOf = (db: Db): pg.Pool => (db as unknown as { $client: pg.Pool }).$client;
