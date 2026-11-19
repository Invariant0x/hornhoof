import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { ApiError, loggable } from '../../errors.js';
import { UnitWriter, type Unit } from './apply.js';
import { factsOf, type Facts, type Query, type TableFacts } from './facts.js';
import { queryOf } from './leader.js';
import { differing } from './plan.js';
import { parkedNodes, parkedOf, rowsByKeys, type Row } from './read.js';
import { SOFT_REFS, TABLE_RULES, ruleOf } from './rules.js';
import { nameOf, valueWords } from './words.js';

/* here keeps the leader's row as it is, there takes the source's side, value writes the picker's own for one conflict. */
export type Take = 'here' | 'there' | 'value';
export type Picker = { kind: 'ceo'; personId: string } | { kind: 'orchestrator'; agentId: string };
type PickFilter = { ids?: string[]; merge?: string; table?: string; from?: Date; to?: Date };
export type ConflictView = {
  id: string; merge: string; label: string; table: string; topic: string; what: string; kind: string; cols: string[];
  here: Record<string, string> | null; there: Record<string, string> | null; at: string | null;
  task: { id: string; number: number; title: string } | null; whose: 'orchestrator' | 'ceo'; picked: Take | null;
};
export type Picked = { settled: number; here: number; there: number; refused: { id: string; why: string }[]; tasks: { id: string; number: number }[] };

/* How many conflicts one call settles at most. */
const AT_ONCE = 500;
const OWNERS_ALONE = "Only the machine's owner changes its computer access on its card.";

type ConflictRow = {
  id: string; merge: string; label: string; path: string | null; tbl: string; key: Record<string, unknown>; op: 'insert' | 'update' | 'delete'; kind: string; topic: string;
  task_id: string | null; cols: string[]; here: Row | null; there: Row | null; at: string | Date | null; created_at: string | Date; picked: Take | null; would_delete: boolean;
};

/* Why a conflict stays open; said to whoever picked. */
class NotTaken extends Error {}

const iso = (value: string | Date | null): string | null => (value === null ? null : new Date(value).toISOString());

/* The words of a filter as SQL, with its values after those already there. */
function where(f: PickFilter & { settled?: boolean; after?: string }, params: unknown[]): string {
  const said: string[] = [];
  const add = (text: (n: number) => string, value: unknown): void => {
    params.push(value);
    said.push(text(params.length));
  };
  if (f.ids) add(n => `c.id IN (SELECT value::uuid FROM jsonb_array_elements_text($${n}::jsonb))`, JSON.stringify(f.ids));
  if (f.merge) add(n => `c.merge = $${n}::uuid`, f.merge);
  if (f.table) add(n => `c.tbl = $${n}`, f.table);
  if (f.from) add(n => `COALESCE(c.at, c.created_at) >= $${n}::timestamptz`, f.from);
  if (f.to) add(n => `COALESCE(c.at, c.created_at) <= $${n}::timestamptz`, f.to);
  if (f.after) add(n => `(COALESCE(c.at, c.created_at), c.id) > (SELECT COALESCE(a.at, a.created_at), a.id FROM net.merge_conflicts a WHERE a.id = $${n}::uuid)`, f.after);
  if (f.settled !== undefined) said.push(f.settled ? 'c.picked IS NOT NULL' : 'c.picked IS NULL');
  return said.length > 0 ? said.join(' AND ') : 'true';
}

export const DELETION_CONFLICT = `(c.op = 'delete' OR (c.tbl = 'people' AND coalesce(c.there->>'removed_at', '') <> '' AND coalesce(c.here->>'removed_at', '') = ''))`;

const SELECT = `SELECT c.id, c.merge, m.label, m.path, c.tbl, c.key, c.op, c.kind, c.topic, c.task_id, c.cols, c.here, c.there, c.at, c.created_at, c.picked, ${DELETION_CONFLICT} AS would_delete
  FROM net.merge_conflicts c JOIN net.merges m ON m.id = c.merge`;
const ORDER = 'ORDER BY COALESCE(c.at, c.created_at), c.id';

