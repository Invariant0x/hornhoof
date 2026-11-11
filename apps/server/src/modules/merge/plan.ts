import { createHash } from 'node:crypto';
import type { TableFacts } from './facts.js';
import { HORIZON_MARGIN_MS, keyText, type JournalRow, type Row } from './read.js';
import { BOOKKEEPING, ENDS } from './rules.js';

/* By the journal, which proves what the source changed since the two parted; or row by row, which only adds. */
export type Path = 'journal' | 'compare';

/* A kept database always compares, so a merge never undoes a restore on its own. So does a source that lacks a restore
   the leader went through, and one whose journal shares nothing with the leader's: neither journal proves anything of
   the other side then. */
export function pathOf(p: { kept: boolean; leaderRestores: string[]; sourceRestores: string[]; shared: number }): Path {
  if (p.kept || p.shared === 0) return 'compare';
  return p.leaderRestores.some(attempt => !p.sourceRestores.includes(attempt)) ? 'compare' : 'journal';
}

/* From when the two journals are read: the later of the two sides' horizons, less a day; from the start when neither
   side pruned. */
export function cutoffOf(source: Date | null, leader: Date | null): Date | null {
  const later = Math.max(source?.getTime() ?? -Infinity, leader?.getTime() ?? -Infinity);
  return Number.isFinite(later) ? new Date(later - HORIZON_MARGIN_MS) : null;
}

/* a: the source's journal rows the leader lacks and no merge consumed. b: the leader's the source lacks. shared: how
   many both hold. */
export function divergence(source: Map<string, Date>, leader: Map<string, Date>, consumed: Set<string>): { a: string[]; b: string[]; shared: number } {
  const a: string[] = [];
  let shared = 0;
  for (const id of source.keys()) {
    if (leader.has(id)) shared += 1;
    else if (!consumed.has(id)) a.push(id);
  }
  return { a, b: [...leader.keys()].filter(id => !source.has(id)), shared };
}

const sourceOf = (row: JournalRow): string | null => (row.tbl === 'applied' && row.op === 'insert' && typeof row.key.source === 'string' ? row.key.source : null);
const callOf = (row: JournalRow): string | null => (row.tbl === 'tool_calls' && row.op === 'insert' && typeof row.key.id === 'string' ? row.key.id : null);

/* The sources and tool calls these rows list as done, to ask the leader which of them it lists too. */
export function listedIn(a: JournalRow[]): { sources: string[]; calls: string[] } {
  return { sources: a.flatMap(row => sourceOf(row) ?? []), calls: a.flatMap(row => callOf(row) ?? []) };
}

/* The source's transactions whose source the leader lists: the leader has its own result of that input. */
export function skippedXacts(a: JournalRow[], listed: { sources: Set<string>; calls: Set<string> }): Set<string> {
  const skipped = new Set<string>();
  for (const row of a) {
    const [source, call] = [sourceOf(row), callOf(row)];
    if ((source !== null && listed.sources.has(source)) || (call !== null && listed.calls.has(call))) skipped.add(row.xact);
  }
  return skipped;
}

/* One key's rows of the source's side, each list oldest first. a: the rows that prove. s: the rows of skipped
   transactions, and old: those older than the leader's own horizon, which may have pruned what it did then; both are
   read and compared and never taken. */
export type KeyHistory = { a: JournalRow[]; s: JournalRow[]; old: JournalRow[] };

/* Where each row stood among all the rows it was read with, which tells two rows of one moment apart. */
const position = new WeakMap<JournalRow, number>();

/* a: the source's rows the leader lacks, oldest first. The histories by table and then by keyText of the key. */
export function historiesOf(a: JournalRow[], skipped: Set<string>, leaderHorizon: Date | null): Map<string, Map<string, KeyHistory>> {
  const tables = new Map<string, Map<string, KeyHistory>>();
  a.forEach((row, index) => {
    position.set(row, index);
    let keys = tables.get(row.tbl);
    if (!keys) tables.set(row.tbl, (keys = new Map()));
    const key = keyText(row.key);
    let history = keys.get(key);
    if (!history) keys.set(key, (history = { a: [], s: [], old: [] }));
    if (skipped.has(row.xact)) history.s.push(row);
    else if (leaderHorizon && row.at.getTime() < leaderHorizon.getTime()) history.old.push(row);
    else history.a.push(row);
  });
  return tables;
}

