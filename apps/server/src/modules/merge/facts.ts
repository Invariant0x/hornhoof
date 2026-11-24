import { TABLE_RULES } from './rules.js';

/* One side of a merge as a function that asks it: the leader's transaction, or the source's read-only one. */
export type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
export type ForeignKey = { name: string; table: string; columns: string[]; parent: string; parentColumns: string[] };
export type TableFacts = { name: string; columns: { name: string; type: string; nullable: boolean }[]; key: string[]; fks: ForeignKey[]; referencedBy: ForeignKey[] };
export type Facts = { tables: Map<string, TableFacts>; order: string[] };

/* The bytes an older Hornhoof kept in attachments are no column of its shape: a side still moving them into the store
   and one done with it are of the same version, and a row's bytes come only whole, to go into the store as it is written. */
const COLUMNS = `SELECT c.relname AS "table", a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    AND NOT (c.relname = 'attachments' AND a.attname = 'bytes')
  ORDER BY c.relname, a.attnum`;
const KEYS = `SELECT c.relname AS "table", a.attname AS name
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
    CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY k(att, ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.att
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND i.indisprimary
  ORDER BY c.relname, k.ord`;
/* The columns as JSON: a driver reads an array of names as one text. */
const FOREIGN_KEYS = `SELECT f.conname AS name, c.relname AS "table", p.relname AS parent,
    (SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(f.conkey) WITH ORDINALITY k(att, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.att) AS columns,
    (SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(f.confkey) WITH ORDINALITY k(att, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid = f.confrelid AND a.attnum = k.att) AS "parentColumns"
  FROM pg_catalog.pg_constraint f JOIN pg_catalog.pg_class c ON c.oid = f.conrelid JOIN pg_catalog.pg_class p ON p.oid = f.confrelid
  WHERE f.contype = 'f' AND c.relnamespace = 'public'::regnamespace AND p.relnamespace = 'public'::regnamespace
  ORDER BY c.relname, f.conname`;

/* What the catalog says of the tables of public: their columns and types, their keys and their foreign keys both ways. */
export async function factsOf(q: Query): Promise<Facts> {
  const tables = new Map<string, TableFacts>();
  const table = (name: string): TableFacts => {
    let found = tables.get(name);
    if (!found) tables.set(name, (found = { name, columns: [], key: [], fks: [], referencedBy: [] }));
    return found;
  };
  for (const row of await q<{ table: string; name: string; type: string; nullable: boolean }>(COLUMNS)) table(row.table).columns.push({ name: row.name, type: row.type, nullable: row.nullable });
  for (const row of await q<{ table: string; name: string }>(KEYS)) tables.get(row.table)?.key.push(row.name);
  for (const fk of await q<ForeignKey>(FOREIGN_KEYS)) {
    tables.get(fk.table)?.fks.push(fk);
    tables.get(fk.parent)?.referencedBy.push(fk);
  }
  return { tables, order: orderOf(tables) };
}

/* The tables that must be there before each one: its parents by foreign key, and what its rule names. */
function before(tables: Map<string, TableFacts>): Map<string, Set<string>> {
  const needs = new Map<string, Set<string>>();
  for (const [name, facts] of tables) {
    const wanted = [...facts.fks.map(fk => fk.parent), ...(TABLE_RULES[name]?.after ?? [])];
    needs.set(name, new Set(wanted.filter(parent => parent !== name && tables.has(parent))));
  }
  return needs;
}

/* The groups of tables that point at each other in a circle, each table in exactly one, found as Tarjan does. */
function circles(names: string[], needs: Map<string, Set<string>>): string[][] {
  const found: string[][] = [];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let next = 0;
  const visit = (name: string): void => {
    index.set(name, next);
    low.set(name, next);
    next += 1;
    stack.push(name);
    onStack.add(name);
    for (const parent of needs.get(name)!) {
      if (!index.has(parent)) {
        visit(parent);
        low.set(name, Math.min(low.get(name)!, low.get(parent)!));
      } else if (onStack.has(parent)) low.set(name, Math.min(low.get(name)!, index.get(parent)!));
    }
    if (low.get(name) !== index.get(name)) return;
    const group: string[] = [];
    for (let member = stack.pop()!; ; member = stack.pop()!) {
      onStack.delete(member);
      group.push(member);
      if (member === name) break;
    }
    found.push(group.sort());
  };
  for (const name of names) if (!index.has(name)) visit(name);
  return found;
}

/* Parents first, and each table after the tables its rule names; the tables of a circle together, in name order. Among
   those that may go next, the one whose name comes first. */
function orderOf(tables: Map<string, TableFacts>): string[] {
  const needs = before(tables);
  const groups = circles([...tables.keys()].sort(), needs);
  const groupOf = new Map<string, string[]>();
  for (const group of groups) for (const name of group) groupOf.set(name, group);
  const waits = new Map<string[], Set<string[]>>(groups.map(group => [group, new Set()]));
  for (const group of groups) {
    for (const name of group) for (const parent of needs.get(name)!) if (groupOf.get(parent) !== group) waits.get(group)!.add(groupOf.get(parent)!);
  }
  const order: string[] = [];
  const left = new Set(groups);
  while (left.size > 0) {
    const ready = [...left].filter(group => [...waits.get(group)!].every(parent => !left.has(parent))).sort((a, b) => a[0]!.localeCompare(b[0]!));
    const group = ready[0]!;
    left.delete(group);
    order.push(...group);
  }
  return order;
}

export const DIFFERENT = 'The two databases are of different versions.';

/* Whether the two sides hold the same tables with the same columns of the same types; nothing else is asked. */
export function sameShape(a: Facts, b: Facts): string | null {
  if (a.tables.size !== b.tables.size) return DIFFERENT;
  for (const [name, mine] of a.tables) {
    const theirs = b.tables.get(name);
    if (!theirs || mine.columns.length !== theirs.columns.length) return DIFFERENT;
    const types = new Map(theirs.columns.map(column => [column.name, column.type]));
    if (mine.columns.some(column => types.get(column.name) !== column.type)) return DIFFERENT;
  }
  return null;
}
