import type { Query, TableFacts } from './facts.js';

/* The day taken off a horizon: a journal row's time is when its row changed, not when its transaction committed, and a
   prune deletes in batches. It only widens what is read and proves nothing by itself. */
export const HORIZON_MARGIN_MS = 86_400_000;
const JOURNAL_BATCH = 1000;
const KEYS_BATCH = 500;
const ROWS_BATCH = 500;

/* A row as to_jsonb gives it: a time as text with its microseconds, a file as \x and its bytes in hex. */
export type Row = Record<string, unknown>;
export type JournalRow = { id: string; xact: string; at: Date; tbl: string; op: 'insert' | 'update' | 'delete'; key: Record<string, unknown>; cols: string[]; old: Row | null };

/* A key as one text, whatever order its columns came in. */
export function keyText(key: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(key).sort().map(column => [column, key[column]]));
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
/* A time as a side answers it: a driver gives a Date, and drizzle the text Postgres wrote. */
const dateOf = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const batches = <T>(all: T[], size: number): T[][] => Array.from({ length: Math.ceil(all.length / size) }, (_unused, n) => all.slice(n * size, (n + 1) * size));

/* The tables of net a side has, asked once per side: a database kept before a release lacks what that release added,
   and what it lacks reads as empty. */
const known = new WeakMap<Query, Promise<Set<string>>>();
export function netTables(q: Query): Promise<Set<string>> {
  let found = known.get(q);
  if (!found) {
    found = q<{ name: string }>(`SELECT c.relname AS name FROM pg_catalog.pg_class c WHERE c.relnamespace = 'net'::regnamespace AND c.relkind = 'r'`).then(rows => new Set(rows.map(row => row.name)));
    known.set(q, found);
  }
  return found;
}
const has = async (q: Query, table: string): Promise<boolean> => (await netTables(q)).has(table);

/* Below this time the side pruned its journal; null when it never did. */
export async function horizonOf(q: Query): Promise<Date | null> {
  if (!(await has(q, 'horizon'))) return null;
  const [row] = await q<{ below: unknown }>('SELECT below FROM net.horizon');
  return row ? dateOf(row.below) : null;
}

/* Every journal row of the side from that time on, by its id with its time. */
export async function journalIds(q: Query, from: Date | null): Promise<Map<string, Date>> {
  const rows = await q<{ id: string; at: unknown }>('SELECT id, at FROM net.journal WHERE $1::timestamptz IS NULL OR at >= $1::timestamptz', [from]);
  return new Map(rows.map(row => [row.id, dateOf(row.at)]));
}

/* These journal rows, oldest first: by their time to the microsecond, then by id. */
export async function journalRows(q: Query, ids: string[]): Promise<JournalRow[]> {
  const found: (JournalRow & { stamp: string })[] = [];
  for (const batch of batches(ids, JOURNAL_BATCH)) {
    found.push(
      ...(await q<JournalRow & { stamp: string }>(
        `SELECT j.id, j.xact, j.at, j.tbl, j.op, j.key, j.cols, j.old, to_char(j.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS stamp
         FROM net.journal j WHERE j.id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))`,
        [JSON.stringify(batch)],
      )),
    );
  }
  found.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return found.map(({ id, xact, at, tbl, op, key, cols, old }) => ({ id, xact, at: dateOf(at), tbl, op, key, cols, old }));
}

/* The restores the side went through, oldest first, by their attempts. */
export async function restoresOf(q: Query): Promise<string[]> {
  if (!(await has(q, 'restores'))) return [];
  return (await q<{ attempt: string }>('SELECT attempt FROM net.restores ORDER BY at, attempt')).map(row => row.attempt);
}

export async function lastChange(q: Query): Promise<Date | null> {
  const [row] = await q<{ at: unknown }>('SELECT max(at) AS at FROM net.journal');
  return row?.at ? dateOf(row.at) : null;
}

/* A row as JSON. A file in it is read as its hash, as the journal keeps it, so a table of files is compared without
   their bytes ever leaving the database; whole: with its bytes, for a row that is written. */
export const FILE_HASH = 'sha256:';
const rowOf = (t: TableFacts, whole: boolean): string => {
  /* The old bytes of attachments, while a side still has them, come only with a whole row. */
  if (t.name === 'attachments' && !whole) return "to_jsonb(t) - 'bytes'";
  const files = whole ? [] : t.columns.filter(column => column.type === 'bytea').map(column => column.name);
  if (files.length === 0) return 'to_jsonb(t)';
  return `to_jsonb(t) || jsonb_build_object(${files.map(name => `'${name}', '${FILE_HASH}' || encode(sha256(t.${quote(name)}), 'hex')`).join(', ')})`;
};

/* The columns of a key as jsonb_to_recordset reads them back, each with its own type. */
const typed = (t: TableFacts, columns: string[]): string => columns.map(name => `${quote(name)} ${t.columns.find(column => column.name === name)!.type}`).join(', ');

/* The rows with these keys, by keyText of each one's key; by: another column than the key that names a row, as a log's
   match, and then the keys hold that column alone. */
export async function rowsByKeys(q: Query, t: TableFacts, keys: Record<string, unknown>[], by?: string, whole = false): Promise<Map<string, Row>> {
  const columns = by ? [by] : t.key;
  const found = new Map<string, Row>();
  for (const batch of batches(keys, KEYS_BATCH)) {
    const rows = await q<{ row: Row }>(
      `SELECT ${rowOf(t, whole)} AS row FROM public.${quote(t.name)} t JOIN jsonb_to_recordset($1::jsonb) AS k(${typed(t, columns)}) ON ${columns.map(name => `t.${quote(name)} = k.${quote(name)}`).join(' AND ')}`,
      [JSON.stringify(batch)],
    );
    for (const { row } of rows) found.set(keyText(Object.fromEntries(columns.map(name => [name, row[name]]))), row);
  }
  return found;
}