/* What the leader did to one key since the two parted. */
export type Theirs = { insert: boolean; delete: boolean; cols: Set<string> };

export function theirsOf(b: JournalRow[]): Map<string, Map<string, Theirs>> {
  const tables = new Map<string, Map<string, Theirs>>();
  for (const row of b) {
    let keys = tables.get(row.tbl);
    if (!keys) tables.set(row.tbl, (keys = new Map()));
    const key = keyText(row.key);
    let theirs = keys.get(key);
    if (!theirs) keys.set(key, (theirs = { insert: false, delete: false, cols: new Set() }));
    if (row.op === 'insert') theirs.insert = true;
    else if (row.op === 'delete') theirs.delete = true;
    else for (const column of row.cols) theirs.cols.add(column);
  }
  return tables;
}

/* What a merge does with one row. change: set are the columns taken from the source, conflict those listed with both
   values. delete: the applier still looks for the leader's rows that point at it. there: the row as the source had it
   last, when the source no longer has it. */
export type Outcome =
  | { do: 'equal' }
  | { do: 'add' }
  | { do: 'change'; set: string[]; conflict: string[] }
  | { do: 'delete' }
  | { do: 'conflict'; kind: 'differs' | 'changed_removed' | 'removed_changed'; cols: string[]; there?: Row };

const EQUAL: Outcome = { do: 'equal' };
const STAMP = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d(?::?\d\d)?)?$/;

/* A time as microseconds since 1970, from text as Postgres writes it in JSON or as text; null for anything else. */
function micros(value: unknown): number | null {
  const parts = typeof value === 'string' ? STAMP.exec(value) : null;
  if (!parts) return null;
  const [, day, clock, fraction = '', zone = 'Z'] = parts;
  const offset = zone === 'Z' ? 'Z' : zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const ms = Date.parse(`${day}T${clock}${offset}`);
  return Number.isNaN(ms) ? null : ms * 1000 + Number(fraction.padEnd(6, '0'));
}

/* A file by its hash: as the journal keeps it already, or of its bytes as to_jsonb writes them. */
function hashOf(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.startsWith('sha256:')) return value.slice(7);
  return value.startsWith('\\x') ? createHash('sha256').update(Buffer.from(value.slice(2), 'hex')).digest('hex') : value;
}

/* JSON with every object's keys in one order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(name => `${JSON.stringify(name)}:${canonical(object[name])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/* Whether two values of a column are the same value, by the column's type: a time as an instant to the microsecond, a
   file by its SHA-256, anything else as JSON with an object's keys sorted. */
export function same(type: string, a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (type.startsWith('timestamp')) {
    const [one, other] = [micros(a), micros(b)];
    if (one !== null && other !== null) return one === other;
  }
  if (type === 'bytea') return hashOf(a) === hashOf(b);
  return canonical(a) === canonical(b);
}

const typeOf = (t: TableFacts, column: string): string => t.columns.find(found => found.name === column)?.type ?? 'text';
const compared = (t: TableFacts): string[] => t.columns.map(column => column.name).filter(name => !BOOKKEEPING[t.name]?.includes(name));
/* An end both sides recorded is one end, whenever each wrote it. */
const equalHere = (t: TableFacts, column: string, x: unknown, y: unknown): boolean =>
  (ENDS.includes(column) && x !== null && x !== undefined && y !== null && y !== undefined) || same(typeOf(t, column), x, y);

/* The columns, all or those given, whose values differ, leaving the bookkeeping out. */
export function differing(t: TableFacts, x: Row, y: Row, cols?: Iterable<string>): string[] {
  const asked = cols ? new Set(cols) : null;
  return compared(t).filter(column => (!asked || asked.has(column)) && !equalHere(t, column, x[column], y[column]));
}

/* After a restore, and wherever the journals prove nothing: only additions; every other difference is listed, and the
   leader's value stays. */
