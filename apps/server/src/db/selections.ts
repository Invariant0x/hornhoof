import { count } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/* Selections many queries share. Written out in place, as .select({ id: agents.id }), a selection is a type of its own at
   each query, and drizzle builds the types of every step of that query anew for it. These give all the queries of one
   shape the same types. */

/* The id of the table's rows. */
export const idOnly = <T extends { id: AnyPgColumn }>(table: T): { id: T['id'] } => ({ id: table.id });

/* One column of the table under its own name, as .select({ name: agents.name }) has it. */
export const only = <T, K extends keyof T>(table: T, key: K): Pick<T, K> => ({ [key]: table[key] }) as Pick<T, K>;

/* How many rows the query finds. */
export const countOnly = () => ({ n: count() });

/* Raw SQL returns an array in some drivers and a result with rows in others. */
export const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);