/* What a merge could not prove, oldest first, a page at a time. A secret column's value stays in storage. */
export async function conflictsOf(db: Db, f: PickFilter & { settled?: boolean; after?: string; limit?: number }): Promise<{ conflicts: ConflictView[]; more: boolean }> {
  const q = queryOf(db);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
  const params: unknown[] = [];
  const rows = await q<ConflictRow>(`${SELECT} WHERE ${where({ ...f, settled: f.settled ?? false }, params)} ${ORDER} LIMIT ${limit + 1}`, params);
  const shown = rows.slice(0, limit);
  const ids = [...new Set(shown.flatMap(row => row.task_id ?? []))];
  const tasks = new Map<string, { id: string; number: number; title: string }>();
  if (ids.length > 0) {
    for (const task of await q<{ id: string; number: number; title: string }>('SELECT id, number, title FROM public.tasks WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))', [JSON.stringify(ids)])) tasks.set(task.id, task);
  }
  const conflicts = shown.map(row => {
    /* The conflict's own columns, or of a whole row everything but what names it. */
    const cols = row.cols.length > 0 ? row.cols : Object.keys(row.here ?? row.there ?? {}).filter(column => !(column in row.key));
    const words = (side: Row | null): Record<string, string> | null => (side ? Object.fromEntries(cols.map(column => [column, valueWords(row.tbl, column, side[column])])) : null);
    return {
      id: row.id, merge: row.merge, label: row.label, table: row.tbl, topic: row.topic, what: nameOf(row.tbl, row.here ?? row.there, row.key), kind: row.kind, cols: row.cols,
      here: words(row.here), there: words(row.there), at: iso(row.at), task: (row.task_id && tasks.get(row.task_id)) || null, whose: row.would_delete ? ('ceo' as const) : ('orchestrator' as const), picked: row.picked,
    };
  });
  return { conflicts, more: rows.length > limit };
}

/* Whether one refused row points at the other, by a foreign key or by an id in a column no foreign key checks. */
function pointsAt(facts: Facts, from: ConflictRow, to: ConflictRow): boolean {
  const [a, b] = [from.there, to.there];
  if (!a || !b) return false;
  const t = facts.tables.get(from.tbl);
  if (t?.fks.some(fk => fk.parent === to.tbl && fk.columns.every((column, index) => a[column] !== null && a[column] !== undefined && String(a[column]) === String(b[fk.parentColumns[index]!])))) return true;
  return SOFT_REFS.some(soft => {
    if (soft.table !== from.tbl || soft.parent !== to.tbl || (soft.when && a[soft.when.column] !== soft.when.value)) return false;
    const value = a[soft.column];
    return soft.list ? Array.isArray(value) && value.map(String).includes(String(b.id)) : value !== null && value !== undefined && String(value) === String(b.id);
  });
}

/* The open refused conflicts of the same merge that hang together with this one, by what their rows point at, both ways
   and on and on: a turn and its task only come back together. */
function groupOf(facts: Facts, first: ConflictRow, refused: ConflictRow[]): ConflictRow[] {
  const group = [first];
  for (let grew = true; grew; ) {
    grew = false;
    for (const other of refused) {
      if (group.includes(other) || !group.some(member => pointsAt(facts, member, other) || pointsAt(facts, other, member))) continue;
      group.push(other);
      grew = true;
    }
  }
  return group;
}

/* The row here now that a conflict speaks of; a log's by what names it on both sides. */
async function hereNow(q: Query, t: TableFacts, conflict: ConflictRow): Promise<Row | null> {
  const rule = ruleOf(t.name);
  const by = rule.kind === 'log' && rule.match && !(t.key.length === 1 && t.key[0] === rule.match) ? rule.match : undefined;
  return (await rowsByKeys(q, t, [conflict.key], by)).values().next().value ?? null;
}