export function compareOutcome(t: TableFacts, x: Row, y: Row | null): Outcome {
  if (!y) return { do: 'add' };
  const cols = differing(t, x, y);
  return cols.length === 0 ? EQUAL : { do: 'conflict', kind: 'differs', cols };
}

/* Whether a journal row names a column: an insert and a delete name them all. */
const names = (row: JournalRow, column: string): boolean => row.op !== 'update' || row.cols.includes(column);
const inOrder = (rows: JournalRow[]): JournalRow[] =>
  [...rows].sort((one, other) => {
    const [a, b] = [position.get(one), position.get(other)];
    if (a !== undefined && b !== undefined) return a - b;
    return one.at.getTime() - other.at.getTime() || (one.id < other.id ? -1 : one.id > other.id ? 1 : 0);
  });

/* x and y both have the row, and the source did not add it as new: column by column. A column is taken only when a row
   that proves changed it, no skipped row names it, the leader did nothing to it, and the leader still holds its base,
   the value the source had before it first changed it. */
function byColumn(t: TableFacts, x: Row, y: Row, mine: KeyHistory, theirs?: Theirs): Outcome {
  const set: string[] = [];
  const conflict: string[] = [];
  for (const column of compared(t)) {
    const first = mine.a.find(row => names(row, column));
    const skipped = mine.s.some(row => names(row, column)) || mine.old.some(row => names(row, column));
    if ((!first && !skipped) || equalHere(t, column, x[column], y[column])) continue;
    const untouched = !theirs || (!theirs.insert && !theirs.delete && !theirs.cols.has(column));
    const proven = first !== undefined && !skipped && untouched && first.old !== null && same(typeOf(t, column), y[column], first.old[column]);
    (proven ? set : conflict).push(column);
  }
  return set.length + conflict.length === 0 ? EQUAL : { do: 'change', set, conflict };
}

/* x has no row any more. The leader's is deleted only when the key's last word on the source is a delete that proves,
   the source did not add the key, the leader did nothing to it, and the leader's row is the row the source had before
   it first touched it. A row's absence alone never deletes. */
function gone(t: TableFacts, y: Row | null, mine: KeyHistory, theirs?: Theirs): Outcome {
  if (!y || mine.a.some(row => row.op === 'insert')) return EQUAL;
  const rows = inOrder([...mine.a, ...mine.s, ...mine.old]);
  const last = rows.at(-1);
  const untouched = !theirs || (!theirs.insert && !theirs.delete && theirs.cols.size === 0);
  if (last?.op === 'delete' && mine.a.includes(last) && untouched && last.old) {
    const base: Row = { ...last.old };
    for (const column of compared(t)) {
      const first = mine.a.find(row => row.op === 'update' && row.cols.includes(column));
      if (first?.old) base[column] = first.old[column];
    }
    if (compared(t).every(column => same(typeOf(t, column), y[column], base[column]))) return { do: 'delete' };
  }
  if (!mine.a.some(row => row.op !== 'update' || row.cols.length > 0)) return EQUAL;
  const there = rows.findLast(row => row.op === 'delete')?.old;
  return { do: 'conflict', kind: 'removed_changed', cols: [], ...(there ? { there } : {}) };
}

/* What the journal proves of one key. x: the source's row now. y: the leader's. mine: the key's rows of the source's
   side. theirs: what the leader did to the key since the two parted. */
export function journalOutcome(t: TableFacts, x: Row | null, y: Row | null, mine: KeyHistory, theirs?: Theirs): Outcome {
  /* A key only the leader touched, or only a skipped transaction, is the leader's: it has its own result of that input. */
  if (mine.a.length === 0 && mine.old.length === 0) return EQUAL;
  if (!x) return gone(t, y, mine, theirs);
  if (!y) {
    if (mine.a.some(row => row.op === 'insert') && !theirs?.delete) return { do: 'add' };
    const cols = compared(t).filter(column => mine.a.some(row => row.op === 'update' && row.cols.includes(column)));
    return { do: 'conflict', kind: 'changed_removed', cols };
  }
  /* A key the source added that the leader holds too, which only a natural key can be, is compared whole. */
  if (mine.a[0]?.op === 'insert') return compareOutcome(t, x, y);
  return byColumn(t, x, y, mine, theirs);
}