/* Every row of a table in the order of its key, a page at a time, each page starting after the last key of the one
   before. */
export async function* rowsOf(q: Query, t: TableFacts, batch: number = ROWS_BATCH): AsyncGenerator<Row[]> {
  const key = t.key.map(name => `t.${quote(name)}`).join(', ');
  let after: Row | null = null;
  for (;;) {
    const from: string = after ? `, jsonb_to_record($2::jsonb) AS k(${typed(t, t.key)}) WHERE (${key}) > (${t.key.map(name => `k.${quote(name)}`).join(', ')})` : '';
    const params: unknown[] = after ? [batch, JSON.stringify(Object.fromEntries(t.key.map(name => [name, after![name]])))] : [batch];
    const rows: { row: Row }[] = await q<{ row: Row }>(`SELECT ${rowOf(t, false)} AS row FROM public.${quote(t.name)} t${from} ORDER BY ${key} LIMIT $1`, params);
    if (rows.length === 0) return;
    yield rows.map(found => found.row);
    if (rows.length < batch) return;
    after = rows.at(-1)!.row;
  }
}

/* Which of these journal ids a merge of this side has dealt with. */
export async function consumedIds(q: Query, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (!(await has(q, 'merge_consumed'))) return found;
  for (const batch of batches(ids, JOURNAL_BATCH)) {
    const rows = await q<{ journal: string }>('SELECT journal FROM net.merge_consumed WHERE journal IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))', [JSON.stringify(batch)]);
    for (const row of rows) found.add(row.journal);
  }
  return found;
}

/* Which of these sources and tool calls the side lists as done. */
export async function listedSources(q: Query, sources: string[], calls: string[]): Promise<{ sources: Set<string>; calls: Set<string> }> {
  const found = { sources: new Set<string>(), calls: new Set<string>() };
  for (const batch of batches(sources, JOURNAL_BATCH)) {
    for (const row of await q<{ source: string }>('SELECT source FROM public.applied WHERE source IN (SELECT jsonb_array_elements_text($1::jsonb))', [JSON.stringify(batch)])) found.sources.add(row.source);
  }
  for (const batch of batches(calls, JOURNAL_BATCH)) {
    for (const row of await q<{ id: string }>('SELECT id FROM public.tool_calls WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))', [JSON.stringify(batch)])) found.calls.add(row.id);
  }
  return found;
}

/* The conflicts the side's own merges left open. */
export async function openConflicts(q: Query): Promise<Row[]> {
  if (!(await has(q, 'merge_conflicts'))) return [];
  return (await q<{ row: Row }>('SELECT to_jsonb(c) AS row FROM net.merge_conflicts c WHERE c.picked IS NULL ORDER BY c.created_at, c.id')).map(found => found.row);
}

/* Every planned switch the side wrote down, oldest first; none on a side from before there were any. */
export async function handoversOf(q: Query): Promise<Row[]> {
  if (!(await has(q, 'handovers'))) return [];
  return (await q<{ row: Row }>('SELECT to_jsonb(h) AS row FROM net.handovers h ORDER BY h.at, h.id')).map(found => found.row);
}

/* What nodes said of jobs the side had no row of, oldest first; none on a side from before it kept any. */
export async function parkedOf(q: Query): Promise<Row[]> {
  if (!(await has(q, 'parked'))) return [];
  return (await q<{ row: Row }>('SELECT to_jsonb(p) AS row FROM net.parked p ORDER BY p.at, p.id')).map(found => found.row);
}

/* Where a job runs that a node said something of while its row was away. */
export type ParkedNode = { kind: 'node'; nodeId: string } | { kind: 'builtin'; machine: string };

/* The jobs these rows are of, each with the node it runs on: the one that listed it or said it started last, else the
   one that said anything of it last. rows: oldest first. */
export function parkedNodes(rows: Row[]): Map<string, ParkedNode> {
  const found = new Map<string, { node: ParkedNode; sure: boolean }>();
  for (const row of rows) {
    const said = row.node as { kind?: unknown; nodeId?: unknown; machine?: unknown } | null;
    const node: ParkedNode | null =
      said?.kind === 'node' && typeof said.nodeId === 'string' ? { kind: 'node', nodeId: said.nodeId }
        : said?.kind === 'builtin' && typeof said.machine === 'string' ? { kind: 'builtin', machine: said.machine } : null;
    if (!node) continue;
    const sure = row.kind === 'listed' || row.kind === 'started';
    const before = found.get(String(row.job_id));
    if (!before || sure || !before.sure) found.set(String(row.job_id), { node, sure });
  }
  return new Map([...found].map(([job, { node }]) => [job, node]));
}

export async function backupsOf(q: Query): Promise<Row[]> {
  if (!(await has(q, 'backups'))) return [];
  return (await q<{ row: Row }>('SELECT to_jsonb(b) AS row FROM net.backups b ORDER BY b.made_at, b.id')).map(found => found.row);
}

/* Which of these public tables hold at least one row. */
export async function nonEmptyTables(q: Query, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const sql = names.map((_name, index) => `SELECT $${index + 1}::text AS name WHERE EXISTS (SELECT 1 FROM public.${quote(names[index]!)})`).join(' UNION ALL ');
  return new Set((await q<{ name: string }>(sql, names)).map(row => row.name));
}
