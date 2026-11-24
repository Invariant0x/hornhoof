import type { Db } from '../../db/client.js';
import { GATE_WAIT_MS, writeGate } from '../../db/gate.js';
import { factsOf, sameShape, type Facts, type ForeignKey, type Query, type TableFacts } from './facts.js';
import { queryOf, quote } from './leader.js';
import {
  compareOutcome, cutoffOf, differing, divergence, heldAs, historiesOf, journalOutcome, listedIn, pathOf, skippedXacts, theirsOf, type KeyHistory, type Outcome, type Path, type Theirs,
} from './plan.js';
import {
  consumedIds, parkedNodes, parkedOf, type ParkedNode, FILE_HASH, horizonOf, journalIds, journalRows, keyText, listedSources, restoresOf, rowsByKeys, type JournalRow, type Row,
} from './read.js';
import { BOOKKEEPING, CLOSING, SOFT_REFS, TABLE_RULES, ruleOf, type TableRule } from './rules.js';
import {
  liveMergeReader, NeedMoreFromSource, noteMoreNeeded, prepareSource, type CodeLine, type MergeReader, type SourceRequest,
} from './snapshot.js';
import type { MergeSource } from './source.js';
import type { Files } from '../files/files.js';
import { nameOf, valueWords } from './words.js';
import { fingerprintMask, maskCompanyRows, maskJson, maskRow, type Fingerprint, type Mask } from '../tasks/hide-secret.js';

export type { CodeLine } from './snapshot.js';

export type Counts = {
  added: number; changed: number; deleted: number; equal: number; skipped: number; conflicts: number; carried: number; matched: number; rewritten: number;
  /* How many times the units were written before none of them pointed at a row that is not here. */
  passes: number;
  byTable: Record<string, { added: number; changed: number; deleted: number; conflicts: number }>;
};
/* heldMs: how long the app's writes waited, from the gate closing to its opening. */
export type MergeResult = { path: Path; counts: Counts; tasks: string[]; code: CodeLine[]; from: Date | null; to: Date | null; heldMs: number };

/* A merge that cannot run as it is: two shapes, another company, applied already. Trying again changes nothing. */
export class MergeRefused extends Error {}
export const ANOTHER_COMPANY = 'This database is of another company.';

