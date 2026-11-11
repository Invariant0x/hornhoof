import type { Db } from '../../db/client.js';
import { GATE_WAIT_MS, writeGate } from '../../db/gate.js';
import { factsOf, sameShape, type Facts, type ForeignKey, type Query, type TableFacts } from './facts.js';
import { queryOf, quote } from './leader.js';
import {
  compareOutcome, cutoffOf, differing, divergence, historiesOf, journalOutcome, listedIn, pathOf, skippedXacts, theirsOf, type KeyHistory, type Outcome, type Path, type Theirs,
} from './plan.js';
import {
  backupsOf, consumedIds, horizonOf, journalIds, journalRows, keyText, lastChange, listedSources, openConflicts, restoresOf, rowsByKeys, rowsOf, type JournalRow, type Row,
} from './read.js';
import { BOOKKEEPING, CLOSING, SOFT_REFS, TABLE_RULES, ruleOf, type TableRule } from './rules.js';
import type { MergeSource } from './source.js';
import { nameOf, valueWords } from './words.js';

export type Counts = {
  added: number; changed: number; deleted: number; equal: number; skipped: number; conflicts: number; carried: number; matched: number; rewritten: number;
  byTable: Record<string, { added: number; changed: number; deleted: number; conflicts: number }>;
};
/* A task with code: its number on the source, the branch by that number, and the machines the source's turns on it ran
   on with their last time. */
export type CodeLine = { task: string; number: number; branch: string; machines: { name: string; at: string }[] };
/* heldMs: how long the app's writes waited, from the gate closing to its opening. */
export type MergeResult = { path: Path; counts: Counts; tasks: string[]; code: CodeLine[]; from: Date | null; to: Date | null; heldMs: number };

/* A merge that cannot run as it is: two shapes, another company, applied already. Trying again changes nothing. */
export class MergeRefused extends Error {}

type Listed = { kind: 'differs' | 'changed_removed' | 'removed_changed'; cols: string[]; there: Row | null };
/* One row of the source and what the merge does with it. */
type Unit = {
  table: string;
  /* The source's key. */
  key: Record<string, unknown>;
  op: 'insert' | 'update' | 'delete' | null;
  x: Row | null;
  y: Row | null;
  set: string[];
  listed: Listed | null;
  /* Its journal rows that prove or are too old to, and those of skipped transactions. */
  rows: JournalRow[];
  skipped: JournalRow[];
  /* A row of skipped transactions alone that the leader lacks or holds otherwise. */
  left: boolean;
  /* Why this side does not take it; it stays through every pass. */
  refused: string | null;
  done: 'added' | 'changed' | 'deleted' | 'matched' | 'still_used' | null;
  written: Row | null;
  rewritten: { cols: string[]; was: Row } | null;
  matched: Record<string, unknown> | null;
};

const CLASS_23 = /^23/;
const TASK_NUMBERS: Record<string, string> = { tasks: 'task_numbers_used', turns: 'turn_numbers_used' };
const ENDED_TASKS = ['done', 'cancelled'];
const UNITS = 'merge_units';
const UNIT = 'merge_unit';

const typeOf = (t: TableFacts, column: string): string => t.columns.find(found => found.name === column)!.type;
const typed = (t: TableFacts, columns: string[]): string => columns.map(name => `${quote(name)} ${typeOf(t, name)}`).join(', ');
const keyOf = (t: TableFacts, row: Row): Record<string, unknown> => Object.fromEntries(t.key.map(name => [name, row[name]]));
const matches = (alias: string, columns: string[]): string => columns.map(name => `${alias}.${quote(name)} = k.${quote(name)}`).join(' AND ');
const codeOf = (err: unknown): string => String((err as { cause?: { code?: unknown }; code?: unknown }).cause?.code ?? (err as { code?: unknown }).code ?? '');
/* What Postgres names of a refused row: the constraint, or the column that may not be empty. */
function refusalOf(err: unknown): string {
  const said = ((err as { cause?: unknown }).cause ?? err) as { constraint?: string; column?: string; message?: string };
  return `This side does not take it: ${said.constraint ?? said.column ?? said.message ?? 'a constraint'}.`;
}

/* The rule decides before the planner: a table of records only ever adds. */
const addsOnly = (rule: TableRule, outcome: Outcome): Outcome => (rule.kind === 'rows' || outcome.do === 'add' ? outcome : { do: 'equal' });

/* The translation of map_returns.source_key between a side's numbers and what names an event on both: task:<the id of a
   task_events row> becomes task:u:<its uuid>, and message:<the seq of an agent_events row> becomes message:u:<its id>. */
const NUMBERED = /^(task|message):(\d+)$/;
const NAMED = /^(task|message):u:([0-9a-f-]{36})$/;
async function namesOf(q: Query, keys: unknown[]): Promise<Map<string, string>> {
  const numbers = (kind: string) => [...new Set(keys.flatMap(key => (typeof key === 'string' && NUMBERED.exec(key)?.[1] === kind ? [NUMBERED.exec(key)![2]!] : [])))];
  const named = new Map<string, string>();
  const [tasks, messages] = [numbers('task'), numbers('message')];
  if (tasks.length > 0) {
    for (const row of await q<{ n: string; name: string }>('SELECT id::text AS n, uuid::text AS name FROM public.task_events WHERE id IN (SELECT value::bigint FROM jsonb_array_elements_text($1::jsonb))', [JSON.stringify(tasks)])) named.set(`task:${row.n}`, `task:u:${row.name}`);
  }
  if (messages.length > 0) {
    for (const row of await q<{ n: string; name: string }>('SELECT seq::text AS n, id::text AS name FROM public.agent_events WHERE seq IN (SELECT value::bigint FROM jsonb_array_elements_text($1::jsonb))', [JSON.stringify(messages)])) named.set(`message:${row.n}`, `message:u:${row.name}`);
  }
  return named;
}
/* A named key as this side numbers it, with a key of null when this side has no such event; so is one that still
   holds a number, which the source itself had no event for. Null for a key that names no event at all. */
