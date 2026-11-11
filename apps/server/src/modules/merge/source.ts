import pg from 'pg';
import type { Config } from '../../config.js';
import { stripSettings } from '../../db/client.js';
import { keepErrors } from '../../db/confirm.js';
import { REPLICA_ROLE } from '../keeper/replica.js';
import type { Query } from './facts.js';

/* A database of the company that came back, read in one snapshot: every query runs in one REPEATABLE READ READ ONLY
   transaction whose snapshot the first query took. A merge reads its source only through this and never writes it. */
export type MergeSource = { label: string; query: Query; close(): Promise<void> };

/* The name of a database a restore set aside, as the updater gives it. */
export const KEPT_NAME = /^hornhoof_before_[A-Za-z0-9_]{1,47}$/;
/* The name of a database made of what a machine held when it stopped holding the company's data, as the keeper that
   took it names it: the first 16 hex characters of the machine's network id, and the moment in UTC. */
export const UPLOAD_NAME = /^hornhoof_upload_([0-9a-f]{16})_([0-9]{8}t[0-9]{6})$/;
/* A database of the leader's own Postgres that a merge reads: one a restore kept, or one made of an upload. */
export const setAside = (name: string): boolean => KEPT_NAME.test(name) || UPLOAD_NAME.test(name);
/* The source of a copy's old database: the row of its machine, and the attempt whose database it is. */
export const MACHINE_SOURCE = /^machine:([0-9a-f-]{36}):([1-9][0-9]{0,8})$/;
/* The copy's own database, which a machine reads until its new copy has taken that place, and the role that only reads. */
const COPY_DB = 'hornhoof';

/* The app's own address with another database in its path. The settings the app's address carries for its own sessions
   are left out: in pg a database named in the address wins over a database option, so the name is never passed beside
   it. */
export function sourceUrl(databaseUrl: string, database: string): string {
  const address = new URL(stripSettings(databaseUrl));
  address.pathname = `/${database}`;
  return address.toString();
}

/* A kept database of the leader's own Postgres, or one made of an upload, read with the app's own credentials. A name
   that is neither's is refused before any connection, and a connection that landed on another database is closed
   unread. */
export async function keptSource(config: Config, database: string, label: string): Promise<MergeSource> {
  if (!setAside(database)) throw new Error('The merge source is not the kept database.');
  if (!config.databaseUrl) throw new Error('This Hornhoof has no database address, so it cannot read a kept database.');
  const client = new pg.Client({ connectionString: sourceUrl(config.databaseUrl, database), application_name: 'hornhoof-merge', options: '-c default_transaction_read_only=on' });
  keepErrors(client);
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query<{ name: string }>('SELECT current_database() AS name');
    if (rows[0]?.name !== database) throw new Error('The merge source is not the kept database.');
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  return {
    label,
    query: async <T>(text: string, params?: unknown[]) => (await client.query(text, params)).rows as T[],
    close: async () => {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}

/* The old database of a copy on another machine, read through the door this server's keeper opened to it: the door's
   port on the keeper, and the role that reads and never writes. host: the keeper, unless a test stands in for it. */
export async function peerSource(port: number, password: string, label: string, host = 'keeper'): Promise<MergeSource> {
  const client = new pg.Client({ host, port, database: COPY_DB, user: REPLICA_ROLE, password, application_name: 'hornhoof-merge', options: '-c default_transaction_read_only=on' });
  keepErrors(client);
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query<{ name: string }>('SELECT current_database() AS name');
    if (rows[0]?.name !== COPY_DB) throw new Error("The merge source is not the copy's database.");
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  return {
    label,
    query: async <T>(text: string, params?: unknown[]) => (await client.query(text, params)).rows as T[],
    close: async () => {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}