type Listed = { kind: 'differs' | 'changed_removed' | 'removed_changed'; cols: string[]; there: Row | null };
/* One row of the source and what the merge does with it. */
export type Unit = {
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
const LOCK_NOT_TAKEN = '55P03';
const NO_FILE = 'Its file was not kept.';
const TASK_NUMBERS: Record<string, string> = { tasks: 'task_numbers_used', turns: 'turn_numbers_used' };
const ENDED_TASKS = ['done', 'cancelled'];
const UNITS = 'merge_units';
const UNIT = 'merge_unit';

const typeOf = (t: TableFacts, column: string): string => t.columns.find(found => found.name === column)!.type;
const typed = (t: TableFacts, columns: string[]): string => columns.map(name => `${quote(name)} ${typeOf(t, name)}`).join(', ');
const keyOf = (t: TableFacts, row: Row): Record<string, unknown> => Object.fromEntries(t.key.map(name => [name, row[name]]));
const matches = (alias: string, columns: string[]): string => columns.map(name => `${alias}.${quote(name)} = k.${quote(name)}`).join(' AND ');
const placeOf = (row: Row): string => JSON.stringify([row.person_id ?? null, row.department_id ?? null, row.team_id ?? null]);
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

/* Writes one unit at a time as this side takes it: each under its own savepoint, with the rules of its table on a row
   it writes, and the check of what a written row points at. A merge writes its units with it, and so does a pick of a
   conflict later. */
export class UnitWriter {
  /* The turns open here when a pass begins, each by its department, and the source's turns that are added closed because
     their department has one open here, each with that one: a department runs one turn at a time. */
  private openTurns = new Map<string, string>();
  private closing = new Map<string, string>();
  /* The jobs a node said something of while their rows were away, each with the node it runs on: these stay running. */
  private running = new Map<string, ParkedNode>();
  /* The jobs this pass added closed that the source held open: what a node says of one meanwhile opens it again. */
  readonly closedJobs = new Set<string>();

  constructor(
    readonly q: Query,
    readonly facts: Facts,
    private readonly opts: { now: string; label: string; afterRestore: boolean; whole?: (t: TableFacts, key: Record<string, unknown>) => Promise<Row | null>; mask?: Mask | null; store?: StoreBytes },
  ) {}

  /* A file of a source from before the store comes with its bytes, from the source while it is there: the row as it is
     written, its text masked as any, carries them until they go into this side's store. */
  private async withOldBytes(t: TableFacts, unit: Unit, row: Row): Promise<void> {
    if (t.name !== 'attachments' || row.sha256 != null) {
      delete row.bytes;
      return;
    }
    if (typeof row.bytes !== 'string') row.bytes = (await this.opts.whole?.(t, unit.key))?.bytes ?? null;
  }

  /* Those bytes go into this side's store, and the row names them by their hash, which the merge's records keep as a
     column it wrote its own way. A row with no byte, an empty file or a big one on a machine's disk, stays as it came.
     False when there is no store to keep them in: such a row is not written. */
  private async storedOldBytes(t: TableFacts, unit: Unit, row: Row): Promise<boolean> {
    if (t.name !== 'attachments') return true;
    const hex = row.bytes;
    delete row.bytes;
    if (typeof hex !== 'string' || !hex.startsWith('\\x') || hex.length <= 2) return true;
    if (!this.opts.store) return false;
    row.sha256 = await this.opts.store(Buffer.from(hex.slice(2), 'hex'));
    unit.rewritten = { cols: [...new Set([...(unit.rewritten?.cols ?? []), 'sha256'])], was: { ...unit.rewritten?.was, sha256: null } };
    return true;
  }

  /* A file is read as its hash; a row that is written needs its bytes, from the source while it is there. False when
     they cannot be had: such a row is not written. */
  private async withFiles(t: TableFacts, unit: Unit, row: Row, columns: string[]): Promise<boolean> {
    const files = columns.filter(name => typeOf(t, name) === 'bytea' && typeof row[name] === 'string' && (row[name] as string).startsWith(FILE_HASH));
    if (files.length === 0) return true;
    const whole = await this.opts.whole?.(t, unit.key);
    if (!whole) return false;
    for (const name of files) row[name] = whole[name];
    return true;
  }

  /* A value the company hid never lands from a source's row: its prose as the fingerprints leave it. set: the columns an
     update writes, which a text file's size joins when its bytes change. */
  private masked(t: TableFacts, row: Row, set?: string[]): void {
    const now = this.opts.mask ? maskRow(t, row, this.opts.mask) : null;
    for (const [name, value] of Object.entries(now ?? {})) {
      if (set && !set.includes(name) && !(name === 'size' && set.includes('bytes'))) continue;
      row[name] = value;
      if (set && !set.includes(name)) set.push(name);
    }
  }

  /* Before a pass over these units: what is open here now. running: the jobs that are left running, with their nodes. */
  async begin(writes: Unit[], running: Map<string, ParkedNode> = new Map()): Promise<void> {
    this.running = running;
    this.closedJobs.clear();
    const open = await this.q<{ id: string; department: string | null }>("SELECT id, department_id::text AS department FROM public.turns WHERE status = 'open'");
    this.openTurns = new Map(open.map(turn => [String(turn.department), turn.id]));
    const opened = writes.filter(unit => unit.table === 'turns' && unit.op === 'insert' && !unit.refused && unit.x!.status === 'open' && this.openTurns.has(String(unit.x!.department_id)));
    this.closing = new Map(opened.map(unit => [String(unit.x!.id), this.openTurns.get(String(unit.x!.department_id))!]));
  }

  /* Why a row the source left running did not end here. */
  private ranWhere(): string {
    return this.opts.afterRestore ? 'Ran before the restore; how it ended was not kept.' : `Ran on ${this.opts.label} while it was cut off.`;
  }

  async attempt(unit: Unit): Promise<void> {
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
      put('closed_at', this.opts.now);
    }
    if (t.name === 'tasks' && row.turn_id && this.closing.has(String(row.turn_id)) && !ENDED_TASKS.includes(String(row.status))) put('turn_id', this.closing.get(String(row.turn_id)));
    if (t.name === 'agents' && !row.removed_at && (row.kind === 'head' || row.kind === 'orchestrator')) {
      const where = row.kind === 'head' ? 'department_id = $1::uuid' : 'company_id = $1::uuid';
      const [live] = await q(`SELECT 1 AS found FROM public.agents WHERE kind = $2 AND removed_at IS NULL AND id <> $3::uuid AND ${where} LIMIT 1`, [row.kind === 'head' ? row.department_id : row.company_id, row.kind, row.id]);
      if (live) put('kind', 'worker');
    }
    /* A job a node still runs, as it told this side while the job's row was away, is added running on that node: what
       the node said of it since is applied once the row is here. */
    const openJob = t.name === 'jobs' && (row.status === 'queued' || row.status === 'running');
    const said = openJob ? this.running.get(String(row.id)) : undefined;
    /* The source knew where it sent the job: only that node's word keeps it open, and a job it sent nowhere yet is
       the node's that says it runs it. */
    const placed = row.node_id !== null && row.node_id !== undefined ? row.node_id === (said?.kind === 'node' ? said.nodeId : null)
      : row.builtin_machine !== null && row.builtin_machine !== undefined ? row.builtin_machine === (said?.kind === 'builtin' ? said.machine : null) : true;
    const runs = said && placed ? said : undefined;
    if (runs) {
      if (row.status !== 'running') put('status', 'running');
      if (row.started_at === null || row.started_at === undefined) put('started_at', this.opts.now);
      if (runs.kind === 'node' && row.node_id !== runs.nodeId) put('node_id', runs.nodeId);
      if (runs.kind === 'builtin' && row.builtin_machine !== runs.machine) put('builtin_machine', runs.machine);
    } else if (openJob) this.closedJobs.add(String(row.id));
    for (const closing of runs ? [] : (CLOSING[t.name] ?? [])) {
      if (!closing.open.includes((row[closing.column] ?? null) as string | null)) continue;
      put(closing.column, closing.to);
      put(closing.at, this.opts.now);
      if (closing.error) put(closing.error, this.ranWhere());
      for (const [column, value] of Object.entries(closing.also ?? {})) put(column, value);
      break;
    }
    if (t.name === 'machines' && row.computer_closed === undefined) put('computer_closed', false);
    for (const column of rule.hereOnly ?? []) {
      /* A machine first seen here keeps the owner's switch that came with it. */
      if (t.name === 'machines' && column === 'computer_closed') continue;
      if (row[column] !== null && row[column] !== undefined) put(column, null);
    }
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
    if (!(await this.withFiles(t, unit, row, t.columns.map(column => column.name)))) return void (unit.refused = NO_FILE);
    await this.withOldBytes(t, unit, row);
    this.masked(t, row);
    if (!(await this.storedOldBytes(t, unit, row))) return void (unit.refused = NO_FILE);
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
        row[closing.at] = this.opts.now;
        if (closing.error) row[closing.error] = this.ranWhere();
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
    if (!(await this.withFiles(t, unit, row, set))) return void (unit.refused = NO_FILE);
    this.masked(t, row, set);
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

  async pointedAt(t: TableFacts, y: Row): Promise<boolean> {
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
  async references(writes: Unit[]): Promise<number> {
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

  /* What hangs on a refused row is refused with it, found here without asking the database: a unit whose row points at
     a row a refused unit would have added, and on from there. How many it refused. */
  spread(writes: Unit[]): number {
    let refused = 0;
    const text = (values: unknown[]): string => JSON.stringify(values.map(value => (value === null || value === undefined ? null : String(value))));
    for (let grew = true; grew; ) {
      grew = false;
      const gone = new Map<string, Set<string>>();
      const lostOf = (table: string, columns: string[]): Set<string> => {
        const sign = `${table}|${columns.join(',')}`;
        let found = gone.get(sign);
        if (!found) gone.set(sign, (found = new Set(writes.filter(unit => unit.refused && unit.op === 'insert' && unit.table === table && unit.x).map(unit => text(columns.map(column => unit.x![column]))))));
        return found;
      };
      for (const unit of writes) {
        const row = unit.written;
        if (unit.refused || !row) continue;
        const t = this.facts.tables.get(unit.table)!;
        const fk = t.fks.find(one => (unit.op === 'insert' || one.columns.some(column => unit.set.includes(column))) && lostOf(one.parent, one.parentColumns).has(text(one.columns.map(column => row[column]))));
        const soft = fk ? undefined : SOFT_REFS.find(ref => {
          if (ref.table !== unit.table || !(unit.op === 'insert' || unit.set.includes(ref.column)) || (ref.when && row[ref.when.column] !== ref.when.value)) return false;
          const value = row[ref.column];
          const ids = ref.list ? (Array.isArray(value) ? value : []) : value === null || value === undefined ? [] : [value];
          return ids.some(id => lostOf(ref.parent, ['id']).has(text([id])));
        });
        if (!fk && !soft) continue;
        unit.refused = `Its ${fk?.parent ?? soft!.parent} row is not here.`;
        refused += 1;
        grew = true;
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
}

/* The merge of one source, inside its transaction. */
class Merge {
  readonly units: Unit[] = [];
  private readonly counts: Counts = { added: 0, changed: 0, deleted: 0, equal: 0, skipped: 0, conflicts: 0, carried: 0, matched: 0, rewritten: 0, passes: 0, byTable: {} };
  /* Journal rows nothing is done with: of tables that are never merged, and of keys that came out equal. */
  private readonly quiet: JournalRow[] = [];
  private path: Path = 'compare';
  private cutoff: Date | null = null;
  private facts!: Facts;
  /* The company's hidden values, by their fingerprints, here and from the source: what no row of the source brings back. */
  private secrets: Mask | null = null;
  private proving: JournalRow[] = [];
  private asked = 0;
  private now = '';
  /* When the restore that set this source aside left its mark here, and what this side removed since, table by table. */
  private restoredAt: string | Date | null = null;
  private readonly removed = new Map<string, { keys: Set<string>; places: Set<string>; here: Set<string> }>();
  /* By table and key: the columns earlier merges wrote their own way here, with what their source held in them. */
  private readonly rewrote = new Map<string, Map<string, { cols: string[]; was: Row }[]>>();

  constructor(
    private readonly q: Query,
    private readonly src: MergeReader,
    private readonly merge: { id: string; label: string; kept: boolean; companyId: string },
    private readonly onUnit?: (n: number) => void | Promise<void>,
    private readonly store?: StoreBytes,
  ) {}

  async run(): Promise<Omit<MergeResult, 'heldMs'>> {
    const { q, src, merge } = this;
    /* Nothing of the app may end this transaction, and no session outside the gate may write what it reads: the table
       locks are taken before the leader's rows are read, while every network read of a peer source was finished ahead. */
    await q("SET LOCAL lock_timeout = '10s'");
    await q('SET LOCAL statement_timeout = 0');
    await q('SET LOCAL transaction_timeout = 0');
    await q(`LOCK TABLE ${Object.keys(TABLE_RULES).filter(name => TABLE_RULES[name]!.kind !== 'skip').map(name => `public.${quote(name)}`).join(', ')} IN EXCLUSIVE MODE`);
    await q('SET CONSTRAINTS ALL DEFERRED');
    const [row] = await q<{ status: string; source: string; now: string }>('SELECT status, source, to_jsonb(now()) #>> \'{}\' AS now FROM net.merges WHERE id = $1::uuid FOR UPDATE', [merge.id]);
    if (row?.status !== 'pending') throw new MergeRefused('The merge was applied already.');
    this.now = row.now;
    if (row.source.startsWith('kept:')) this.restoredAt = (await q<{ at: string | Date }>('SELECT at FROM net.restores WHERE kept = $1 ORDER BY at DESC LIMIT 1', [row.source.slice(5)]))[0]?.at ?? null;
    this.facts = await factsOf(q);
    const shape = sameShape(this.facts, await src.facts());
    if (shape) throw new MergeRefused(shape);
    for (const name of this.facts.tables.keys()) ruleOf(name);
    if ((await src.companyId()) !== merge.companyId) throw new MergeRefused(ANOTHER_COMPANY);

    await this.plan();
    const brought = await this.hidden();
    await this.write();
    const carried = await this.carry();
    await this.backups();
    /* A value hidden there and new here is looked for once in this side's own rows of the company, in this transaction. */
    const fresh = fingerprintMask(brought);
    if (fresh) await maskCompanyRows(q, this.facts, merge.companyId, fresh);
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

  /* The fingerprints of the company here, and those the source brings that are new here, which this returns. */
  private async hidden(): Promise<Fingerprint[]> {
    const here = await this.q<Fingerprint>('SELECT fingerprint, characters, window_hash FROM public.secret_redactions WHERE company_id = $1::uuid', [this.merge.companyId]);
    const known = new Set(here.map(found => found.fingerprint));
    const brought = this.units
      .filter(unit => unit.table === 'secret_redactions' && unit.op === 'insert' && unit.x?.company_id === this.merge.companyId && !known.has(String(unit.x.fingerprint)))
      .map(unit => unit.x as unknown as Fingerprint);
    this.secrets = fingerprintMask([...here, ...brought]);
    return brought;
  }

  /* A row's image in what the merge keeps, as the fingerprints leave its prose. */
  private scrubbed(table: unknown, image: unknown): unknown {
    const t = this.facts.tables.get(String(table));
    if (!this.secrets || !t || !image || typeof image !== 'object') return image;
    const now = maskRow(t, image as Row, this.secrets);
    return now ? { ...(image as Row), ...Object.fromEntries(Object.entries(now).filter(([name]) => name in (image as Row))) } : image;
  }

  /* Which way, and one unit for every row the source has something to say of. */
  private async plan(): Promise<void> {
    const { q, src, merge } = this;
    let histories = new Map<string, Map<string, KeyHistory>>();
    let theirs = new Map<string, Map<string, Theirs>>();
    if (!merge.kept) {
      const leaderHorizon = await horizonOf(q);
      this.cutoff = cutoffOf(await src.horizon(), leaderHorizon);
      const [theirIds, ownIds] = [await src.journalIds(this.cutoff), await journalIds(q, this.cutoff)];
      const lacking = [...theirIds.keys()].filter(id => !ownIds.has(id));
      const parted = divergence(theirIds, ownIds, await consumedIds(q, lacking));
      this.path = pathOf({ kept: false, leaderRestores: await restoresOf(q), sourceRestores: await src.restores(), shared: parted.shared });
      if (this.path === 'journal') {
        const a = await src.journalRows(parted.a);
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
    const allRows = [...histories.values()].flatMap(history => [...history.a, ...history.s, ...history.old]);
    const xs = await this.src.rowsForJournal(t, keys, allRows);
    const here = await this.heres(t, rule, [...xs.values()]);
    const ys = rule.kind === 'log' ? null : await rowsByKeys(this.q, t, keys);
    const pairs = keys.map(key => ({ key, text: keyText(key), x: xs.get(keyText(key)) ?? null }));
    const both = pairs.map(pair => ({ ...pair, y: pair.x ? here(pair.x) : (ys?.get(pair.text) ?? null) }));
    if (t.name === 'map_returns') await withNamedKeys(this.q, both.map(pair => pair.y));
    for (const { key, text, x, y } of both) {
      const mine = histories.get(text)!;
      const outcome = addsOnly(rule, journalOutcome(t, x, y, mine, rule.kind === 'log' ? undefined : theirs?.get(text)));
      const alone = mine.a.length === 0 && mine.old.length === 0;
      const left = alone && x !== null && (y === null || (rule.kind === 'rows' && differing(t, x, y).length > 0));
      this.unit(t, rule, { key, x, y, outcome, rows: [...mine.a, ...mine.old], skipped: mine.s, left });
    }
  }

  private async compare(t: TableFacts, rule: TableRule): Promise<void> {
    for await (const page of this.src.pagesOf(t)) {
      const here = await this.heres(t, rule, page);
      const ys = page.map(x => here(x));
      if (t.name === 'map_returns') await withNamedKeys(this.q, ys);
      for (const [index, x] of page.entries()) {
        let outcome = addsOnly(rule, compareOutcome(t, x, ys[index]!));
        /* A difference this side made itself is nothing to settle: an earlier merge took this very row from another
           database that held it the same, as a copy and the database it followed do, and wrote these columns its own
           way, as when it ended a turn nobody ran any more. */
        if (outcome.do === 'conflict' && outcome.kind === 'differs' && (await this.ownDoing(t, x, outcome.cols))) outcome = { do: 'equal' };
        /* A row the company removed since the restore is not brought back behind its back: it is listed. */
        if (outcome.do === 'add' && rule.kind === 'rows' && (await this.removedSince(t, x))) outcome = { do: 'conflict', kind: 'changed_removed', cols: [] };
        if (outcome.do === 'equal') this.counts.equal += 1;
        else this.unit(t, rule, { key: keyOf(t, x), x, y: ys[index]!, outcome, rows: [], skipped: [], left: false });
      }
    }
  }

  /* Whether every column the source's row differs in is one an earlier merge wrote its own way on this side, from a
     row that held there what this one holds. */
  private async ownDoing(t: TableFacts, x: Row, cols: string[]): Promise<boolean> {
    let known = this.rewrote.get(t.name);
    if (!known) {
      known = new Map();
      const rows = await this.q<{ key: Record<string, unknown>; cols: string[]; was: Row | null }>(
        "SELECT key, cols, was FROM net.merge_rows WHERE tbl = $1 AND how = 'rewritten' AND was IS NOT NULL AND merge <> $2::uuid", [t.name, this.merge.id]);
      for (const row of rows) known.set(keyText(row.key), [...(known.get(keyText(row.key)) ?? []), { cols: row.cols, was: row.was! }]);
      this.rewrote.set(t.name, known);
    }
    return (known.get(keyText(keyOf(t, x))) ?? []).some(before => cols.every(column => before.cols.includes(column)) && heldAs(t, x, cols, before.was));
  }

  /* Whether this side removed the row since the restore that set the source aside, as its own journal says. A place of
     a person is told by the place, whatever id its row had: the restore's carry writes those rows anew, and a place
     that is here now was not removed. */
  private async removedSince(t: TableFacts, x: Row): Promise<boolean> {
    if (!this.restoredAt) return false;
    let removed = this.removed.get(t.name);
    if (!removed) {
      const gone = await this.q<{ key: Record<string, unknown>; old: Row | null }>("SELECT key, old FROM net.journal WHERE tbl = $1 AND op = 'delete' AND at > $2::timestamptz", [t.name, this.restoredAt]);
      const here = t.name === 'person_access' ? await this.q<Row>('SELECT person_id, department_id, team_id FROM public.person_access') : [];
      removed = { keys: new Set(gone.map(row => keyText(row.key))), places: new Set(gone.flatMap(row => (row.old ? [placeOf(row.old)] : []))), here: new Set(here.map(placeOf)) };
      this.removed.set(t.name, removed);
    }
    if (removed.keys.has(keyText(keyOf(t, x)))) return true;
    return t.name === 'person_access' && removed.places.has(placeOf(x)) && !removed.here.has(placeOf(x));
  }

  private unit(t: TableFacts, rule: TableRule, planned: { key: Record<string, unknown>; x: Row | null; y: Row | null; outcome: Outcome; rows: JournalRow[]; skipped: JournalRow[]; left: boolean }): void {
    const { outcome } = planned;
    const unit: Unit = { table: t.name, key: planned.key, op: null, x: planned.x, y: planned.y, set: [], listed: null, rows: planned.rows, skipped: planned.skipped, left: planned.left, refused: null, done: null, written: null, rewritten: null, matched: null };
    if (outcome.do === 'add') unit.op = 'insert';
    else if (outcome.do === 'delete') unit.op = 'delete';
    else if (outcome.do === 'change') {
      /* What only this side settles is never taken, whatever the journal proves of it. */
      const own = new Set(rule.hereOnly ?? []);
      /* A turn both sides hold open is one run on one node, which reports to this side from now: this side's row is
         the one that goes on, and what the two wrote of it apart, as when it started, is nothing for anyone to settle.
         What the source alone wrote of it is left out where a row is written, as for any row this side holds open. */
      const open = (row: Row | null): boolean => row?.status === 'queued' || row?.status === 'running';
      const sameRun = t.name === 'jobs' && open(planned.x) && open(planned.y);
      unit.set = outcome.set.filter(column => !own.has(column));
      const listed = sameRun ? [] : [...outcome.conflict, ...outcome.set.filter(column => own.has(column))];
      if (unit.set.length > 0) unit.op = 'update';
      if (listed.length > 0) unit.listed = { kind: 'differs', cols: listed, there: planned.x };
      if (sameRun && unit.set.length === 0) this.counts.equal += 1;
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
    const writer = new UnitWriter(q, this.facts, {
      now: this.now, label: this.merge.label, afterRestore: this.merge.kept || this.path === 'compare',
      whole: (t, key) => this.src.wholeOf(t, key),
      mask: this.secrets,
      store: this.store,
    });
    /* What nodes said of jobs whose rows were away, on either side. */
    const running = parkedNodes([...(await parkedOf(q)), ...(await this.src.parked())]);
    await q(`SAVEPOINT ${UNITS}`);
    for (let pass = 0; ; pass += 1) {
      if (pass > 0) await q(`ROLLBACK TO SAVEPOINT ${UNITS}`);
      for (const unit of this.units) Object.assign(unit, { done: null, written: null, rewritten: null, matched: null });
      await writer.begin(writes, running);
      for (const unit of [...writes, ...deletes]) {
        if (pass === 0) await this.onUnit?.((this.asked += 1));
        if (!unit.refused) await writer.attempt(unit);
      }
      this.counts.passes = pass + 1;
      if ((await writer.references(writes)) === 0) {
        await this.reopen(writer.closedJobs, running);
        break;
      }
      writer.spread(writes);
    }
    await q(`RELEASE SAVEPOINT ${UNITS}`);
  }

  /* A node may have told the leader of a job while this merge ran, after what was kept was read: the job was added
     closed, and its node runs it on. From here to the commit nothing more is kept, so what was kept meanwhile is read
     once more, and such a job is opened again on its node; whatever a node says after the commit finds the job's row.
     known: what was kept when the merge began. */
  private async reopen(closed: Set<string>, known: Map<string, ParkedNode>): Promise<void> {
    if (closed.size === 0) return;
    await this.q('LOCK TABLE net.parked IN SHARE ROW EXCLUSIVE MODE');
    const now = parkedNodes(await parkedOf(this.q));
    for (const id of closed) {
      const node = now.get(id);
      if (!node || known.has(id)) continue;
      await this.q(
        `UPDATE public.jobs j SET status = 'running', finished_at = NULL, error = NULL, started_at = COALESCE(j.started_at, $2::timestamptz),
           node_id = CASE WHEN $3::text = 'node' AND j.node_id IS NULL AND j.builtin_machine IS NULL THEN $4::uuid ELSE j.node_id END,
           builtin_machine = CASE WHEN $3::text = 'builtin' AND j.node_id IS NULL AND j.builtin_machine IS NULL THEN $5::text ELSE j.builtin_machine END
          WHERE j.id = $1::uuid AND j.status = 'failed'
            AND (j.node_id IS NULL OR ($3::text = 'node' AND j.node_id = $4::uuid))
            AND (j.builtin_machine IS NULL OR ($3::text = 'builtin' AND j.builtin_machine = $5::text))`,
        [id, this.now, node.kind, node.kind === 'node' ? node.nodeId : null, node.kind === 'builtin' ? node.machine : null],
      );
    }
  }

  /* The conflicts an earlier merge left open in the source: each may hold the only copy of a value the company wrote. */
  private async carry(): Promise<Row[]> {
    const carried: Row[] = [];
    for (const theirs of await this.src.conflicts()) {
      const first = theirs.carried ?? theirs.id;
      const [held] = await this.q('SELECT 1 AS found FROM net.merge_conflicts WHERE id = $1::uuid OR carried = $1::uuid LIMIT 1', [first]);
      if (!held) carried.push({ ...theirs, carried: first });
    }
    return carried;
  }

  /* A restore of an older bundle then lists, and can check, the bundles made after it, and knows of each planned
     switch written down after it. A switch between machines this database does not hold stays where it was. What
     nodes told the source of jobs it had no row of comes too, applied or not as the source left it. */
  private async backups(): Promise<void> {
    for (const parked of await this.src.parked()) {
      if (this.secrets) parked.body = maskJson(parked.body, this.secrets);
      await this.q('INSERT INTO net.parked SELECT * FROM jsonb_populate_record(NULL::net.parked, $1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(parked)]);
    }
    for (const backup of await this.src.backups()) {
      await this.q('INSERT INTO net.backups SELECT * FROM jsonb_populate_record(NULL::net.backups, $1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(backup)]);
    }
    for (const handover of await this.src.handovers()) {
      await this.q(
        `INSERT INTO net.handovers SELECT h.* FROM jsonb_populate_record(NULL::net.handovers, $1::jsonb) h
          WHERE EXISTS (SELECT 1 FROM public.machines m WHERE m.id = h.from_machine_id) AND EXISTS (SELECT 1 FROM public.machines m WHERE m.id = h.to_machine_id)
         ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(handover)],
      );
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

  /* The source's row of a refused unit with the bytes of its file, so that taking it later, when the source is gone,
     still has them. */
  private async withFile(unit: Unit): Promise<Row | null> {
    const t = this.facts.tables.get(unit.table)!;
    const x = unit.x;
    const files = x ? t.columns.filter(column => column.type === 'bytea' && typeof x[column.name] === 'string' && (x[column.name] as string).startsWith(FILE_HASH)).map(column => column.name) : [];
    if (!x || files.length === 0) return x;
    const whole = await this.src.wholeOf(t, unit.key);
    return whole ? { ...x, ...Object.fromEntries(files.map(name => [name, whole[name]])) } : x;
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
      /* What a row lists beside what it takes, in words. */
      const differs = (): string => {
        const { cols, there } = unit.listed!;
        const shown = unit.y && there ? (cols.length > 0 ? cols : differing(this.facts.tables.get(unit.table)!, there, unit.y)) : [];
        return shown.map(column => `${column}: here ${valueWords(unit.table, column, unit.y![column])}, there ${valueWords(unit.table, column, there![column])}`).join('; ');
      };
      if (unit.refused) {
        /* One conflict for a row: what it would have taken and what it lists besides are settled together. */
        const also = unit.listed?.kind === 'differs' ? unit.listed : null;
        listed(unit, { op: unit.op!, kind: 'refused', cols: unit.op === 'update' ? [...unit.set, ...(also?.cols ?? [])] : [], there: await this.withFile(unit), why: this.why(unit, also ? `${unit.refused} ${differs()}` : unit.refused) });
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
      if (unit.listed && !unit.refused) {
        const { kind, cols, there } = unit.listed;
        const words = kind === 'differs' ? differs() : kind === 'changed_removed' ? 'changed there, and not here any more.' : 'removed there, and changed here.';
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
      Object.assign(row, { here: this.scrubbed(row.tbl, row.here), there: this.scrubbed(row.tbl, row.there), why: typeof row.why === 'string' && this.secrets ? this.secrets(row.why) : row.why });
      await q(
        `INSERT INTO net.merge_conflicts (merge, carried, tbl, key, op, kind, topic, task_id, cols, here, there, at, why)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7, $8::uuid, ARRAY(SELECT jsonb_array_elements_text($9::jsonb)), $10::jsonb, $11::jsonb, $12::timestamptz, $13)`,
        [row.merge, row.carried, row.tbl, JSON.stringify(row.key), row.op, row.kind, row.topic, row.task_id, JSON.stringify(row.cols), row.here ? JSON.stringify(row.here) : null, row.there ? JSON.stringify(row.there) : null, row.at, row.why],
      );
    }
    for (const row of kept) {
      Object.assign(row, { was: this.scrubbed(row.tbl, row.was), here: this.scrubbed(row.tbl, row.here) });
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

  /* The touched tasks that have a repository and that the source's turns worked on: where that work lies. */
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
      const line = await this.src.codeFor(id);
      if (line) lines.push(line);
    }
    return lines;
  }

  /* From when to when the source went its own way: by the journal the first and the last change that proves; after a
     restore from the restored bundle's time to the kept database's last change. */
  private async span(source: string): Promise<[Date | null, Date | null]> {
    if (this.path === 'journal') return [this.proving[0]?.at ?? null, this.proving.at(-1)?.at ?? null];
    const [restore] = source.startsWith('kept:') ? await this.q<{ at: string | Date }>('SELECT dumped_at AS at FROM net.restores WHERE kept = $1 ORDER BY at DESC LIMIT 1', [source.slice(5)]) : [];
    return [restore ? new Date(restore.at) : null, await this.src.lastChange()];
  }
}

const refuseMerge = (reason: string): never => {
  throw new MergeRefused(reason);
};

/* The store of this side, where the bytes of a file from a source of before the store go; without it, such a file is
   refused. */
export type MergeFiles = Pick<Files, 'putBytes'>;
type StoreBytes = (bytes: Buffer) => Promise<string>;
type RunOptions = { onUnit?: (n: number) => void | Promise<void>; gateWaitMs?: number; clock?: () => number; files?: MergeFiles };

async function runPreparedMerge(
  db: Db,
  merge: { id: string; label: string; kept: boolean; companyId: string },
  prepared: MergeReader,
  opts: RunOptions,
): Promise<MergeResult> {
  let heldMs = 0;
  /* The time the writes are held is counted on the clock given, which tests move; the real one by default. */
  const now = opts.clock ?? Date.now;
  const done = await writeGate.exclusive(async () => {
    const began = now();
    try {
      /* Read committed so the deferred fence trigger at commit sees live lease renewals (and any fence) committed while this merge ran. */
      return await db.transaction(tx => {
        const store = opts.files ? async (bytes: Buffer) => (await opts.files!.putBytes(tx, bytes)).sha256 : undefined;
        return new Merge(queryOf(tx as unknown as Db), prepared, merge, opts.onUnit, store).run();
      });
    } catch (err) {
      /* A session outside the gate held a table for longer than the merge waits: nothing was changed, and it is tried
         again later. */
      if (codeOf(err) === LOCK_NOT_TAKEN) throw new Error('Another session held a table the merge must lock, for longer than 10 s.');
      throw err;
    } finally {
      heldMs = now() - began;
    }
  }, opts.gateWaitMs ?? GATE_WAIT_MS);
  return { ...done, heldMs };
}

async function runPeerMerge(
  db: Db,
  merge: { id: string; label: string; kept: boolean; companyId: string },
  source: MergeSource,
  opts: RunOptions,
): Promise<MergeResult> {
  const request: SourceRequest = { compare: false, files: new Map() };
  for (let attempt = 0; ; attempt += 1) {
    const prepared = await prepareSource(queryOf(db), source.query, merge, request, withNamedKeys, ANOTHER_COMPANY, refuseMerge);
    try {
      return await runPreparedMerge(db, merge, prepared, opts);
    } catch (err) {
      if (!(err instanceof NeedMoreFromSource) || attempt >= 3 || !noteMoreNeeded(request, prepared, err)) throw err;
    }
  }
}

/* Peer merges pre-read their remote source outside the write gate and outside any leader transaction; kept and uploaded
   databases sit in the leader's own Postgres and stream 500-row pages inside the read-committed transaction without
   holding equal rows in memory. Neither writes the source, and a failed merge changes nothing. */
export async function runMerge(
  db: Db,
  merge: { id: string; label: string; kept: boolean; companyId: string },
  source: MergeSource,
  opts: RunOptions & { log?: (line: string) => void } = {},
): Promise<MergeResult> {
  const [target] = await queryOf(db)<{ status: string; source: string }>('SELECT status, source FROM net.merges WHERE id = $1::uuid', [merge.id]);
  if (target?.status !== 'pending') throw new MergeRefused('The merge was applied already.');
  const result = target.source.startsWith('machine:')
    ? await runPeerMerge(db, merge, source, opts)
    : await runPreparedMerge(db, merge, liveMergeReader(source.query, withNamedKeys), opts);
  /* No value of a row goes into a log line. */
  (opts.log ?? console.info)(`The merge ${merge.id} held the app's writes ${result.heldMs} ms.`);
  return result;
}
