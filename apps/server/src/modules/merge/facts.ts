import { TABLE_RULES } from './rules.js';

export type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;
export type ForeignKey = { name: string; table: string; columns: string[]; parent: string; parentColumns: string[] };
export type TableFacts = { name: string; columns: { name: string; type: string }[]; key: string[]; fks: ForeignKey[]; referencedBy: ForeignKey[] };
export type Facts = { tables: Map<string, TableFacts>; order: string[] };

type ColumnRow = { table_name: string; column_name: string; type: string };
type PrimaryKeyRow = { kind: 'p'; table_name: string; columns: string[] };
type ForeignKeyRow = { kind: 'f'; name: string; table_name: string; columns: string[]; parent: string; parent_columns: string[] };

const COLUMNS = `SELECT t.relname::text AS table_name, a.attname::text AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE n.nspname = 'public' AND t.relkind = 'r'
  ORDER BY t.relname, a.attnum`;

/* The names as text: pg leaves an array of the catalog's own name type unparsed. */
const columnNames = (relation: string, numbers: string) => `(SELECT array_agg(a.attname::text ORDER BY u.ord)
    FROM unnest(${numbers}) WITH ORDINALITY AS u(attnum, ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = ${relation} AND a.attnum = u.attnum)`;

/* A foreign key to another schema is not one between the tables of public, and its parent's name could mislead. */
const CONSTRAINTS = `SELECT k.contype::text AS kind, k.conname::text AS name, t.relname::text AS table_name, p.relname::text AS parent,
    ${columnNames('k.conrelid', 'k.conkey')} AS columns, ${columnNames('k.confrelid', 'k.confkey')} AS parent_columns
  FROM pg_catalog.pg_constraint k
  JOIN pg_catalog.pg_class t ON t.oid = k.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  LEFT JOIN pg_catalog.pg_class p ON p.oid = k.confrelid
  WHERE n.nspname = 'public' AND t.relkind = 'r' AND (k.contype = 'p' OR (k.contype = 'f' AND p.relnamespace = t.relnamespace))
  ORDER BY t.relname, k.conname`;

export async function factsOf(q: Query): Promise<Facts> {
  const columns = await q<ColumnRow>(COLUMNS);
  const constraints = await q<PrimaryKeyRow | ForeignKeyRow>(CONSTRAINTS);
  const tables = tablesOf(columns);
  for (const constraint of constraints) place(tables, constraint);
  return { tables, order: orderOf(tables) };
}

function tablesOf(columns: ColumnRow[]): Map<string, TableFacts> {
  const tables = new Map<string, TableFacts>();
  for (const { table_name: name, column_name, type } of columns) {
    const table = tables.get(name) ?? { name, columns: [], key: [], fks: [], referencedBy: [] };
    table.columns.push({ name: column_name, type });
    tables.set(name, table);
  }
  return tables;
}

function place(tables: Map<string, TableFacts>, row: PrimaryKeyRow | ForeignKeyRow): void {
  if (row.kind === 'p') {
    tables.get(row.table_name)!.key = row.columns;
    return;
  }
  const fk = { name: row.name, table: row.table_name, columns: row.columns, parent: row.parent, parentColumns: row.parent_columns };
  tables.get(fk.table)!.fks.push(fk);
  tables.get(fk.parent)?.referencedBy.push(fk);
}

function orderOf(tables: Map<string, TableFacts>): string[] {
  return parentsFirst(new Map([...tables.values()].map(table => [table.name, [...table.fks.map(fk => fk.parent), ...(TABLE_RULES[table.name]?.after ?? [])]])));
}

/* Tables parents first. The next is always the first by name that waits for nothing but what waits for it: one with no
   parents left, or a member of a cycle nothing else holds back, and then the whole cycle goes in name order. One always
   exists, as a cycle of cycles is one cycle. So a table that only hangs on a cycle comes after it, whatever its name. */
export function parentsFirst(parents: ReadonlyMap<string, readonly string[]>): string[] {
  const left = new Set([...parents.keys()].sort());
  const order: string[] = [];
  while (left.size > 0) {
    const next = [...left].find(table => waitsOnlyInACycle(table, parents, left))!;
    const group = [...new Set([next, ...ancestors(next, parents, left)])].sort();
    for (const table of group) left.delete(table);
    order.push(...group);
  }
  return order;
}

function waitsOnlyInACycle(table: string, parents: ReadonlyMap<string, readonly string[]>, left: ReadonlySet<string>): boolean {
  return [...ancestors(table, parents, left)].every(ancestor => ancestors(ancestor, parents, left).has(table));
}

function ancestors(table: string, parents: ReadonlyMap<string, readonly string[]>, left: ReadonlySet<string>, seen = new Set<string>()): Set<string> {
  for (const parent of parents.get(table) ?? []) {
    if (left.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      ancestors(parent, parents, left, seen);
    }
  }
  return seen;
}

const columnLines = (facts: Facts): string => [...facts.tables.values()].flatMap(table => table.columns.map(column => `${table.name}.${column.name} ${column.type}`)).sort().join('\n');

/* Only tables, columns and types: a column's position differs on a database that took another way to the same shape,
   and the number of migrations says nothing, as one may add nothing to public. */
export function sameShape(a: Facts, b: Facts): string | null {
  return columnLines(a) === columnLines(b) ? null : 'The two databases are of different versions.';
}
