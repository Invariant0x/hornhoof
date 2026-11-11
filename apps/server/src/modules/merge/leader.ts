import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Query } from './facts.js';

/* The leader's side as a merge asks it: plain text with $1, $2 and so on, on this db or this transaction of it. */
export function queryOf(db: Db): Query {
  return async <T>(text: string, params: unknown[] = []) => {
    const chunks = text.split(/\$(\d+)/).map((part, index) => (index % 2 === 0 ? sql.raw(part) : sql.param(params[Number(part) - 1])));
    return ((await db.execute(sql.join(chunks, sql.raw('')))) as unknown as { rows: T[] }).rows;
  };
}

export const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