async function numberOf(q: Query, key: string): Promise<{ key: string | null; table: string } | null> {
  const numbered = NUMBERED.exec(key);
  if (numbered) return { key: null, table: numbered[1] === 'task' ? 'task_events' : 'agent_events' };
  const parts = NAMED.exec(key);
  if (!parts) return null;
  if (parts[1] === 'task') {
    const [row] = await q<{ n: string }>('SELECT id::text AS n FROM public.task_events WHERE uuid = $1::uuid', [parts[2]]);
    return { key: row ? `task:${row.n}` : null, table: 'task_events' };
  }
  const [row] = await q<{ n: string }>('SELECT seq::text AS n FROM public.agent_events WHERE id = $1::uuid', [parts[2]]);
  return { key: row ? `message:${row.n}` : null, table: 'agent_events' };
}
export async function withNamedKeys(q: Query, rows: (Row | null)[]): Promise<void> {
  const named = await namesOf(q, rows.map(row => row?.source_key));
  for (const row of rows) if (row && typeof row.source_key === 'string') row.source_key = named.get(row.source_key) ?? row.source_key;
}

/* The merge of one source, inside its transaction. */
class Merge {
  readonly units: Unit[] = [];
  private readonly counts: Counts = { added: 0, changed: 0, deleted: 0, equal: 0, skipped: 0, conflicts: 0, carried: 0, matched: 0, rewritten: 0, byTable: {} };
  /* Journal rows nothing is done with: of tables that are never merged, and of keys that came out equal. */
  private readonly quiet: JournalRow[] = [];
  private path: Path = 'compare';
  private cutoff: Date | null = null;
  private facts!: Facts;
  private proving: JournalRow[] = [];
  /* The turn open here when a pass begins, and the source's turns that are added closed because of it. */
  private openTurn: string | null = null;
  private closing = new Set<string>();
  private asked = 0;
  private now = '';

  constructor(
    private readonly q: Query,
    private readonly src: Query,
    private readonly merge: { id: string; label: string; kept: boolean; companyId: string },
    private readonly onUnit?: (n: number) => void | Promise<void>,
  ) {}

  async run(): Promise<Omit<MergeResult, 'heldMs'>> {
    const { q, src, merge } = this;
    /* Nothing of the app may end this transaction, and no session outside the gate may write what it reads: the locks
       are taken before the first read takes the snapshot. */
    await q("SET LOCAL lock_timeout = '10s'");
    await q('SET LOCAL statement_timeout = 0');
    await q('SET LOCAL transaction_timeout = 0');
    await q(`LOCK TABLE ${Object.keys(TABLE_RULES).filter(name => TABLE_RULES[name]!.kind !== 'skip').map(name => `public.${quote(name)}`).join(', ')} IN EXCLUSIVE MODE`);
    await q('SET CONSTRAINTS ALL DEFERRED');
    const [row] = await q<{ status: string; source: string; now: string }>('SELECT status, source, to_jsonb(now()) #>> \'{}\' AS now FROM net.merges WHERE id = $1::uuid FOR UPDATE', [merge.id]);
    if (row?.status !== 'pending') throw new MergeRefused('The merge was applied already.');
    this.now = row.now;
    this.facts = await factsOf(q);
    const shape = sameShape(this.facts, await factsOf(src));
    if (shape) throw new MergeRefused(shape);
    for (const name of this.facts.tables.keys()) ruleOf(name);
    const [theirs] = await src<{ id: string }>('SELECT id FROM public.companies LIMIT 1');
    if (theirs?.id !== merge.companyId) throw new MergeRefused('This database is of another company.');

    await this.plan();
    await this.write();
    const carried = await this.carry();
    await this.backups();
    const tasks = await this.record(carried);
    const code = await this.codeOf(tasks);
    const [from, to] = await this.span(row.source);
    await q(
      `UPDATE net.merges SET path = $2, cutoff = $3::timestamptz, counts = $4::jsonb, tasks = ARRAY(SELECT value::uuid FROM jsonb_array_elements_text($5::jsonb)), code = $6::jsonb, from_at = $7::timestamptz, to_at = $8::timestamptz,
         xact = md5(COALESCE((SELECT cluster FROM net_local.state), (SELECT system_identifier::text FROM pg_control_system())) || ':' || pg_current_xact_id()::text)::uuid,
         status = 'applied', applied_at = now(), task_wanted = true, error = NULL WHERE id = $1::uuid`,
      [merge.id, this.path, this.cutoff, JSON.stringify(this.counts), JSON.stringify(tasks), JSON.stringify(code), from, to],
    );
    return { path: this.path, counts: this.counts, tasks, code, from, to };
  }

