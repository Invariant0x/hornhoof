import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TableFacts } from '../src/modules/merge/facts.js';
import {
  compareOutcome, cutoffOf, differing, divergence, historiesOf, journalOutcome, listedIn, pathOf, same, skippedXacts, theirsOf, type KeyHistory, type Theirs,
} from '../src/modules/merge/plan.js';
import { HORIZON_MARGIN_MS, keyText, type JournalRow, type Row } from '../src/modules/merge/read.js';

const table = (name: string, columns: Record<string, string>, key = ['id']): TableFacts => ({
  name, key, fks: [], referencedBy: [], columns: Object.entries(columns).map(([column, type]) => ({ name: column, type, nullable: !key.includes(column) })),
});
const TASKS = table('tasks', { id: 'uuid', number: 'integer', title: 'text', status: 'text', body: 'text', version: 'integer', updated_at: 'timestamp with time zone' });
const MACHINES = table('machines', { id: 'uuid', hostname: 'text', report_at: 'timestamp with time zone', disk_free: 'bigint', addresses: 'text[]' });
const CERTIFICATES = table('certificates', { serial: 'text', machine_id: 'uuid', revoked_at: 'timestamp with time zone' }, ['serial']);
const PLACES = table('person_access', { person_id: 'uuid', department_id: 'uuid', note: 'text' }, ['person_id', 'department_id']);

const ID = randomUUID();
const KEY = { id: ID };
const task = (over: Row = {}): Row => ({ id: ID, number: 1, title: 'T0', status: 'todo', body: 'B0', version: 1, updated_at: '2026-11-03T14:00:00+00:00', ...over });
const COLS = Object.keys(task());

let tick = 0;
/* A journal row, each a moment after the one before. */
function row(over: Partial<JournalRow> & Pick<JournalRow, 'op'>): JournalRow {
  tick += 1;
  return { id: randomUUID(), xact: randomUUID(), at: new Date(Date.UTC(2026, 10, 3, 14, 0, tick)), tbl: 'tasks', key: KEY, cols: [], old: null, ...over };
}
const inserted = (): JournalRow => row({ op: 'insert', cols: COLS });
const changed = (old: Row): JournalRow => row({ op: 'update', cols: Object.keys(old), old });
const deleted = (old: Row = task()): JournalRow => row({ op: 'delete', cols: COLS, old });
const history = (a: JournalRow[], s: JournalRow[] = [], old: JournalRow[] = []): KeyHistory => ({ a, s, old });
const theirs = (over: Partial<{ insert: boolean; delete: boolean; cols: string[] }> = {}): Theirs => ({ insert: over.insert ?? false, delete: over.delete ?? false, cols: new Set(over.cols ?? []) });

