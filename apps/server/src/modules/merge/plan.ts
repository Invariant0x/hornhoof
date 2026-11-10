import { createHash } from 'node:crypto';
import type { TableFacts } from './facts.js';
import { HORIZON_MARGIN_MS, keyText, type JournalRow, type Row } from './read.js';
import { BOOKKEEPING, ENDS, ruleOf, type TableRule } from './rules.js';

export type Path = 'journal' | 'compare';

/* A kept database always compares, so a merge never undoes a restore on its own; after a restore the source lacks, or
   with no id in common, the two journals prove nothing about each other. */
export function pathOf(p: { kept: boolean; leaderRestores: string[]; sourceRestores: string[]; shared: number }): Path {
  const restoredSince = p.leaderRestores.some(attempt => !p.sourceRestores.includes(attempt));
  return p.kept || restoredSince || p.shared === 0 ? 'compare' : 'journal';
}

export function cutoffOf(source: Date | null, leader: Date | null): Date | null {
  const horizons = [source, leader].filter(horizon => horizon !== null).map(horizon => horizon.getTime());
  return horizons.length > 0 ? new Date(Math.max(...horizons) - HORIZON_MARGIN_MS) : null;
}

export function divergence(source: Map<string, Date>, leader: Map<string, Date>, consumed: Set<string>): { a: string[]; b: string[]; shared: number } {
  const sourceIds = [...source.keys()];
  return {
    a: sourceIds.filter(id => !leader.has(id) && !consumed.has(id)),
    b: [...leader.keys()].filter(id => !source.has(id)),
    shared: sourceIds.filter(id => leader.has(id)).length,
  };
}

function isListedInput(row: JournalRow, listed: { sources: Set<string>; calls: Set<string> }): boolean {
  if (row.op !== 'insert') return false;
  if (row.tbl === 'applied') return listed.sources.has(String(row.key.source));
  return row.tbl === 'tool_calls' && listed.calls.has(String(row.key.id));
}

/* The leader has its own result of an input it lists, so what the source made of the same input is never taken. */
export function skippedXacts(a: JournalRow[], listed: { sources: Set<string>; calls: Set<string> }): Set<string> {
  return new Set(a.filter(row => isListedInput(row, listed)).map(row => row.xact));
}

const byTimeThenId = (first: JournalRow, second: JournalRow): number => first.at.getTime() - second.at.getTime() || (first.id < second.id ? -1 : 1);

function entryOf<T>(byTable: Map<string, Map<string, T>>, row: JournalRow, empty: () => T): T {
  const byKey = byTable.get(row.tbl) ?? new Map<string, T>();
  byTable.set(row.tbl, byKey);
  const text = keyText(row.key);
  const entry = byKey.get(text) ?? empty();
  byKey.set(text, entry);
  return entry;
}

export type KeyHistory = { a: JournalRow[]; s: JournalRow[] };

/* s is what is read and compared but never taken: a skipped transaction, or a row older than the leader's own horizon,
   as the leader may have pruned what it did then. */
export function historiesOf(a: JournalRow[], skipped: Set<string>, leaderHorizon: Date | null): Map<string, Map<string, KeyHistory>> {
  const histories = new Map<string, Map<string, KeyHistory>>();
  const belowHorizon = (row: JournalRow): boolean => leaderHorizon !== null && row.at < leaderHorizon;
  for (const row of [...a].sort(byTimeThenId)) {
    const history = entryOf(histories, row, () => ({ a: [], s: [] }));
    (skipped.has(row.xact) || belowHorizon(row) ? history.s : history.a).push(row);
  }
  return histories;
}

/* cols holds what B's updates changed: an insert or a delete already says the whole key was B's. */
export type Theirs = { insert: boolean; delete: boolean; cols: Set<string> };

export function theirsOf(b: JournalRow[]): Map<string, Map<string, Theirs>> {
  const theirs = new Map<string, Map<string, Theirs>>();
  for (const row of b) {
    const did = entryOf<Theirs>(theirs, row, () => ({ insert: false, delete: false, cols: new Set() }));
    if (row.op === 'update') row.cols.forEach(column => did.cols.add(column));
    else did[row.op] = true;
  }
  return theirs;
}