  /* Which way, and one unit for every row the source has something to say of. */
  private async plan(): Promise<void> {
    const { q, src, merge } = this;
    let histories = new Map<string, Map<string, KeyHistory>>();
    let theirs = new Map<string, Map<string, Theirs>>();
    if (!merge.kept) {
      const leaderHorizon = await horizonOf(q);
      this.cutoff = cutoffOf(await horizonOf(src), leaderHorizon);
      const [theirIds, ownIds] = [await journalIds(src, this.cutoff), await journalIds(q, this.cutoff)];
      const lacking = [...theirIds.keys()].filter(id => !ownIds.has(id));
      const parted = divergence(theirIds, ownIds, await consumedIds(q, lacking));
      this.path = pathOf({ kept: false, leaderRestores: await restoresOf(q), sourceRestores: await restoresOf(src), shared: parted.shared });
      if (this.path === 'journal') {
        const a = await journalRows(src, parted.a);
        const named = listedIn(a);
        const skipped = skippedXacts(a, await listedSources(q, named.sources, named.calls));
        this.proving = a.filter(found => !skipped.has(found.xact));
        histories = historiesOf(a, skipped, leaderHorizon);
        theirs = theirsOf(await journalRows(q, parted.b));
      }
    }
    for (const name of this.facts.order) {
      const rule = ruleOf(name);
      const t = this.facts.tables.get(name)!;
      const out = rule.kind === 'skip' || (this.path === 'compare' && rule.afterRestore === 'skip');
      if (this.path === 'compare') {
        if (!out) await this.compare(t, rule);
      } else if (out) this.quiet.push(...[...(histories.get(name)?.values() ?? [])].flatMap(history => [...history.a, ...history.s, ...history.old]));
      else await this.byJournal(t, rule, histories.get(name) ?? new Map(), theirs.get(name));
    }
    /* Rows of tables this build does not have say nothing. */
    for (const [name, keys] of histories) if (!this.facts.tables.has(name)) this.quiet.push(...[...keys.values()].flatMap(history => [...history.a, ...history.s, ...history.old]));
  }

  /* The leader's rows for these rows of the source: by the key, or for a log by what names a row on both sides. */
  private async heres(t: TableFacts, rule: TableRule, xs: Row[]): Promise<(x: Row) => Row | null> {
    const by = rule.kind === 'log' && rule.match && !(t.key.length === 1 && t.key[0] === rule.match) ? rule.match : undefined;
    const found = await rowsByKeys(this.q, t, xs.map(x => (by ? { [by]: x[by] } : keyOf(t, x))), by);
    return x => found.get(keyText(by ? { [by]: x[by] } : keyOf(t, x))) ?? null;
  }

  private async byJournal(t: TableFacts, rule: TableRule, histories: Map<string, KeyHistory>, theirs?: Map<string, Theirs>): Promise<void> {
    if (histories.size === 0) return;
    const keys = [...histories.values()].map(history => (history.a[0] ?? history.old[0] ?? history.s[0])!.key);
    const xs = await rowsByKeys(this.src, t, keys);
    const here = await this.heres(t, rule, [...xs.values()]);
    const ys = rule.kind === 'log' ? null : await rowsByKeys(this.q, t, keys);
    const pairs = keys.map(key => ({ key, text: keyText(key), x: xs.get(keyText(key)) ?? null }));
    const both = pairs.map(pair => ({ ...pair, y: pair.x ? here(pair.x) : (ys?.get(pair.text) ?? null) }));
    if (t.name === 'map_returns') {
      await withNamedKeys(this.src, [...both.map(pair => pair.x), ...[...histories.values()].flatMap(history => [...history.a, ...history.s, ...history.old].map(found => found.old))]);
      await withNamedKeys(this.q, both.map(pair => pair.y));
    }
    for (const { key, text, x, y } of both) {
      const mine = histories.get(text)!;
      const outcome = addsOnly(rule, journalOutcome(t, x, y, mine, rule.kind === 'log' ? undefined : theirs?.get(text)));
      const alone = mine.a.length === 0 && mine.old.length === 0;
      const left = alone && x !== null && (y === null || (rule.kind === 'rows' && differing(t, x, y).length > 0));
      this.unit(t, rule, { key, x, y, outcome, rows: [...mine.a, ...mine.old], skipped: mine.s, left });
    }
  }

  private async compare(t: TableFacts, rule: TableRule): Promise<void> {
    for await (const page of rowsOf(this.src, t)) {
      const here = await this.heres(t, rule, page);
      const ys = page.map(x => here(x));
      if (t.name === 'map_returns') {
        await withNamedKeys(this.src, page);
        await withNamedKeys(this.q, ys);
      }
      page.forEach((x, index) => {
        const outcome = addsOnly(rule, compareOutcome(t, x, ys[index]!));
        if (outcome.do === 'equal') this.counts.equal += 1;
        else this.unit(t, rule, { key: keyOf(t, x), x, y: ys[index]!, outcome, rows: [], skipped: [], left: false });
      });
    }
  }

  private unit(t: TableFacts, rule: TableRule, planned: { key: Record<string, unknown>; x: Row | null; y: Row | null; outcome: Outcome; rows: JournalRow[]; skipped: JournalRow[]; left: boolean }): void {
    const { outcome } = planned;
    const unit: Unit = { table: t.name, key: planned.key, op: null, x: planned.x, y: planned.y, set: [], listed: null, rows: planned.rows, skipped: planned.skipped, left: planned.left, refused: null, done: null, written: null, rewritten: null, matched: null };
    if (outcome.do === 'add') unit.op = 'insert';
    else if (outcome.do === 'delete') unit.op = 'delete';
    else if (outcome.do === 'change') {
      /* What only this side settles is never taken, whatever the journal proves of it. */
      const own = new Set(rule.hereOnly ?? []);
      unit.set = outcome.set.filter(column => !own.has(column));
      const listed = [...outcome.conflict, ...outcome.set.filter(column => own.has(column))];
      if (unit.set.length > 0) unit.op = 'update';
      if (listed.length > 0) unit.listed = { kind: 'differs', cols: listed, there: planned.x };
    } else if (outcome.do === 'conflict') unit.listed = { kind: outcome.kind, cols: outcome.cols, there: outcome.there ?? planned.x };
    else this.counts.equal += 1;
    this.units.push(unit);
  }