/* What taking the source's side, or a value, writes for one conflict; null when nothing is left to write. */
async function unitOf(q: Query, facts: Facts, conflict: ConflictRow, take: 'there' | 'value', value?: Record<string, unknown>): Promise<Unit | null> {
  const t = facts.tables.get(conflict.tbl);
  if (!t) throw new NotTaken(`This Hornhoof has no table ${conflict.tbl} any more.`);
  const y = await hereNow(q, t, conflict);
  const unit: Unit = { table: t.name, key: conflict.key, op: conflict.op, x: conflict.there, y, set: [], listed: null, rows: [], skipped: [], left: false, refused: null, done: null, written: null, rewritten: null, matched: null };
  if (conflict.op === 'delete') return y ? unit : null;
  if (conflict.op === 'insert') {
    if (y) throw new NotTaken('A row of that key is here now. Keep here.');
    if (!conflict.there) throw new NotTaken('The other side has no row to take.');
    return unit;
  }
  if (!y) throw new NotTaken('Its row is not here any more.');
  if (take === 'value') return { ...unit, x: { ...y, ...value }, set: Object.keys(value ?? {}) };
  if (!conflict.there) throw new NotTaken('The other side has no row to take.');
  return { ...unit, set: conflict.cols.length > 0 ? conflict.cols : differing(t, conflict.there, y) };
}

function permanentDeletion(conflict: ConflictRow, take: 'there' | 'value', value?: Record<string, unknown>): boolean {
  if (take === 'there') return conflict.would_delete;
  if (conflict.op === 'delete') return true;
  if (conflict.tbl !== 'people') return false;
  return Boolean(value?.removed_at && !conflict.here?.removed_at);
}

/* Everything a pick must hold to before it writes; it throws why not. */
function allowed(conflict: ConflictRow, take: Take, value?: Record<string, unknown>): void {
  if (conflict.picked) throw new NotTaken('Already settled.');
  if (conflict.tbl === 'machine_access' && take !== 'here') throw new NotTaken('Employee computer access is set by the orchestrator.');
  const own = TABLE_RULES[conflict.tbl]?.hereOnly ?? [];
  const written = take === 'value' ? Object.keys(value ?? {}) : take === 'there' && conflict.op === 'update' ? (conflict.cols.length > 0 ? conflict.cols : own) : [];
  if (written.some(column => own.includes(column))) throw new NotTaken(OWNERS_ALONE);
  if (take !== 'value') return;
  if (conflict.kind !== 'differs' || !value || Object.keys(value).length === 0) throw new NotTaken('A value of your own settles only a row that differs, in its own columns.');
  if (conflict.tbl === 'people' && Object.keys(value).some(column => column.startsWith('deletion_'))) {
    throw new NotTaken('A deletion decision or its progress must come from the removal workflow.');
  }
  const foreign = Object.keys(value).find(column => !conflict.cols.includes(column));
  if (foreign) throw new NotTaken(`This conflict is not about ${foreign}.`);
}

/* Settles conflicts: one, a list, or every open one of a merge, a table or a time range. Each settles in a transaction
   of its own, journaled and fenced as any change of the app; a refused row that is taken settles with the refused rows
   it hangs together with, whole or not at all. One that cannot be settled stays open, with why. */
export async function pick(ctx: Ctx, who: Picker, f: PickFilter, take: Take, value?: Record<string, unknown>): Promise<Picked> {
  const { db } = ctx;
  if (!f.ids?.length && !f.merge && !f.table && !f.from && !f.to) throw new ApiError(400, 'validation', 'Name the conflicts: ids, a merge, a table or a time range.');
  if (take === 'value' && f.ids?.length !== 1) throw new ApiError(400, 'validation', 'A value of your own settles one conflict: name it by its id.');
  const q = queryOf(db);
  const params: unknown[] = [];
  /* A pick by id reports an already settled conflict. Bulk picks visit open conflicts. */
  const found = await q<ConflictRow>(`${SELECT} WHERE ${where({ ...f, settled: f.ids ? undefined : false }, params)} ${ORDER} LIMIT ${AT_ONCE}`, params);
  const facts = await factsOf(q);
  const by = who.kind === 'ceo' ? `person:${who.personId}` : `agent:${who.agentId}`;
  const result: Picked = { settled: 0, here: 0, there: 0, refused: [], tasks: [] };
  const done = new Set<string>();
  const touched = new Set<string>();
  for (const conflict of found) {
    if (done.has(conflict.id)) continue;
    try {
      const settled = await db.transaction(async tx => settle(queryOf(tx as unknown as Db), facts, who, by, conflict, take, value));
      for (const one of settled) {
        done.add(one.id);
        result.settled += 1;
        result[take === 'here' ? 'here' : 'there'] += 1;
        if (take !== 'here' && one.task_id) touched.add(one.task_id);
      }
    } catch (err) {
      if (!(err instanceof NotTaken)) throw err;
      result.refused.push({ id: conflict.id, why: err.message });
    }
  }
  if (touched.size > 0) {
    result.tasks = await q<{ id: string; number: number }>('SELECT id, number FROM public.tasks WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb)) ORDER BY number', [JSON.stringify([...touched])]);
  }
  if (result.settled > 0) {
    const [company] = await q<{ id: string }>('SELECT id FROM public.companies LIMIT 1');
    /* What a pick wrote woke nobody: the screens read again, and so does what counts the CEO's decisions. */
    if (company) for (const type of ['org', 'requests'] as const) ctx.bus.publish(company.id, type === 'org' ? { type } : { type, spot: { departmentId: null } });
    /* A pick may have brought the row of a job a node said something of meanwhile: that is applied now. */
    await ctx.applyParked().catch((err: unknown) => ctx.log.warn({ error: loggable(err) }, 'Could not apply what nodes said of jobs while their database was away. It is tried again in a minute.'));
  }
  return result;
}