export type Outcome =
  | { do: 'equal' }
  | { do: 'add' }
  | { do: 'change'; set: string[]; conflict: string[] }
  | { do: 'delete' }
  | { do: 'conflict'; kind: 'differs' | 'changed_removed' | 'removed_changed'; cols: string[]; there?: Row };

const EQUAL: Outcome = { do: 'equal' };
const ADD: Outcome = { do: 'add' };

const HASHED = 'sha256:';
const TIMESTAMP_TYPE = /^timestamp(\(\d\))? with(out)? time zone$/;
const STAMP = /^([^.]+?)(?:\.(\d+))?(Z|[+-]\d{2}(?::\d{2})*)?$/;

/* The journal keeps a bytea only as its hash, so a value is compared by its hash whichever side it comes from. */
const hashOf = (text: string): string => (text.startsWith(HASHED) ? text : `${HASHED}${createHash('sha256').update(Buffer.from(text.slice(2), 'hex')).digest('hex')}`);

/* A Date holds milliseconds and Postgres microseconds, so the fraction is counted apart. A value with no zone is read as
   UTC, as its local reading would fold two times of a clock change into one. What cannot be read, such as infinity,
   stays its text. */
function instantOf(text: string): number | string {
  const [, whole, fraction = '', zone = 'Z'] = text.match(STAMP) ?? [];
  const milliseconds = Date.parse(`${whole}${zone}`);
  return Number.isNaN(milliseconds) ? text : milliseconds * 1000 + Number(fraction.padEnd(6, '0'));
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(object).sort().map(name => [name, withSortedKeys(object[name])]));
}

function comparableOf(type: string, value: unknown): number | string {
  if (type === 'bytea') return hashOf(String(value));
  if (TIMESTAMP_TYPE.test(type)) return instantOf(String(value));
  return JSON.stringify(withSortedKeys(value));
}

const isNothing = (value: unknown): boolean => value === null || value === undefined;

/* Two values by their column's format_type, as ruling 6 says. */
export function same(type: string, a: unknown, b: unknown): boolean {
  if (isNothing(a) || isNothing(b)) return isNothing(a) && isNothing(b);
  return comparableOf(type, a) === comparableOf(type, b);
}

const bookkeepingOf = (t: TableFacts): readonly string[] => BOOKKEEPING[t.name] ?? [];

/* An end both sides recorded is one end, whatever time each gave it. */
const sameEnd = (column: string, a: unknown, b: unknown): boolean => ENDS.includes(column) && !isNothing(a) && !isNothing(b);

export function differing(t: TableFacts, x: Row, y: Row, cols?: Iterable<string>): string[] {
  const asked = cols ? new Set(cols) : null;
  const left = bookkeepingOf(t);
  return t.columns
    .filter(({ name }) => !left.includes(name) && (asked === null || asked.has(name)))
    .filter(({ name, type }) => !sameEnd(name, x[name], y[name]) && !same(type, x[name], y[name]))
    .map(({ name }) => name);
}

const differsIn = (cols: string[]): Outcome => (cols.length > 0 ? { do: 'conflict', kind: 'differs', cols } : EQUAL);

const comparedWhole = (t: TableFacts, x: Row, y: Row): Outcome => differsIn(differing(t, x, y));

/* add and log are never compared and never deleted, and skip is never planned, so nothing else is decided for them. */
const neverCompared = (kind: TableRule['kind'], leaderLacks: boolean): Outcome => (kind !== 'skip' && leaderLacks ? ADD : EQUAL);

export function compareOutcome(t: TableFacts, x: Row, y: Row | null): Outcome {
  const { kind } = ruleOf(t.name);
  if (kind !== 'rows') return neverCompared(kind, y === null);
  return y === null ? ADD : comparedWhole(t, x, y);
}

/* One key's history with what proves nothing taken out, and what the leader did to it. */
type KeyCase = { t: TableFacts; a: JournalRow[]; s: JournalRow[]; theirs: Theirs };

const NOTHING_HERE: Theirs = { insert: false, delete: false, cols: new Set() };