  /* Every unit under its own savepoint, parents first and deletes last, children first. Then the references: a unit
     whose row points at a row that is not here is refused, and everything is written again without it, until a pass
     refuses none. Nothing is ever undone by a delete or a value put back. */
  private async write(): Promise<void> {
    const { q } = this;
    const order = new Map(this.facts.order.map((name, index) => [name, index]));
    /* A log's rows get their numbers here in the order the source numbered them, whatever order they were read in. */
    const numbered = (unit: Unit): number => Number(unit.x?.[ruleOf(unit.table).sequence ?? ''] ?? 0);
    const writes = this.units.filter(unit => unit.op === 'insert' || unit.op === 'update').sort((a, b) => order.get(a.table)! - order.get(b.table)! || numbered(a) - numbered(b));
    const deletes = this.units.filter(unit => unit.op === 'delete').sort((a, b) => order.get(b.table)! - order.get(a.table)!);
    await q(`SAVEPOINT ${UNITS}`);
    for (let pass = 0; ; pass += 1) {
      if (pass > 0) await q(`ROLLBACK TO SAVEPOINT ${UNITS}`);
      for (const unit of this.units) Object.assign(unit, { done: null, written: null, rewritten: null, matched: null });
      const [open] = await q<{ id: string }>("SELECT id FROM public.turns WHERE status = 'open' LIMIT 1");
      this.openTurn = open?.id ?? null;
      this.closing = new Set(writes.filter(unit => unit.table === 'turns' && unit.op === 'insert' && !unit.refused && this.openTurn && unit.x!.status === 'open').map(unit => String(unit.x!.id)));
      for (const unit of [...writes, ...deletes]) {
        if (pass === 0) await this.onUnit?.((this.asked += 1));
        if (!unit.refused) await this.attempt(unit);
      }
      if ((await this.references(writes)) === 0) break;
    }
    await q(`RELEASE SAVEPOINT ${UNITS}`);
  }

  private async attempt(unit: Unit): Promise<void> {
    const { q } = this;
    const t = this.facts.tables.get(unit.table)!;
    await q(`SAVEPOINT ${UNIT}`);
    try {
      if (unit.op === 'insert') await this.insert(t, unit);
      else if (unit.op === 'update') await this.update(t, unit);
      else await this.delete(t, unit);
      await q(`RELEASE SAVEPOINT ${UNIT}`);
    } catch (err) {
      /* A constraint takes the unit back alone; anything else is a fault, which ends the whole merge unchanged. */
      if (!CLASS_23.test(codeOf(err))) throw err;
      await q(`ROLLBACK TO SAVEPOINT ${UNIT}`);
      await q(`RELEASE SAVEPOINT ${UNIT}`);
      Object.assign(unit, { done: null, written: null, rewritten: null });
      if (!(await this.samePlace(t, unit, err))) unit.refused = refusalOf(err);
    }
  }

  /* A person's place that this side holds under another id, as a restore's carry writes them: the same row. */
  private async samePlace(t: TableFacts, unit: Unit, err: unknown): Promise<boolean> {
    const said = ((err as { cause?: unknown }).cause ?? err) as { constraint?: string };
    if (unit.table !== 'person_access' || unit.op !== 'insert' || said.constraint !== 'person_access_place') return false;
    const x = unit.x!;
    const [found] = await this.q<{ row: Row }>(
      'SELECT to_jsonb(t) AS row FROM public.person_access t WHERE t.person_id = $1::uuid AND t.department_id IS NOT DISTINCT FROM $2::uuid AND t.team_id IS NOT DISTINCT FROM $3::uuid',
      [x.person_id, x.department_id ?? null, x.team_id ?? null],
    );
    if (!found || differing(t, x, found.row).some(column => column !== 'id' && column !== 'created_at')) return false;
    unit.done = 'matched';
    unit.matched = keyOf(t, found.row);
    return true;
  }

