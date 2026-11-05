import { isSecret } from './rules.js';

type Row = Record<string, unknown>;

const LONGEST = 200;
const HIDDEN_VALUE = '(hidden)';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const cut = (text: string): string => (text.length > LONGEST ? `${text.slice(0, LONGEST)}...` : text);
const shown = (value: unknown): string => cut(String(value));
const ownName = (row: Row): string | null => (row.name ? shown(row.name) : null);

const NAMES: Readonly<Record<string, (row: Row) => string | null>> = {
  tasks: row => `task #${row.number} "${shown(row.title)}"`,
  turns: row => `turn ${row.number} "${shown(row.title)}"`,
  people: row => `${shown(row.name)} (${shown(row.email)})`,
  agents: ownName,
  departments: ownName,
  teams: ownName,
  machines: row => (row.hostname ? shown(row.hostname) : 'a machine'),
  subscriptions: row => shown(row.label),
};

const keyWords = (table: string, key: Row): string =>
  Object.entries(key).map(([column, value]) => (isSecret(table, column) ? HIDDEN_VALUE : shown(value))).join(', ');

/* A row's name reaches the orchestrator's text, so it holds no secret: sessions and invites have a hash for a key. A
   department may have no typed name, and then it is named from its key like a row that is gone. */
export function nameOf(table: string, row: Row | null, key: Row): string {
  if (table === 'jobs') return `job ${String(key.id).slice(0, 8)}`;
  return (row && NAMES[table]?.(row)) ?? `${table} ${keyWords(table, key)}`;
}

export function valueWords(table: string, column: string, value: unknown): string {
  if (isSecret(table, column)) return HIDDEN_VALUE;
  if (value === null || value === undefined) return 'nothing';
  return typeof value === 'string' ? `"${cut(value)}"` : cut(JSON.stringify(value));
}

/* A task's text is stored and every reader sees it alike, so times are UTC. The ISO form is UTC whatever the zone here. */
const clockOf = (at: Date): string => at.toISOString().slice(11, 16);
const dayKeyOf = (at: Date): string => at.toISOString().slice(0, 10);

function dayAndClock(at: Date, now: Date): string {
  const year = at.getUTCFullYear() === now.getUTCFullYear() ? '' : ` ${at.getUTCFullYear()}`;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}${year} ${clockOf(at)}`;
}

export function timeWords(at: Date, now: Date = new Date()): string {
  return `${dayAndClock(at, now)} UTC`;
}

export function rangeWords(from: Date, to: Date, now: Date = new Date()): string {
  if (dayKeyOf(from) === dayKeyOf(to)) return `${clockOf(from)} to ${clockOf(to)} UTC`;
  return `${dayAndClock(from, now)} to ${dayAndClock(to, now)} UTC`;
}