describe('the plan of a merge', () => {
  it('chooses the way', () => {
    const shared = { leaderRestores: [], sourceRestores: [], shared: 12 };
    expect(pathOf({ ...shared, kept: false })).toBe('journal');
    expect(pathOf({ ...shared, kept: true })).toBe('compare');
    /* A restore the leader went through and the source did not: its journal proves nothing of the restored rows. */
    expect(pathOf({ kept: false, leaderRestores: ['r1', 'r2'], sourceRestores: ['r1'], shared: 12 })).toBe('compare');
    expect(pathOf({ kept: false, leaderRestores: ['r1'], sourceRestores: ['r1', 'r0'], shared: 12 })).toBe('journal');
    expect(pathOf({ ...shared, kept: false, shared: 0 })).toBe('compare');
  });

  it('finds where the two parted', () => {
    const [early, late] = [new Date('2026-11-01T00:00:00Z'), new Date('2026-11-02T00:00:00Z')];
    expect(cutoffOf(null, null)).toBeNull();
    expect(cutoffOf(early, null)!.getTime()).toBe(early.getTime() - HORIZON_MARGIN_MS);
    expect(cutoffOf(early, late)!.getTime()).toBe(late.getTime() - HORIZON_MARGIN_MS);
    expect(cutoffOf(late, early)!.getTime()).toBe(late.getTime() - HORIZON_MARGIN_MS);
    const at = new Date();
    const ids = (...names: string[]) => new Map(names.map(name => [name, at]));
    expect(divergence(ids('both', 'theirs', 'taken'), ids('both', 'mine'), new Set(['taken']))).toEqual({ a: ['theirs'], b: ['mine'], shared: 1 });
  });

  it('skips what the leader already did', () => {
    const [fromNode, fromTool, own] = [randomUUID(), randomUUID(), randomUUID()];
    const call = randomUUID();
    const a = [
      row({ op: 'update', xact: fromNode, cols: ['title'], old: { title: 'T0' } }),
      row({ op: 'insert', xact: fromNode, tbl: 'applied', key: { source: 'node:n1:jobs:7:0' }, cols: ['source', 'at', 'base'] }),
      row({ op: 'update', xact: fromTool, cols: ['status'], old: { status: 'todo' } }),
      row({ op: 'insert', xact: fromTool, tbl: 'tool_calls', key: { id: call }, cols: ['id', 'job_id', 'answer', 'at'] }),
      row({ op: 'update', xact: own, cols: ['body'], old: { body: 'B0' } }),
      row({ op: 'insert', xact: own, tbl: 'applied', key: { source: 'web:w1:0' }, cols: ['source', 'at', 'base'] }),
    ];
    /* What the leader is asked about: every source and call the rows name. */
    expect(listedIn(a)).toEqual({ sources: ['node:n1:jobs:7:0', 'web:w1:0'], calls: [call] });
    const skipped = skippedXacts(a, { sources: new Set(['node:n1:jobs:7:0']), calls: new Set([call]) });
    expect(skipped).toEqual(new Set([fromNode, fromTool]));
    /* A row older than what the leader's own journal still holds proves nothing either. */
    const old = row({ op: 'update', xact: randomUUID(), at: new Date('2026-10-01T00:00:00Z'), cols: ['number'], old: { number: 0 } });
    const of = historiesOf([old, ...a], skipped, new Date('2026-10-20T00:00:00Z')).get('tasks')!.get(keyText(KEY))!;
    expect(of.a.map(found => found.cols)).toEqual([['body']]);
    expect(of.s.map(found => found.cols)).toEqual([['title'], ['status']]);
    expect(of.old.map(found => found.cols)).toEqual([['number']]);
    expect(historiesOf(a, skipped, null).get('applied')!.size).toBe(2);
  });

  it('says what the leader did to each key', () => {
    const other = { id: randomUUID() };
    const b = [inserted(), changed({ title: 'T0' }), changed({ status: 'todo' }), { ...deleted(), key: other }];
    const found = theirsOf(b).get('tasks')!;
    expect(found.get(keyText(KEY))).toEqual({ insert: true, delete: false, cols: new Set(['title', 'status']) });
    expect(found.get(keyText(other))).toEqual({ insert: false, delete: true, cols: new Set() });
  });

  it('applies a column only the source changed, from the value the leader holds', () => {
    expect(journalOutcome(TASKS, task({ title: 'T1' }), task(), history([changed({ title: 'T0' })]))).toEqual({ do: 'change', set: ['title'], conflict: [] });
    /* Changed twice: its base is the value before the first change. */
    expect(journalOutcome(TASKS, task({ title: 'T2' }), task(), history([changed({ title: 'T0' }), changed({ title: 'T1' })]))).toEqual({ do: 'change', set: ['title'], conflict: [] });
    /* Changed and changed back: nothing differs. */
    expect(journalOutcome(TASKS, task(), task(), history([changed({ title: 'T0' }), changed({ title: 'T1' })]))).toEqual({ do: 'equal' });
    /* An update that changed nothing does nothing. */
    expect(journalOutcome(TASKS, task(), task(), history([changed({})]))).toEqual({ do: 'equal' });
  });

  it('lists a column both changed', () => {
    expect(journalOutcome(TASKS, task({ title: 'There' }), task({ title: 'Here' }), history([changed({ title: 'T0' })]), theirs({ cols: ['title'] }))).toEqual({ do: 'change', set: [], conflict: ['title'] });
    /* Both changed it to the same: nothing to settle. */
    expect(journalOutcome(TASKS, task({ title: 'Same' }), task({ title: 'Same' }), history([changed({ title: 'T0' })]), theirs({ cols: ['title'] }))).toEqual({ do: 'equal' });
  });

  it('takes some columns and lists others of one row', () => {
    const x = task({ title: 'There', status: 'done', body: 'B1' });
    const y = task({ title: 'Here' });
    expect(journalOutcome(TASKS, x, y, history([changed({ title: 'T0', status: 'todo' }), changed({ body: 'B0' })]), theirs({ cols: ['title'] }))).toEqual({ do: 'change', set: ['status', 'body'], conflict: ['title'] });
    /* A column no row names is the leader's, whatever it holds. */
    expect(journalOutcome(TASKS, task({ title: 'T1', number: 9 }), task(), history([changed({ title: 'T0' })]))).toEqual({ do: 'change', set: ['title'], conflict: [] });
  });

  it('adds a row only the source has', () => {
    expect(journalOutcome(TASKS, task(), null, history([inserted()]))).toEqual({ do: 'add' });
    expect(journalOutcome(TASKS, task({ title: 'T1' }), null, history([inserted(), changed({ title: 'T0' })]))).toEqual({ do: 'add' });
  });

  it('deletes a row only the source removed, from the row the leader holds', () => {
    expect(journalOutcome(TASKS, null, task(), history([deleted()]))).toEqual({ do: 'delete' });
    /* Changed there before it went: the leader still holds it as it was before that change. */
    expect(journalOutcome(TASKS, null, task(), history([changed({ title: 'T0' }), deleted(task({ title: 'T1' }))]))).toEqual({ do: 'delete' });
    /* The bookkeeping moved on here meanwhile, which is no change. */
    expect(journalOutcome(TASKS, null, task({ version: 4, updated_at: '2026-11-04T10:00:00+00:00' }), history([deleted()]))).toEqual({ do: 'delete' });
    expect(journalOutcome(TASKS, null, null, history([deleted()]))).toEqual({ do: 'equal' });
  });

  it('lists a row removed there and changed here', () => {
    const gone = deleted();
    expect(journalOutcome(TASKS, null, task({ title: 'Here' }), history([gone]), theirs({ cols: ['title'] }))).toEqual({ do: 'conflict', kind: 'removed_changed', cols: [], there: gone.old });
  });

  it('lists a row changed there and removed here', () => {
    expect(journalOutcome(TASKS, task({ title: 'T1' }), null, history([changed({ title: 'T0' })]), theirs({ delete: true }))).toEqual({ do: 'conflict', kind: 'changed_removed', cols: ['title'] });
    /* Added there again after the leader removed it: the leader's removal stands until someone picks. */
    expect(journalOutcome(TASKS, task(), null, history([inserted()]), theirs({ delete: true }))).toEqual({ do: 'conflict', kind: 'changed_removed', cols: [] });
    /* Gone here with nothing in the leader's journal to say why: nothing proves it, so it is listed. */
    expect(journalOutcome(TASKS, task({ title: 'T1' }), null, history([changed({ title: 'T0' })]))).toEqual({ do: 'conflict', kind: 'changed_removed', cols: ['title'] });
  });

  it('leaves a key only the leader touched', () => {
    expect(journalOutcome(TASKS, task(), task({ title: 'Here' }), history([]), theirs({ cols: ['title'] }))).toEqual({ do: 'equal' });
    expect(journalOutcome(TASKS, task(), null, history([]), theirs({ delete: true }))).toEqual({ do: 'equal' });
    /* Or only a skipped transaction: the leader has its own result of that input. */
    expect(journalOutcome(TASKS, task(), null, history([], [inserted()]))).toEqual({ do: 'equal' });
  });

  it('finds nothing in a row added and removed there', () => {
    expect(journalOutcome(TASKS, null, null, history([inserted(), deleted()]))).toEqual({ do: 'equal' });
    /* The leader made a row of that key itself: it is the leader's. */
    const place = { person_id: ID, department_id: ID };
    const at = (op: JournalRow['op'], old: Row | null = null): JournalRow => row({ op, tbl: 'person_access', key: place, cols: ['person_id', 'department_id', 'note'], old });
    expect(journalOutcome(PLACES, null, { ...place, note: 'here' }, history([at('insert'), at('delete', { ...place, note: 'there' })]), theirs({ insert: true }))).toEqual({ do: 'equal' });
  });

  it('lists a natural key both added with other values', () => {
    const place = { person_id: ID, department_id: ID };
    const added = row({ op: 'insert', tbl: 'person_access', key: place, cols: ['person_id', 'department_id', 'note'] });
    expect(journalOutcome(PLACES, { ...place, note: 'there' }, { ...place, note: 'here' }, history([added]), theirs({ insert: true }))).toEqual({ do: 'conflict', kind: 'differs', cols: ['note'] });
    expect(journalOutcome(PLACES, { ...place, note: 'same' }, { ...place, note: 'same' }, history([added]), theirs({ insert: true }))).toEqual({ do: 'equal' });
  });

  it('lists a change whose base the leader no longer holds', () => {
    /* The leader changed it too, and its journal has lost that row: nothing but the value says so. */
    expect(journalOutcome(TASKS, task({ title: 'T2' }), task({ title: 'T1' }), history([changed({ title: 'T0' })]))).toEqual({ do: 'change', set: [], conflict: ['title'] });
  });

  it('never takes what a skipped transaction wrote', () => {
    const both = history([changed({ title: 'T0' })], [changed({ title: 'T1' })]);
    expect(journalOutcome(TASKS, task({ title: 'T2' }), task(), both)).toEqual({ do: 'change', set: [], conflict: ['title'] });
    expect(journalOutcome(TASKS, task({ title: 'Same' }), task({ title: 'Same' }), both)).toEqual({ do: 'equal' });
    /* A key only skipped transactions touched is the leader's, whatever the source made of that input. */
    expect(journalOutcome(TASKS, task({ status: 'done' }), task(), history([], [changed({ status: 'todo' })]))).toEqual({ do: 'equal' });
  });

  it('never deletes through a skipped transaction', () => {
    const gone = deleted(task({ title: 'T1' }));
    expect(journalOutcome(TASKS, null, task(), history([changed({ title: 'T0' })], [gone]))).toEqual({ do: 'conflict', kind: 'removed_changed', cols: [], there: gone.old });
    expect(journalOutcome(TASKS, null, task(), history([], [gone]))).toEqual({ do: 'equal' });
    expect(journalOutcome(TASKS, null, task(), history([changed({})], [gone]))).toEqual({ do: 'equal' });
  });

  it('deletes nothing the leader changed since', () => {
    const gone = deleted(task({ title: 'T0' }));
    expect(journalOutcome(TASKS, null, task({ title: 'T1' }), history([gone]))).toEqual({ do: 'conflict', kind: 'removed_changed', cols: [], there: gone.old });
  });

  it("proves nothing below the leader's horizon", () => {
    const old = row({ op: 'update', at: new Date('2026-10-01T00:00:00Z'), cols: ['title'], old: { title: 'T0' } });
    const of = historiesOf([old], new Set(), new Date('2026-10-20T00:00:00Z')).get('tasks')!.get(keyText(KEY))!;
    expect(of).toMatchObject({ a: [], s: [], old: [old] });
    expect(journalOutcome(TASKS, task({ title: 'T1' }), task(), of)).toEqual({ do: 'change', set: [], conflict: ['title'] });
    expect(journalOutcome(TASKS, task({ title: 'Same' }), task({ title: 'Same' }), of)).toEqual({ do: 'equal' });
    /* A row that old which the leader lacks: nothing says whether the leader removed it, so it is listed, not added. */
    const added = row({ op: 'insert', at: new Date('2026-10-01T00:00:00Z'), cols: COLS });
    expect(journalOutcome(TASKS, task(), null, history([], [], [added]))).toEqual({ do: 'conflict', kind: 'changed_removed', cols: [] });
    /* And one that old which went there: the leader's stays, and nothing is listed. */
    expect(journalOutcome(TASKS, null, task(), history([], [], [{ ...deleted(), at: new Date('2026-10-01T00:00:00Z') }]))).toEqual({ do: 'equal' });
  });

  it('leaves the bookkeeping alone', () => {
    expect(differing(TASKS, task({ version: 7, updated_at: '2026-11-05T09:00:00+00:00' }), task())).toEqual([]);
    const machine = (over: Row = {}): Row => ({ id: ID, hostname: 'marat-mac', report_at: '2026-11-03T14:00:00+00:00', disk_free: 100, addresses: ['192.0.2.1'], ...over });
    expect(compareOutcome(MACHINES, machine({ report_at: '2026-11-03T15:00:00+00:00', disk_free: 50, addresses: [] }), machine())).toEqual({ do: 'equal' });
    /* An end both sides recorded is one end, whenever each wrote it. */
    const certificate = (revokedAt: string | null): Row => ({ serial: 'ab', machine_id: ID, revoked_at: revokedAt });
    expect(compareOutcome(CERTIFICATES, certificate('2026-11-03T14:00:00+00:00'), certificate('2026-11-04T09:00:00+00:00'))).toEqual({ do: 'equal' });
    expect(compareOutcome(CERTIFICATES, certificate('2026-11-03T14:00:00+00:00'), certificate(null))).toEqual({ do: 'conflict', kind: 'differs', cols: ['revoked_at'] });
    /* Only the columns asked about. */
    expect(differing(TASKS, task({ title: 'T1', status: 'done' }), task(), ['status', 'body'])).toEqual(['status']);
  });

  it('compares by type', () => {
    const stamp = 'timestamp with time zone';
    expect(same(stamp, '2026-11-03T14:02:00.123456+00:00', '2026-11-03T16:02:00.123456+02:00')).toBe(true);
    expect(same(stamp, '2026-11-03T14:02:00.123456+00:00', '2026-11-03T14:02:00.123457+00:00')).toBe(false);
    expect(same(stamp, '2026-11-03T14:02:00+00:00', '2026-11-03 14:02:00+00')).toBe(true);
    expect([same(stamp, null, null), same(stamp, null, '2026-11-03T14:02:00+00:00')]).toEqual([true, false]);
    const hi = createHash('sha256').update('hi').digest('hex');
    expect(same('bytea', '\\x6869', `sha256:${hi}`)).toBe(true);
    expect(same('bytea', `sha256:${hi}`, '\\x6869')).toBe(true);
    expect(same('bytea', '\\x6869', '\\x686a')).toBe(false);
    expect(same('jsonb', { a: 1, b: { d: [1, 2], c: null } }, { b: { c: null, d: [1, 2] }, a: 1 })).toBe(true);
    expect(same('jsonb', { a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect([same('text', 'a', 'a'), same('text', 'a', 'b'), same('integer', 3, 3), same('text[]', ['a'], ['a'])]).toEqual([true, false, true, true]);
  });

  it('compares after a restore', () => {
    expect(compareOutcome(TASKS, task(), null)).toEqual({ do: 'add' });
    expect(compareOutcome(TASKS, task({ version: 9 }), task())).toEqual({ do: 'equal' });
    expect(compareOutcome(TASKS, task({ status: 'done' }), task())).toEqual({ do: 'conflict', kind: 'differs', cols: ['status'] });
  });
});