  /* The row as this side takes it, with what was written otherwise than the source has it. */
  private async prepared(t: TableFacts, rule: TableRule, unit: Unit): Promise<Row | null> {
    const { q } = this;
    const row: Row = { ...unit.x! };
    const was: Row = {};
    const put = (column: string, value: unknown): void => {
      if (!(column in was)) was[column] = unit.x![column] ?? null;
      row[column] = value;
    };
    if (rule.number) {
      const scope = (first: number): string => rule.number!.map((column, index) => `t.${quote(column)} IS NOT DISTINCT FROM $${index + first}::${typeOf(t, column)}`).join(' AND ');
      const values = rule.number.map(column => row[column] ?? null);
      const [taken] = await q(`SELECT 1 AS found FROM public.${quote(t.name)} t WHERE t.number = $1::int AND ${scope(2)} LIMIT 1`, [row.number, ...values]);
      if (taken) {
        /* The next free one: above every row of its scope, and above the numbers the company gave to rows it removed. */
        const used = TASK_NUMBERS[t.name] ? `COALESCE((SELECT ${quote(TASK_NUMBERS[t.name]!)} FROM public.companies LIMIT 1), 0)` : '0';
        const [next] = await q<{ n: number }>(`SELECT GREATEST(COALESCE(max(t.number), 0), ${used}) + 1 AS n FROM public.${quote(t.name)} t WHERE ${scope(1)}`, values);
        put('number', next!.n);
      }
    }
    if (t.name === 'turns' && this.closing.has(String(row.id))) {
      put('status', 'closed');
      put('closed_at', this.now);
    }
    if (t.name === 'tasks' && row.turn_id && this.closing.has(String(row.turn_id)) && !ENDED_TASKS.includes(String(row.status))) put('turn_id', this.openTurn);
    if (t.name === 'agents' && !row.removed_at && (row.kind === 'head' || row.kind === 'orchestrator')) {
      const where = row.kind === 'head' ? 'department_id = $1::uuid' : 'company_id = $1::uuid';
      const [live] = await q(`SELECT 1 AS found FROM public.agents WHERE kind = $2 AND removed_at IS NULL AND id <> $3::uuid AND ${where} LIMIT 1`, [row.kind === 'head' ? row.department_id : row.company_id, row.kind, row.id]);
      if (live) put('kind', 'worker');
    }
    for (const closing of CLOSING[t.name] ?? []) {
      if (!closing.open.includes((row[closing.column] ?? null) as string | null)) continue;
      put(closing.column, closing.to);
      put(closing.at, this.now);
      if (closing.error) put(closing.error, this.merge.kept || this.path === 'compare' ? 'Ran before the restore; how it ended was not kept.' : `Ran on ${this.merge.label} while it was cut off.`);
      for (const [column, value] of Object.entries(closing.also ?? {})) put(column, value);
      break;
    }
    for (const column of rule.hereOnly ?? []) if (row[column] !== null && row[column] !== undefined) put(column, null);
    /* A row never points at what is never merged. */
    for (const fk of t.fks) {
      const [column] = fk.columns;
      if (fk.columns.length === 1 && ruleOf(fk.parent).kind === 'skip' && row[column!] !== null && row[column!] !== undefined && t.columns.find(found => found.name === column)!.nullable) put(column!, null);
    }
    if (rule.sequence) {
      const [next] = await q<{ n: string }>(`SELECT nextval(pg_get_serial_sequence($1, $2))::text AS n`, [`public.${quote(t.name)}`, rule.sequence]);
      row[rule.sequence] = Number(next!.n);
    }
    if (t.name === 'map_returns' && typeof row.source_key === 'string') {
      const numbered = await numberOf(q, row.source_key);
      if (numbered && numbered.key === null) {
        unit.refused = `Its ${numbered.table} row is not here.`;
        return null;
      }
      if (numbered) row.source_key = numbered.key;
    }
    if (Object.keys(was).length > 0) unit.rewritten = { cols: Object.keys(was), was };
    return row;
  }

  private async insert(t: TableFacts, unit: Unit): Promise<void> {
    const row = await this.prepared(t, ruleOf(t.name), unit);
    if (!row) return;
    await this.q(`INSERT INTO public.${quote(t.name)} SELECT * FROM jsonb_populate_record(NULL::public.${quote(t.name)}, $1::jsonb)`, [JSON.stringify(row)]);
    unit.written = row;
    unit.done = 'added';
  }

  /* The columns the journal proves, written in one statement. A row the leader holds open stays as it is, with nothing
     of the source's run of it; any other row is never written open. The bookkeeping stays this side's, but for the
     later of the two times and a version above both. */
  private async update(t: TableFacts, unit: Unit): Promise<void> {
    const row: Row = { ...unit.x! };
    let set = [...unit.set];
    const was: Row = {};
    for (const closing of CLOSING[t.name] ?? []) {
      if (!set.includes(closing.column) || !closing.open.includes((row[closing.column] ?? null) as string | null)) continue;
      const own = [closing.column, closing.at, ...(closing.error ? [closing.error] : []), ...Object.keys(closing.also ?? {})];
      if (closing.open.includes((unit.y![closing.column] ?? null) as string | null)) {
        for (const column of set) was[column] = unit.x![column] ?? null;
        set = [];
      } else {
        for (const column of own) if (set.includes(column)) was[column] = unit.x![column] ?? null;
        row[closing.column] = closing.to;
        row[closing.at] = this.now;
        if (closing.error) row[closing.error] = `Ran on ${this.merge.label} while it was cut off.`;
        Object.assign(row, closing.also ?? {});
        set = [...new Set([...set, ...own])];
        for (const column of own) if (!(column in was)) was[column] = unit.x![column] ?? null;
      }
      break;
    }
    if (t.name === 'map_returns' && set.includes('source_key') && typeof row.source_key === 'string') {
      const numbered = await numberOf(this.q, row.source_key);
      if (numbered && numbered.key === null) return void (unit.refused = `Its ${numbered.table} row is not here.`);
      if (numbered) row.source_key = numbered.key;
    }
    if (Object.keys(was).length > 0) unit.rewritten = { cols: Object.keys(was), was };
    unit.written = { ...unit.y!, ...Object.fromEntries(set.map(column => [column, row[column]])) };
    unit.done = 'changed';
    if (set.length === 0) return;
    const kept = BOOKKEEPING[t.name] ?? [];
    const more = [
      ...(kept.includes('updated_at') && t.columns.some(column => column.name === 'updated_at') ? ['"updated_at" = GREATEST(t."updated_at", r."updated_at")'] : []),
      ...(t.name === 'tasks' ? ['"version" = GREATEST(t."version", r."version") + 1'] : []),
    ];
    const taken = set.map(column => `${quote(column)} = r.${quote(column)}`);
    const changed = await this.q(
      `UPDATE public.${quote(t.name)} t SET ${[...taken, ...more].join(', ')} FROM jsonb_populate_record(NULL::public.${quote(t.name)}, $1::jsonb) r, jsonb_to_record($2::jsonb) AS k(${typed(t, t.key)}) WHERE ${matches('t', t.key)} RETURNING 1 AS found`,
      [JSON.stringify(row), JSON.stringify(keyOf(t, unit.y!))],
    );
    if (changed.length !== 1) throw new Error(`The merge found no row of ${t.name} to change.`);
  }