const names = (rows: JournalRow[], column: string): boolean => rows.some(row => row.cols.includes(column));
const inserted = (rows: JournalRow[]): boolean => rows.some(row => row.op === 'insert');
const startsWithInsert = (rows: JournalRow[]): boolean => rows[0]?.op === 'insert';

/* An update that changed nothing, or only what is never compared, says nothing of the row. An insert and a delete list
   every column, so they always say something. */
const saysSomething = (t: TableFacts, row: JournalRow): boolean => row.cols.some(column => !bookkeepingOf(t).includes(column));

const baseOf = (a: JournalRow[], column: string): unknown => a.find(row => row.cols.includes(column))?.old?.[column];

function holdsItsBase(k: KeyCase, y: Row, column: string): boolean {
  const base = baseOf(k.a, column);
  const { type } = k.t.columns.find(({ name }) => name === column)!;
  return base !== undefined && same(type, y[column], base);
}

const keyIsTheLeaders = ({ theirs }: KeyCase): boolean => theirs.insert || theirs.delete;

/* Only a machine's owner opens computer access, so a merge never takes those columns, proven or not. */
function proven(k: KeyCase, y: Row, column: string): boolean {
  if (ruleOf(k.t.name).hereOnly?.includes(column)) return false;
  if (names(k.s, column) || keyIsTheLeaders(k) || k.theirs.cols.has(column)) return false;
  return holdsItsBase(k, y, column);
}

/* An insert lists every column and holds no old values, so a key the source inserted has no base and is compared whole. */
function bothHold(k: KeyCase, x: Row, y: Row): Outcome {
  const different = differing(k.t, x, y, [...k.a, ...k.s].flatMap(row => row.cols));
  const set = different.filter(column => proven(k, y, column));
  const conflict = different.filter(column => !set.includes(column));
  return set.length > 0 ? { do: 'change', set, conflict } : differsIn(conflict);
}

function onlySourceHolds(k: KeyCase): Outcome {
  if (k.a.length === 0) return EQUAL;
  return inserted(k.a) && !k.theirs.delete ? ADD : { do: 'conflict', kind: 'changed_removed', cols: [] };
}

function leaderLeftItAlone(k: KeyCase): boolean {
  return !keyIsTheLeaders(k) && [...k.theirs.cols].every(column => bookkeepingOf(k.t).includes(column));
}

function baseRow(k: KeyCase): Row {
  return Object.fromEntries(k.t.columns.map(({ name }) => [name, baseOf(k.a, name)]));
}

const mayDelete = (k: KeyCase, y: Row): boolean => !inserted(k.a) && leaderLeftItAlone(k) && differing(k.t, baseRow(k), y).length === 0;

function onlyLeaderHolds(k: KeyCase, y: Row): Outcome {
  if (k.a.length === 0) return EQUAL;
  const journal = [...k.a, ...k.s].sort(byTimeThenId);
  const last = journal.at(-1)!;
  const removedByA = last.op === 'delete' && k.a.includes(last);
  if (removedByA && startsWithInsert(k.a)) return EQUAL;
  if (removedByA && mayDelete(k, y)) return { do: 'delete' };
  return { do: 'conflict', kind: 'removed_changed', cols: [], there: journal.findLast(row => row.old)?.old ?? undefined };
}

function rowsOutcome(k: KeyCase, x: Row | null, y: Row | null): Outcome {
  if (x && y) return bothHold(k, x, y);
  if (x) return onlySourceHolds(k);
  return y ? onlyLeaderHolds(k, y) : EQUAL;
}

/* Ruling 5, column by column. A row of a or s only ever keeps the leader's value or lists a difference, unless the
   journal proves the source changed it from the value the leader still holds and the leader did not. */
export function journalOutcome(t: TableFacts, x: Row | null, y: Row | null, mine: KeyHistory, theirs: Theirs = NOTHING_HERE): Outcome {
  const { kind } = ruleOf(t.name);
  if (kind !== 'rows') return neverCompared(kind, x !== null && y === null && mine.a.length > 0);
  const says = (row: JournalRow): boolean => saysSomething(t, row);
  return rowsOutcome({ t, a: mine.a.filter(says), s: mine.s.filter(says), theirs }, x, y);
}