/* One conflict, or the group a refused one hangs together with, inside one transaction. The conflicts it settled. */
async function settle(q: Query, facts: Facts, who: Picker, by: string, asked: ConflictRow, take: Take, value?: Record<string, unknown>): Promise<ConflictRow[]> {
  const [fresh] = await q<ConflictRow>(`${SELECT} WHERE c.id = $1::uuid FOR UPDATE OF c`, [asked.id]);
  if (!fresh) throw new NotTaken('There is no such conflict any more.');
  let group = [fresh];
  if (take === 'there' && fresh.kind === 'refused') {
    const refused = await q<ConflictRow>(`${SELECT} WHERE c.merge = $1::uuid AND c.kind = 'refused' AND c.picked IS NULL AND c.id <> $2::uuid ${ORDER} FOR UPDATE OF c`, [fresh.merge, fresh.id]);
    group = groupOf(facts, fresh, refused);
  }
  for (const conflict of group) {
    allowed(conflict, take, value);
    if (who.kind === 'orchestrator' && take !== 'here' && permanentDeletion(conflict, take, value)) {
      throw new NotTaken('Only the CEO can choose a permanent deletion.');
    }
  }
  if (take !== 'here') await write(q, facts, group, take, value);
  await q(
    `UPDATE net.merge_conflicts SET picked = $2, value = $3::jsonb, picked_by = $4, picked_at = now() WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))`,
    [JSON.stringify(group.map(conflict => conflict.id)), take, take === 'value' ? JSON.stringify(value) : null, by],
  );
  return group;
}

/* Runs what the merge would have run for these conflicts, with the rules of each table on a row it writes: parents
   first and deletes last. A row no constraint takes, or one that points at a row that is not here, takes nothing. */
async function write(q: Query, facts: Facts, group: ConflictRow[], take: 'there' | 'value', value?: Record<string, unknown>): Promise<void> {
  const [said] = await q<{ now: string }>("SELECT to_jsonb(now()) #>> '{}' AS now");
  const writer = new UnitWriter(q, facts, { now: said!.now, label: group[0]!.label, afterRestore: group[0]!.path === 'compare' });
  /* Rows that hang together come back together, which may take longer than the app lets a transaction of its own. */
  await q('SET LOCAL transaction_timeout = 0');
  await q('SET CONSTRAINTS ALL DEFERRED');
  const order = new Map(facts.order.map((name, index) => [name, index]));
  const units = (await Promise.all(group.map(conflict => unitOf(q, facts, conflict, take, value)))).filter(unit => unit !== null).sort((a, b) => order.get(a.table)! - order.get(b.table)!);
  const writes = units.filter(unit => unit.op !== 'delete');
  /* A job a node still runs, as it said while the job's row was away, comes running. */
  await writer.begin(writes, parkedNodes(await parkedOf(q)));
  for (const unit of [...writes, ...units.filter(unit => unit.op === 'delete')]) {
    await writer.attempt(unit);
    if (unit.refused) throw new NotTaken(unit.refused);
    if (unit.done === 'still_used') throw new NotTaken('Something here still points at it.');
  }
  await writer.references(writes);
  const lost = writes.find(unit => unit.refused);
  if (lost) throw new NotTaken(lost.refused!);
}