  /* A row something here still points at stays, so nothing the merge deletes cascades. */
  private async delete(t: TableFacts, unit: Unit): Promise<void> {
    const y = unit.y!;
    if (await this.pointedAt(t, y)) return void (unit.done = 'still_used');
    await this.q(`DELETE FROM public.${quote(t.name)} t USING jsonb_to_record($1::jsonb) AS k(${typed(t, t.key)}) WHERE ${matches('t', t.key)}`, [JSON.stringify(keyOf(t, y))]);
    unit.done = 'deleted';
  }

  private async pointedAt(t: TableFacts, y: Row): Promise<boolean> {
    for (const fk of t.referencedBy) {
      const where = fk.columns.map((column, index) => `c.${quote(column)} = $${index + 1}::${typeOf(t, fk.parentColumns[index]!)}`).join(' AND ');
      const self = fk.table === t.name ? ` AND NOT (${t.key.map((column, index) => `c.${quote(column)} = $${fk.columns.length + index + 1}::${typeOf(t, column)}`).join(' AND ')})` : '';
      const [found] = await this.q(`SELECT 1 AS found FROM public.${quote(fk.table)} c WHERE ${where}${self} LIMIT 1`, [...fk.parentColumns.map(column => y[column]), ...(self ? t.key.map(column => y[column]) : [])]);
      if (found) return true;
    }
    for (const soft of SOFT_REFS.filter(ref => ref.parent === t.name)) {
      const when = soft.when ? ` AND c.${quote(soft.when.column)} = $2` : '';
      const holds = soft.list ? `c.${quote(soft.column)} @> jsonb_build_array($1::text)` : `c.${quote(soft.column)}::text = $1::text`;
      const [found] = await this.q(`SELECT 1 AS found FROM public.${quote(soft.table)} c WHERE ${holds}${when} LIMIT 1`, [String(y.id), ...(soft.when ? [soft.when.value] : [])]);
      if (found) return true;
    }
    return false;
  }

  /* How many units this pass refuses for a row they point at that is not here: by a foreign key, or by an id in a column
     no foreign key checks. */
  private async references(writes: Unit[]): Promise<number> {
    let refused = 0;
    const live = writes.filter(unit => !unit.refused && unit.written && (unit.done === 'added' || unit.done === 'changed'));
    const byTable = new Map<string, Unit[]>();
    for (const unit of live) byTable.set(unit.table, [...(byTable.get(unit.table) ?? []), unit]);
    for (const [name, units] of byTable) {
      const t = this.facts.tables.get(name)!;
      for (const fk of t.fks) {
        const asked = units.filter(unit => !unit.refused && (unit.done === 'added' || fk.columns.some(column => unit.set.includes(column))) && fk.columns.every(column => unit.written![column] !== null && unit.written![column] !== undefined));
        for (const lost of await this.lost(t, fk, asked)) {
          lost.refused = `Its ${fk.parent} row is not here.`;
          refused += 1;
        }
      }
      for (const soft of SOFT_REFS.filter(ref => ref.table === name)) {
        for (const unit of units) {
          if (unit.refused || !(unit.done === 'added' || unit.set.includes(soft.column))) continue;
          if (soft.when && unit.written![soft.when.column] !== soft.when.value) continue;
          const value = unit.written![soft.column];
          const ids = (soft.list ? (Array.isArray(value) ? value : []) : value === null || value === undefined ? [] : [value]).map(String);
          if (ids.length === 0) continue;
          const [found] = await this.q<{ n: number }>(`SELECT count(*)::int AS n FROM public.${quote(soft.parent)} p WHERE p.id::text IN (SELECT jsonb_array_elements_text($1::jsonb))`, [JSON.stringify([...new Set(ids)])]);
          if (found!.n === new Set(ids).size) continue;
          unit.refused = `Its ${soft.parent} row is not here.`;
          refused += 1;
        }
      }
    }
    return refused;
  }

  private async lost(t: TableFacts, fk: ForeignKey, asked: Unit[]): Promise<Unit[]> {
    if (asked.length === 0) return [];
    const parent = this.facts.tables.get(fk.parent)!;
    const values = asked.map((unit, index) => ({ ord: index, ...Object.fromEntries(fk.columns.map(column => [column, unit.written![column]])) }));
    const where = fk.columns.map((column, index) => `p.${quote(fk.parentColumns[index]!)} = k.${quote(column)}`).join(' AND ');
    const rows = await this.q<{ ord: number }>(
      `SELECT k.ord FROM jsonb_to_recordset($1::jsonb) AS k(ord int, ${typed(t, fk.columns)}) WHERE NOT EXISTS (SELECT 1 FROM public.${quote(parent.name)} p WHERE ${where})`,
      [JSON.stringify(values)],
    );
    return rows.map(row => asked[row.ord]!);
  }

