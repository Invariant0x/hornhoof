import { z } from 'zod';
import type { Sql } from './lease-store.js';

/* The few words the keeper's modules share when they write statements for Postgres and read each other's notes. */

/* A name inside a statement, and a text inside one. */
export const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
export const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/* A term as keepers write it down and tell it each other. */
export const TermShape = z.object({ number: z.number().int().min(0), machine: z.string().max(64), split: z.boolean() });

/* Where a database's log ends, and its slots with whether each is read now and holds that position. */
export type Wal = { position(): Promise<string>; slots(w: string): Promise<{ name: string; read: boolean; atW: boolean }[]> };

/* The log of the database a connection leads to. */
export const walOf = (sql: Sql): Wal => ({
  position: async () => (await sql.query<{ lsn: string }>('SELECT pg_current_wal_lsn()::text AS lsn')).rows[0]!.lsn,
  slots: async w =>
    (await sql.query<{ name: string; read: boolean; atW: boolean }>(
      'SELECT slot_name::text AS name, active_pid IS NOT NULL AS read, COALESCE(confirmed_flush_lsn >= $1::pg_lsn, false) AS "atW" FROM pg_replication_slots WHERE database = current_database()', [w])).rows,
});

function parseLsn(lsn: string): bigint | null {
  const match = /^([0-9a-fA-F]{1,8})\/([0-9a-fA-F]{1,8})$/.exec(lsn);
  return match ? (BigInt(`0x${match[1]}`) << 32n) | BigInt(`0x${match[2]}`) : null;
}

/* Whether the first WAL position stands at or past the second; false when either is no WAL position. */
export function lsnAtOrPast(lsn: string, target: string): boolean {
  const [a, b] = [parseLsn(lsn), parseLsn(target)];
  return a !== null && b !== null && a >= b;
}
