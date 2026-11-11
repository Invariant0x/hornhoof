import { isSecret } from './rules.js';

/* How long a value may be in a sentence before it is cut. */
const CUT = 200;
const HIDDEN = '(hidden)';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const cut = (text: string): string => (text.length > CUT ? `${text.slice(0, CUT)}...` : text);
const text = (value: unknown): string => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));
const quoted = (value: unknown): string => `"${cut(text(value))}"`;

/* A row by the name people know it by, and with no row, or for a table with no such name, by its key. A secret column's
   value is never part of a name. */
export function nameOf(table: string, row: Record<string, unknown> | null, key: Record<string, unknown>): string {
  if (row) {
    if (table === 'tasks') return `task #${text(row.number)} ${quoted(row.title)}`;
    if (table === 'turns') return `turn ${text(row.number)} ${quoted(row.title)}`;
    if (table === 'people') return `${text(row.name)} (${text(row.email)})`;
    if (table === 'agents' || table === 'departments' || table === 'teams') return text(row.name);
    if (table === 'machines') return text(row.hostname) || 'a machine';
    if (table === 'subscriptions') return text(row.label);
    if (table === 'jobs') return `job ${text(row.id).slice(0, 8)}`;
  }
  return `${table} ${Object.entries(key).map(([column, value]) => (isSecret(table, column) ? HIDDEN : text(value))).join(', ')}`;
}

/* A value as a sentence holds it: text in quotes, anything else as JSON, both cut; nothing of a secret column. */
export function valueWords(table: string, column: string, value: unknown): string {
  if (isSecret(table, column)) return HIDDEN;
  if (value === null || value === undefined) return 'nothing';
  return typeof value === 'string' ? quoted(value) : cut(JSON.stringify(value));
}

const two = (n: number): string => String(n).padStart(2, '0');
const clock = (at: Date): string => `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
/* The day, with the year when it is not this one. */
const day = (at: Date, now: Date): string => `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}${at.getUTCFullYear() === now.getUTCFullYear() ? '' : ` ${at.getUTCFullYear()}`}`;
const sameDay = (a: Date, b: Date): boolean => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

/* Times in a task's text are UTC: it is stored text that every reader sees alike. */
export function timeWords(at: Date, now: Date = new Date()): string {
  return `${day(at, now)} ${clock(at)} UTC`;
}

export function rangeWords(from: Date, to: Date, now: Date = new Date()): string {
  return sameDay(from, to) ? `${clock(from)} to ${clock(to)} UTC` : `${day(from, now)} ${clock(from)} to ${day(to, now)} ${clock(to)} UTC`;
}