  /* The conflicts an earlier merge left open in the source: each may hold the only copy of a value the company wrote. */
  private async carry(): Promise<Row[]> {
    const carried: Row[] = [];
    for (const theirs of await openConflicts(this.src)) {
      const first = theirs.carried ?? theirs.id;
      const [held] = await this.q('SELECT 1 AS found FROM net.merge_conflicts WHERE id = $1::uuid OR carried = $1::uuid LIMIT 1', [first]);
      if (!held) carried.push({ ...theirs, carried: first });
    }
    return carried;
  }

  /* A restore of an older bundle then lists, and can check, the bundles made after it. */
  private async backups(): Promise<void> {
    for (const backup of await backupsOf(this.src)) {
      await this.q('INSERT INTO net.backups SELECT * FROM jsonb_populate_record(NULL::net.backups, $1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(backup)]);
    }
  }

  /* What names a unit's row in the records: its key, or for a log what names it on both sides. */
  private named(unit: Unit): Record<string, unknown> {
    const rule = ruleOf(unit.table);
    const row = unit.x ?? unit.y;
    return rule.kind === 'log' && rule.match && row ? { [rule.match]: row[rule.match] } : unit.key;
  }

  private taskOf(unit: Unit): string | null {
    const column = ruleOf(unit.table).task;
    const value = column ? (unit.x ?? unit.y ?? unit.listed?.there)?.[column] : null;
    return typeof value === 'string' ? value : null;
  }

  private count(unit: Unit, what: 'added' | 'changed' | 'deleted' | 'conflicts'): void {
    this.counts[what] += 1;
    const table = (this.counts.byTable[unit.table] ??= { added: 0, changed: 0, deleted: 0, conflicts: 0 });
    table[what] += 1;
  }

  private why(unit: Unit, what: string): string {
    return `${nameOf(unit.table, unit.y ?? unit.x ?? unit.listed?.there ?? null, this.named(unit))}: ${what}`;
  }

  /* The records of what was done, in the merge's own transaction. The tasks the merge touched. */
  private async record(carried: Row[]): Promise<string[]> {
    const { q, merge } = this;
    const tasks = new Set<string>();
    const conflicts: Row[] = [];
    const kept: Row[] = [];
    const consumed: Row[] = [];
    const listed = (unit: Unit, over: { op: string; kind: string; cols: string[]; there: Row | null; why: string }): void => {
      const latest = [...unit.rows, ...unit.skipped].reduce<Date | null>((last, row) => (!last || row.at > last ? row.at : last), null);
      conflicts.push({ merge: merge.id, carried: null, tbl: unit.table, key: this.named(unit), topic: ruleOf(unit.table).topic, task_id: this.taskOf(unit), here: unit.y, at: latest, ...over });
      this.count(unit, 'conflicts');
    };
    for (const unit of this.units) {
      let touched = false;
      if (unit.refused) {
        listed(unit, { op: unit.op!, kind: 'refused', cols: unit.op === 'update' ? unit.set : [], there: unit.x, why: this.why(unit, unit.refused) });
        touched = true;
      } else if (unit.done === 'still_used') {
        listed(unit, { op: 'delete', kind: 'still_used', cols: [], there: null, why: this.why(unit, 'removed there, and something here still points at it.') });
        touched = true;
      } else if (unit.done === 'added' || unit.done === 'changed' || unit.done === 'deleted') {
        this.count(unit, unit.done);
        touched = true;
      } else if (unit.done === 'matched') {
        this.counts.matched += 1;
        kept.push({ merge: merge.id, tbl: unit.table, key: this.named(unit), how: 'matched', cols: [], was: null, here: unit.matched });
      }
      if (unit.listed) {
        const { kind, cols, there } = unit.listed;
        const t = this.facts.tables.get(unit.table)!;
        const shown = kind === 'differs' && unit.y && there ? (cols.length > 0 ? cols : differing(t, there, unit.y)) : [];
        const words = kind === 'differs' ? shown.map(column => `${column}: here ${valueWords(unit.table, column, unit.y![column])}, there ${valueWords(unit.table, column, there![column])}`).join('; ')
          : kind === 'changed_removed' ? 'changed there, and not here any more.' : 'removed there, and changed here.';
        listed(unit, { op: kind === 'differs' ? 'update' : kind === 'changed_removed' ? 'insert' : 'delete', kind, cols, there, why: this.why(unit, words) });
        touched = true;
      }
      if (unit.rewritten && (unit.done === 'added' || unit.done === 'changed')) {
        this.counts.rewritten += 1;
        kept.push({ merge: merge.id, tbl: unit.table, key: this.named(unit), how: 'rewritten', cols: unit.rewritten.cols, was: unit.rewritten.was, here: null });
      } else if (unit.left && !unit.done && !unit.refused && !unit.listed) kept.push({ merge: merge.id, tbl: unit.table, key: this.named(unit), how: 'skipped', cols: [], was: null, here: null });
      const task = touched ? this.taskOf(unit) : null;
      if (task) tasks.add(task);
      const how = unit.refused || unit.listed || unit.done === 'still_used' ? 'conflict' : unit.done ? 'applied' : 'equal';
      for (const row of unit.rows) consumed.push({ journal: row.id, at: row.at, how });
      for (const row of unit.skipped) consumed.push({ journal: row.id, at: row.at, how: 'skipped' });
      this.counts.skipped += unit.skipped.length;
    }
    for (const row of this.quiet) consumed.push({ journal: row.id, at: row.at, how: 'equal' });
    for (const theirs of carried) {
      const t = this.facts.tables.get(String(theirs.tbl));
      const here = t && theirs.key && Object.keys(theirs.key).every(column => t.key.includes(column)) ? ((await rowsByKeys(q, t, [theirs.key as Record<string, unknown>])).values().next().value ?? null) : null;
      conflicts.push({ merge: merge.id, carried: theirs.carried, tbl: theirs.tbl, key: theirs.key, op: theirs.op, kind: theirs.kind, topic: theirs.topic, task_id: theirs.task_id, cols: theirs.cols, here, there: theirs.there, at: theirs.at, why: theirs.why });
      this.counts.carried += 1;
      this.counts.conflicts += 1;
    }
    for (const row of conflicts) {
      await q(
        `INSERT INTO net.merge_conflicts (merge, carried, tbl, key, op, kind, topic, task_id, cols, here, there, at, why)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7, $8::uuid, ARRAY(SELECT jsonb_array_elements_text($9::jsonb)), $10::jsonb, $11::jsonb, $12::timestamptz, $13)`,
        [row.merge, row.carried, row.tbl, JSON.stringify(row.key), row.op, row.kind, row.topic, row.task_id, JSON.stringify(row.cols), row.here ? JSON.stringify(row.here) : null, row.there ? JSON.stringify(row.there) : null, row.at, row.why],
      );
    }
    for (const row of kept) {
      await q(
        `INSERT INTO net.merge_rows (merge, tbl, key, how, cols, was, here) VALUES ($1::uuid, $2, $3::jsonb, $4, ARRAY(SELECT jsonb_array_elements_text($5::jsonb)), $6::jsonb, $7::jsonb)
         ON CONFLICT (merge, tbl, key) DO NOTHING`,
        [row.merge, row.tbl, JSON.stringify(row.key), row.how, JSON.stringify(row.cols), row.was ? JSON.stringify(row.was) : null, row.here ? JSON.stringify(row.here) : null],
      );
    }
    for (let from = 0; from < consumed.length; from += 1000) {
      await q(
        `INSERT INTO net.merge_consumed (journal, merge, at, how) SELECT k.journal, $1::uuid, k.at, k.how FROM jsonb_to_recordset($2::jsonb) AS k(journal uuid, at timestamptz, how text) ON CONFLICT (journal) DO NOTHING`,
        [merge.id, JSON.stringify(consumed.slice(from, from + 1000))],
      );
    }
    return [...tasks];
  }

  /* The touched tasks that have a repository: where the source's work on each lies. */
  private async codeOf(tasks: string[]): Promise<CodeLine[]> {
    if (tasks.length === 0) return [];
    const listed = JSON.stringify(tasks);
    const here = await this.q<{ id: string }>(
      `SELECT t.id FROM public.tasks t WHERE t.id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))
         AND EXISTS (SELECT 1 FROM public.departments d WHERE d.id IN (t.department_id, t.product_id) AND d.repo_url IS NOT NULL) ORDER BY t.number`,
      [listed],
    );
    const lines: CodeLine[] = [];
    for (const { id } of here) {
      const [there] = await this.src<{ number: number }>('SELECT number FROM public.tasks WHERE id = $1::uuid', [id]);
      if (!there) continue;
      const machines = await this.src<{ name: string; at: Date }>(
        `SELECT COALESCE(NULLIF(m.hostname, ''), 'the server') AS name, max(COALESCE(j.finished_at, j.started_at)) AS at
         FROM public.jobs j LEFT JOIN public.nodes n ON n.id = j.node_id LEFT JOIN public.machines m ON m.id = n.machine_id
         WHERE j.task_id = $1::uuid GROUP BY 1 HAVING max(COALESCE(j.finished_at, j.started_at)) IS NOT NULL ORDER BY 1`,
        [id],
      );
      lines.push({ task: id, number: there.number, branch: `task-${there.number}`, machines: machines.map(machine => ({ name: machine.name, at: new Date(machine.at).toISOString() })) });
    }
    return lines;
  }

  /* From when to when the source went its own way: by the journal the first and the last change that proves; after a
     restore from the restored bundle's time to the kept database's last change. */
  private async span(source: string): Promise<[Date | null, Date | null]> {
    if (this.path === 'journal') return [this.proving[0]?.at ?? null, this.proving.at(-1)?.at ?? null];
    const [restore] = source.startsWith('kept:') ? await this.q<{ at: string | Date }>('SELECT dumped_at AS at FROM net.restores WHERE kept = $1 ORDER BY at DESC LIMIT 1', [source.slice(5)]) : [];
    return [restore ? new Date(restore.at) : null, await lastChange(this.src)];
  }
}

/* Brings into the leader's database what the source did and the leader lacks, in one transaction, while the app's writes
   wait at their gate. It never writes the source, and it changes nothing when it fails. */
export async function runMerge(
  db: Db,
  merge: { id: string; label: string; kept: boolean; companyId: string },
  source: MergeSource,
  opts: { onUnit?: (n: number) => void | Promise<void>; gateWaitMs?: number; log?: (line: string) => void } = {},
): Promise<MergeResult> {
  let heldMs = 0;
  const done = await writeGate.exclusive(async () => {
    const began = Date.now();
    try {
      return await db.transaction(tx => new Merge(queryOf(tx as unknown as Db), source.query, merge, opts.onUnit).run(), { isolationLevel: 'repeatable read' });
    } finally {
      heldMs = Date.now() - began;
    }
  }, opts.gateWaitMs ?? GATE_WAIT_MS);
  /* No value of a row goes into a log line. */
  (opts.log ?? console.info)(`The merge ${merge.id} held the app's writes ${heldMs} ms.`);
  return { ...done, heldMs };
}
