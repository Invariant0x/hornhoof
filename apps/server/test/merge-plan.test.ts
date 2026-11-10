import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TableFacts } from '../src/modules/merge/facts.js';
import { compareOutcome, cutoffOf, differing, divergence, historiesOf, journalOutcome, pathOf, same, skippedXacts, theirsOf, type KeyHistory, type Theirs } from '../src/modules/merge/plan.js';
import { keyText, type JournalRow, type Row } from '../src/modules/merge/read.js';

const ONE_DAY_MS = 86_400_000;
const KEY = { id: 't1' };
const TIME = 'timestamp with time zone';

function tableOf(name: string, columns: Record<string, string>): TableFacts {
  return { name, columns: Object.entries(columns).map(([column, type]) => ({ name: column, type })), key: ['id'], fks: [], referencedBy: [] };
}

const TASKS = tableOf('tasks', { id: 'uuid', title: 'text', body: 'text', status: 'text', updated_at: TIME, version: 'integer' });
const MACHINES = tableOf('machines', { id: 'uuid', hostname: 'text', report_at: TIME, disk_free: 'bigint', addresses: 'jsonb' });
const CERTIFICATES = tableOf('certificates', { id: 'uuid', subject: 'text', revoked_at: TIME });
const MACHINE_ACCESS = tableOf('machine_access', { id: 'uuid', note: 'text', until: TIME, opened_by: 'text' });
const AGENT_EVENTS = tableOf('agent_events', { id: 'uuid', data: 'jsonb' });
const APPLIED = tableOf('applied', { source: 'text', base: 'text' });
const NODE_CODES = tableOf('node_codes', { id: 'uuid', code: 'text' });

const TASK: Row = { id: 't1', title: 'T0', body: 'B0', status: 'todo', updated_at: '2026-11-03T14:00:00+00:00', version: 1 };
const task = (change: Row = {}): Row => ({ ...TASK, ...change });

const minute = (n: number): Date => new Date(Date.UTC(2026, 10, 3, 14, n));

function journalRow(op: JournalRow['op'], at: number, cols: string[], old: Row | null, other: Partial<JournalRow> = {}): JournalRow {
  return { id: `j${String(at).padStart(3, '0')}`, xact: `x${at}`, at: minute(at), tbl: 'tasks', op, key: KEY, cols, old, ...other };
}
const updateOf = (at: number, old: Row, other: Partial<JournalRow> = {}): JournalRow => journalRow('update', at, Object.keys(old), old, other);
const insertOf = (at: number, other: Partial<JournalRow> = {}): JournalRow => journalRow('insert', at, Object.keys(TASK), null, other);
const deleteOf = (at: number, old: Row = TASK, other: Partial<JournalRow> = {}): JournalRow => journalRow('delete', at, Object.keys(old), old, other);
const touchOf = (at: number): JournalRow => journalRow('update', at, [], {});

const history = (a: JournalRow[] = [], s: JournalRow[] = []): KeyHistory => ({ a, s });
const theirs = (did: Partial<Theirs> = {}): Theirs => ({ insert: false, delete: false, cols: new Set(), ...did });
const conflictOn = (...cols: string[]) => ({ do: 'conflict', kind: 'differs', cols });
const EQUAL = { do: 'equal' };

describe('where a merge starts', () => {
  it('chooses the way', () => {
    const neither = { kept: false, leaderRestores: ['r1'], sourceRestores: ['r1'], shared: 3 };
    expect(pathOf(neither)).toBe('journal');
    expect(pathOf({ ...neither, kept: true })).toBe('compare');
    expect(pathOf({ ...neither, leaderRestores: ['r1', 'r2'] })).toBe('compare');
    expect(pathOf({ ...neither, shared: 0 })).toBe('compare');
    expect(pathOf({ ...neither, sourceRestores: ['r1', 'r2'] })).toBe('journal');
  });

  it('finds where the two parted', () => {
    const dayBefore = (at: Date): Date => new Date(at.getTime() - ONE_DAY_MS);
    expect(cutoffOf(minute(0), null)).toEqual(dayBefore(minute(0)));
    expect(cutoffOf(null, minute(0))).toEqual(dayBefore(minute(0)));
    expect(cutoffOf(minute(0), minute(30))).toEqual(dayBefore(minute(30)));
    expect(cutoffOf(minute(30), minute(0))).toEqual(dayBefore(minute(30)));
    expect(cutoffOf(null, null)).toBeNull();

    const source = new Map([['source-only', minute(1)], ['both', minute(0)], ['consumed', minute(2)]]);
    const leader = new Map([['leader-only', minute(1)], ['both', minute(0)]]);
    expect(divergence(source, leader, new Set(['consumed']))).toEqual({ a: ['source-only'], b: ['leader-only'], shared: 1 });
  });

  it('skips what the leader already did', () => {
    const listed = { sources: new Set(['n1:jobs:7']), calls: new Set(['call-1']) };
    const a = [
      journalRow('insert', 1, ['source'], null, { tbl: 'applied', key: { source: 'n1:jobs:7' }, xact: 'listed-source' }),
      updateOf(2, { title: 'T0' }, { xact: 'listed-source' }),
      journalRow('insert', 3, ['id'], null, { tbl: 'tool_calls', key: { id: 'call-1' }, xact: 'listed-call' }),
      journalRow('insert', 4, ['source'], null, { tbl: 'applied', key: { source: 'n2:jobs:8' }, xact: 'its-own' }),
    ];
    expect(skippedXacts(a, listed)).toEqual(new Set(['listed-source', 'listed-call']));
  });

  it('skips only for a row that says so', () => {
    const listed = { sources: new Set(['named']), calls: new Set(['named']) };
    const notProof = [
      journalRow('update', 1, ['at'], { at: 'then' }, { tbl: 'applied', key: { source: 'named' } }),
      journalRow('delete', 2, ['id'], { id: 'named' }, { tbl: 'tool_calls', key: { id: 'named' } }),
      journalRow('insert', 3, ['id'], null, { tbl: 'applied', key: { id: 'named' } }),
      journalRow('insert', 4, ['source'], null, { tbl: 'tool_calls', key: { source: 'named' } }),
      journalRow('insert', 5, ['source'], null, { tbl: 'tasks', key: { source: 'named' } }),
      journalRow('insert', 6, ['id'], null, { tbl: 'tasks', key: { id: 'named' } }),
    ];
    expect(skippedXacts(notProof, listed)).toEqual(new Set());
  });

  it('puts what proves nothing into s, each side in the order of its journal', () => {
    const below = updateOf(1, { title: 'old' }, { xact: 'below' });
    const skipped = updateOf(10, { title: 'skipped' }, { xact: 'skipped' });
    const atHorizon = updateOf(5, { title: 'at' }, { xact: 'at' });
    const later = updateOf(20, { title: 'later' }, { xact: 'later' });
    const histories = historiesOf([later, skipped, below, atHorizon], new Set(['skipped']), minute(5));
    expect(histories.get('tasks')?.get(keyText(KEY))).toEqual({ a: [atHorizon, later], s: [below, skipped] });
    expect(historiesOf([below], new Set(), null).get('tasks')?.get(keyText(KEY))).toEqual({ a: [below], s: [] });
  });

  it('orders one key by at, then id, and keeps tables and keys apart', () => {
    const second = updateOf(1, { title: 'b' }, { id: 'j-b', key: { id: 't1', part: 2 } });
    const first = updateOf(1, { title: 'a' }, { id: 'j-a', key: { part: 2, id: 't1' } });
    const otherKey = updateOf(1, { title: 'c' }, { key: { id: 't2' } });
    const otherTable = updateOf(1, { title: 'd' }, { tbl: 'turns' });
    const histories = historiesOf([second, otherKey, first, otherTable], new Set(), null);
    expect(histories.get('tasks')?.get(keyText({ id: 't1', part: 2 }))?.a).toEqual([first, second]);
    expect(histories.get('tasks')?.get(keyText({ id: 't2' }))?.a).toEqual([otherKey]);
    expect(histories.get('turns')?.get(keyText(KEY))?.a).toEqual([otherTable]);
  });

  it('says what the leader did to a key', () => {
    const did = theirsOf([
      updateOf(1, { title: 'T0', body: 'B0' }),
      updateOf(2, { status: 'todo' }),
      insertOf(3, { key: { id: 'made' } }),
      deleteOf(4, TASK, { key: { id: 'gone' } }),
      updateOf(5, {}, { tbl: 'turns' }),
    ]);
    expect(did.get('tasks')?.get(keyText(KEY))).toEqual(theirs({ cols: new Set(['title', 'body', 'status']) }));
    expect(did.get('tasks')?.get(keyText({ id: 'made' }))).toEqual(theirs({ insert: true }));
    expect(did.get('tasks')?.get(keyText({ id: 'gone' }))).toEqual(theirs({ delete: true }));
    expect(did.get('turns')?.get(keyText(KEY))).toEqual(theirs());
  });
});

describe('what the journal proves', () => {
  it('applies a column only the source changed, from the value the leader holds', () => {
    const mine = history([updateOf(1, { title: 'T0' })]);
    expect(journalOutcome(TASKS, task({ title: 'T1' }), task(), mine)).toEqual({ do: 'change', set: ['title'], conflict: [] });
  });

  it('takes a column from its first base, whatever the source wrote on the way', () => {
    const mine = history([updateOf(1, { title: 'T0' }), updateOf(2, { title: 'T1' })]);
    expect(journalOutcome(TASKS, task({ title: 'T2' }), task({ title: 'T0' }), mine)).toEqual({ do: 'change', set: ['title'], conflict: [] });
    expect(journalOutcome(TASKS, task({ title: 'T2' }), task({ title: 'T1' }), mine)).toEqual(conflictOn('title'));
  });

  it('lists a column both changed', () => {
    const mine = history([updateOf(1, { title: 'T0' })]);
    const leaderToo = theirs({ cols: new Set(['title']) });
    expect(journalOutcome(TASKS, task({ title: 'T1' }), task({ title: 'T2' }), mine, leaderToo)).toEqual(conflictOn('title'));
    expect(journalOutcome(TASKS, task({ title: 'T1' }), task({ title: 'T1' }), mine, leaderToo)).toEqual(EQUAL);
  });

  it('takes nothing from a key the leader made or removed since, even at its base', () => {
    const mine = history([updateOf(1, { title: 'T0' })]);
    const x = task({ title: 'T1' });
    expect(journalOutcome(TASKS, x, task(), mine, theirs({ insert: true }))).toEqual(conflictOn('title'));
    expect(journalOutcome(TASKS, x, task(), mine, theirs({ delete: true }))).toEqual(conflictOn('title'));
    expect(journalOutcome(TASKS, x, task(), mine, theirs({ cols: new Set(['title']) }))).toEqual(conflictOn('title'));
  });

  it('takes some columns and lists others of one row', () => {
    const mine = history([updateOf(1, { title: 'T0', status: 'todo' })]);
    const leaderOnStatus = theirs({ cols: new Set(['status']) });
    const x = task({ title: 'T1', status: 'done' });
    const y = task({ status: 'review' });
    expect(journalOutcome(TASKS, x, y, mine, leaderOnStatus)).toEqual({ do: 'change', set: ['title'], conflict: ['status'] });
  });

  it('leaves the columns no row names to the leader', () => {
    const mine = history([updateOf(1, { title: 'T0' })]);
    expect(journalOutcome(TASKS, task({ title: 'T1', body: 'there' }), task({ body: 'here' }), mine)).toEqual({ do: 'change', set: ['title'], conflict: [] });
  });

  it('adds a row only the source has', () => {
    expect(journalOutcome(TASKS, task(), null, history([insertOf(1)]))).toEqual({ do: 'add' });
    expect(journalOutcome(TASKS, task(), null, history([insertOf(1), updateOf(2, { title: 'T0' })]))).toEqual({ do: 'add' });
  });

  it('deletes a row only the source removed, from the row the leader holds', () => {
    expect(journalOutcome(TASKS, null, task(), history([deleteOf(1)]))).toEqual({ do: 'delete' });
    const changedThenRemoved = history([updateOf(1, { title: 'T0' }), deleteOf(2, task({ title: 'T1' }))]);
    expect(journalOutcome(TASKS, null, task(), changedThenRemoved)).toEqual({ do: 'delete' });
  });

  it('lists a row removed there and changed here', () => {
    const removed = deleteOf(1);
    const outcome = journalOutcome(TASKS, null, task({ title: 'T1' }), history([removed]), theirs({ cols: new Set(['title']) }));
    expect(outcome).toEqual({ do: 'conflict', kind: 'removed_changed', cols: [], there: TASK });
    expect(journalOutcome(TASKS, null, task(), history([removed]), theirs({ cols: new Set(['title']) }))).toMatchObject({ kind: 'removed_changed' });
    expect(journalOutcome(TASKS, null, task(), history([removed]), theirs({ delete: true }))).toMatchObject({ kind: 'removed_changed' });
    expect(journalOutcome(TASKS, null, task(), history([removed]), theirs({ insert: true }))).toMatchObject({ kind: 'removed_changed' });
  });

  it('lists a row changed there and removed here', () => {
    const changed = history([updateOf(1, { title: 'T0' })]);
    expect(journalOutcome(TASKS, task({ title: 'T1' }), null, changed, theirs({ delete: true }))).toEqual({ do: 'conflict', kind: 'changed_removed', cols: [] });
    expect(journalOutcome(TASKS, task({ title: 'T1' }), null, changed)).toEqual({ do: 'conflict', kind: 'changed_removed', cols: [] });
    expect(journalOutcome(TASKS, task(), null, history([insertOf(1)]), theirs({ delete: true }))).toEqual({ do: 'conflict', kind: 'changed_removed', cols: [] });
  });

  it('leaves a key only the leader touched', () => {
    const leader = theirs({ cols: new Set(['title']) });
    expect(journalOutcome(TASKS, task(), task({ title: 'T1' }), history(), leader)).toEqual(EQUAL);
    expect(journalOutcome(TASKS, task(), null, history(), theirs({ delete: true }))).toEqual(EQUAL);
    expect(journalOutcome(TASKS, null, task(), history(), theirs({ insert: true }))).toEqual(EQUAL);
  });

  it('finds nothing in a row added and removed there', () => {
    const addedAndRemoved = history([insertOf(1), deleteOf(2)]);
    expect(journalOutcome(TASKS, null, null, addedAndRemoved)).toEqual(EQUAL);
    expect(journalOutcome(TASKS, null, task(), addedAndRemoved)).toEqual(EQUAL);
  });

  it('never deletes what the source removed, added again and removed', () => {
    const outcome = journalOutcome(TASKS, null, task(), history([deleteOf(1), insertOf(2), deleteOf(3, task({ title: 'T9' }))]));
    expect(outcome).toEqual({ do: 'conflict', kind: 'removed_changed', cols: [], there: task({ title: 'T9' }) });
  });

  it('lists a natural key both added with other values', () => {
    const added = history([insertOf(1)]);
    expect(journalOutcome(TASKS, task({ title: 'T1', body: 'B1' }), task(), added)).toEqual(conflictOn('title', 'body'));
    expect(journalOutcome(TASKS, task({ version: 9 }), task(), added)).toEqual(EQUAL);
  });

  it('lists a change whose base the leader no longer holds', () => {
    const mine = history([updateOf(1, { title: 'T0' })]);
    expect(journalOutcome(TASKS, task({ title: 'T2' }), task({ title: 'T1' }), mine)).toEqual(conflictOn('title'));
  });

  it('proves nothing from a row that holds no base', () => {
    const mine = history([journalRow('update', 1, ['title'], {})]);
    expect(journalOutcome(TASKS, task({ title: 'T1' }), task({ title: null }), mine)).toEqual(conflictOn('title'));
    const noOld = history([journalRow('update', 1, ['title'], null)]);
    expect(journalOutcome(TASKS, task({ title: 'T1' }), task({ title: null }), noOld)).toEqual(conflictOn('title'));
  });

  it('never takes what a skipped transaction wrote', () => {
    const mine = history([updateOf(1, { title: 'T0' })], [updateOf(2, { title: 'T1' })]);
    expect(journalOutcome(TASKS, task({ title: 'T2' }), task({ title: 'T0' }), mine)).toEqual(conflictOn('title'));
    expect(journalOutcome(TASKS, task({ title: 'T2' }), task({ title: 'T2' }), mine)).toEqual(EQUAL);
  });

  it('never deletes through a skipped transaction', () => {
    const removedSkipped = deleteOf(2, task({ title: 'T1' }));
    const outcome = journalOutcome(TASKS, null, task(), history([updateOf(1, { title: 'T0' })], [removedSkipped]));
    expect(outcome).toEqual({ do: 'conflict', kind: 'removed_changed', cols: [], there: removedSkipped.old });
    expect(journalOutcome(TASKS, null, task(), history([], [removedSkipped]))).toEqual(EQUAL);
    expect(journalOutcome(TASKS, null, task(), history([touchOf(1)], [removedSkipped]))).toEqual(EQUAL);
  });

  it('lists a row the source added, then removed in a skipped transaction', () => {
    const outcome = journalOutcome(TASKS, null, task(), history([insertOf(1)], [deleteOf(2, task({ title: 'T1' }))]));
    expect(outcome).toEqual({ do: 'conflict', kind: 'removed_changed', cols: [], there: task({ title: 'T1' }) });
    expect(journalOutcome(TASKS, null, null, history([insertOf(1)], [deleteOf(2)]))).toEqual(EQUAL);
  });

  it('reads the last row of both sides of the history together', () => {
    const skippedAfter = updateOf(5, { title: 'T1' });
    const outcome = journalOutcome(TASKS, null, task(), history([deleteOf(1)], [skippedAfter]));
    expect(outcome).toEqual({ do: 'conflict', kind: 'removed_changed', cols: [], there: skippedAfter.old });
    const skippedBefore = updateOf(1, { title: 'T1' });
    expect(journalOutcome(TASKS, null, task(), history([deleteOf(5)], [skippedBefore]))).toEqual({ do: 'delete' });
    const sameTime = (id: string, row: JournalRow): JournalRow => ({ ...row, id });
    expect(journalOutcome(TASKS, null, task(), history([sameTime('j-a', deleteOf(5))], [sameTime('j-b', updateOf(5, { title: 'T1' }))]))).toMatchObject({ kind: 'removed_changed' });
    expect(journalOutcome(TASKS, null, task(), history([sameTime('j-b', deleteOf(5))], [sameTime('j-a', updateOf(5, { title: 'T1' }))]))).toEqual({ do: 'delete' });
  });

  it('lists a row that went with no delete in the journal', () => {
    expect(journalOutcome(TASKS, null, task(), history([insertOf(1)]))).toEqual({ do: 'conflict', kind: 'removed_changed', cols: [] });
    const changed = updateOf(1, { title: 'T0' });
    expect(journalOutcome(TASKS, null, task(), history([changed]))).toEqual({ do: 'conflict', kind: 'removed_changed', cols: [], there: changed.old });
  });

  it('deletes nothing the leader changed since', () => {
    const outcome = journalOutcome(TASKS, null, task({ title: 'T1' }), history([deleteOf(1)]));
    expect(outcome).toEqual({ do: 'conflict', kind: 'removed_changed', cols: [], there: TASK });
  });

  it('deletes nothing when a column kept its source value but not its base', () => {
    const mine = history([updateOf(1, { title: 'T0' }), deleteOf(2, task({ title: 'T1' }))]);
    expect(journalOutcome(TASKS, null, task({ title: 'T1' }), mine)).toMatchObject({ kind: 'removed_changed' });
  });

  it('proves nothing below the leader\'s horizon', () => {
    const below = updateOf(1, { title: 'T0' });
    const mine = historiesOf([below], new Set(), minute(5)).get('tasks')!.get(keyText(KEY))!;
    expect(journalOutcome(TASKS, task({ title: 'T1' }), task(), mine)).toEqual(conflictOn('title'));
    expect(journalOutcome(TASKS, task({ title: 'T1' }), task({ title: 'T1' }), mine)).toEqual(EQUAL);
  });

  it('keeps a key only s touched as the leader has it, and lists a difference', () => {
    const skippedInsert = insertOf(1);
    expect(journalOutcome(TASKS, task(), null, history([], [skippedInsert]))).toEqual(EQUAL);
    expect(journalOutcome(TASKS, task({ body: 'there' }), task({ body: 'here' }), history([], [skippedInsert]), theirs({ cols: new Set(['title']) }))).toEqual(conflictOn('body'));
  });

  it('finds nothing in an update that changed nothing', () => {
    expect(journalOutcome(TASKS, task({ title: 'T1' }), task(), history([touchOf(1)]))).toEqual(EQUAL);
    expect(journalOutcome(TASKS, task(), null, history([touchOf(1)]))).toEqual(EQUAL);
    expect(journalOutcome(TASKS, null, task(), history([touchOf(1)]))).toEqual(EQUAL);
    expect(journalOutcome(TASKS, null, null, history())).toEqual(EQUAL);
    expect(journalOutcome(TASKS, null, task(), history([deleteOf(1)], [touchOf(5)]))).toEqual({ do: 'delete' });
  });

  it('never takes computer access from the source', () => {
    const access: Row = { id: 'a1', note: 'n0', until: null, opened_by: null };
    const mine = history([updateOf(1, { until: null, opened_by: null, note: 'n0' })]);
    const x = { ...access, until: '2026-11-03T15:00:00+00:00', opened_by: 'p1', note: 'n1' };
    expect(journalOutcome(MACHINE_ACCESS, x, access, mine)).toEqual({ do: 'change', set: ['note'], conflict: ['until', 'opened_by'] });
    expect(journalOutcome(MACHINE_ACCESS, { ...x, note: 'n0' }, access, mine)).toEqual(conflictOn('until', 'opened_by'));
  });

  it('asks only what a kind of table allows', () => {
    const added = history([insertOf(1)]);
    const event: Row = { id: 'e1', data: { a: 1 } };
    for (const table of [AGENT_EVENTS, APPLIED]) {
      expect(journalOutcome(table, event, null, added), table.name).toEqual({ do: 'add' });
      expect(journalOutcome(table, event, null, history([touchOf(1)])), table.name).toEqual({ do: 'add' });
      expect(journalOutcome(table, event, null, history([], [insertOf(1)])), table.name).toEqual(EQUAL);
      expect(journalOutcome(table, event, { ...event, data: { a: 2 } }, added), table.name).toEqual(EQUAL);
      expect(journalOutcome(table, null, event, history([deleteOf(1)])), table.name).toEqual(EQUAL);
      expect(journalOutcome(table, null, null, added), table.name).toEqual(EQUAL);
      expect(compareOutcome(table, event, null), table.name).toEqual({ do: 'add' });
      expect(compareOutcome(table, event, { ...event, data: { a: 2 } }), table.name).toEqual(EQUAL);
    }
    expect(journalOutcome(NODE_CODES, { id: 'c1', code: 'x' }, null, added)).toEqual(EQUAL);
    expect(journalOutcome(NODE_CODES, null, { id: 'c1', code: 'x' }, history([deleteOf(1)]))).toEqual(EQUAL);
    expect(compareOutcome(NODE_CODES, { id: 'c1', code: 'x' }, null)).toEqual(EQUAL);
  });
});

describe('what is compared, and how', () => {
  it('leaves the bookkeeping alone', () => {
    const later = { updated_at: '2026-11-03T15:00:00+00:00', version: 9 };
    expect(compareOutcome(TASKS, task(later), task())).toEqual(EQUAL);
    expect(journalOutcome(TASKS, task(later), task(), history([updateOf(1, { updated_at: TASK.updated_at, version: 1 })]))).toEqual(EQUAL);

    const machine: Row = { id: 'm1', hostname: 'h1', report_at: '2026-11-03T14:00:00+00:00', disk_free: 10, addresses: ['192.0.2.1'] };
    const reported = { ...machine, report_at: '2026-11-03T15:00:00+00:00', disk_free: 20, addresses: ['192.0.2.2'] };
    expect(compareOutcome(MACHINES, reported, machine)).toEqual(EQUAL);

    const certificate: Row = { id: 'c1', subject: 's', revoked_at: '2026-11-03T14:00:00+00:00' };
    expect(compareOutcome(CERTIFICATES, { ...certificate, revoked_at: '2026-11-03T15:00:00+00:00' }, certificate)).toEqual(EQUAL);
    expect(compareOutcome(CERTIFICATES, { ...certificate, revoked_at: null }, certificate)).toEqual(conflictOn('revoked_at'));
    expect(compareOutcome(CERTIFICATES, certificate, { ...certificate, revoked_at: null })).toEqual(conflictOn('revoked_at'));
  });

  it('counts no report as a row of either side', () => {
    const machine: Row = { id: 'm1', hostname: 'h1', report_at: '2026-11-03T14:00:00+00:00', disk_free: 10, addresses: [] };
    const removed = journalRow('delete', 2, Object.keys(machine), machine, { tbl: 'machines' });
    const leaderReported = theirs({ cols: new Set(['report_at', 'disk_free']) });
    expect(journalOutcome(MACHINES, null, { ...machine, disk_free: 99 }, history([removed]), leaderReported)).toEqual({ do: 'delete' });
    expect(journalOutcome(MACHINES, null, machine, history([removed]), theirs({ cols: new Set(['report_at', 'hostname']) }))).toMatchObject({ kind: 'removed_changed' });

    const reported = journalRow('update', 1, ['report_at'], { report_at: machine.report_at }, { tbl: 'machines' });
    expect(journalOutcome(MACHINES, machine, null, history([reported]))).toEqual(EQUAL);
    expect(journalOutcome(MACHINES, null, machine, history([reported]))).toEqual(EQUAL);
  });

  it('keeps the leader\'s end when both recorded one, even from a base', () => {
    const certificate: Row = { id: 'c1', subject: 's', revoked_at: '2026-11-03T14:00:00+00:00' };
    const mine = history([journalRow('update', 1, ['revoked_at'], { revoked_at: certificate.revoked_at }, { tbl: 'certificates' })]);
    expect(journalOutcome(CERTIFICATES, { ...certificate, revoked_at: '2026-11-03T15:00:00+00:00' }, certificate, mine)).toEqual(EQUAL);
    const clearedThere = { ...certificate, revoked_at: null };
    expect(journalOutcome(CERTIFICATES, clearedThere, certificate, mine)).toEqual({ do: 'change', set: ['revoked_at'], conflict: [] });
    expect(journalOutcome(CERTIFICATES, clearedThere, { ...certificate, revoked_at: '2026-11-03T16:00:00+00:00' }, mine)).toEqual(conflictOn('revoked_at'));
  });

  it('compares by type', () => {
    expect(same(TIME, '2026-11-03T14:02:00.123456+00:00', '2026-11-03T16:02:00.123456+02:00')).toBe(true);
    expect(same(TIME, '2026-11-03T14:02:00.123456+00:00', '2026-11-03T14:02:00.123457+00:00')).toBe(false);
    const hi = `sha256:${createHash('sha256').update('hi').digest('hex')}`;
    expect(same('bytea', '\\x6869', hi)).toBe(true);
    expect(same('bytea', hi, '\\x6869')).toBe(true);
    expect(same('bytea', '\\x6869', '\\x6869')).toBe(true);
    expect(same('bytea', '\\x6868', hi)).toBe(false);
    expect(same('jsonb', { a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('reads a time whatever its form', () => {
    expect(same(TIME, '2026-11-03T14:02:00.5+00:00', '2026-11-03T14:02:00.500000+00:00')).toBe(true);
    expect(same(TIME, '2026-11-03T14:02:00+00:00', '2026-11-03T14:02:00.000000Z')).toBe(true);
    expect(same(TIME, '2026-11-03T14:02:00.5+00:00', '2026-11-03T14:02:00.05+00:00')).toBe(false);
    expect(same(TIME, '2026-11-03T14:02:01+00:00', '2026-11-03T14:02:00.001+00:00')).toBe(false);
    expect(same('timestamp(3) with time zone', '2026-11-03T14:02:00.500+00:00', '2026-11-03T16:02:00.5+02:00')).toBe(true);
    expect(same('timestamp without time zone', '2026-03-08T02:30:00', '2026-03-08T03:30:00')).toBe(false);
    expect(same('timestamp without time zone', '2026-11-03T14:02:00.5', '2026-11-03T14:02:00.500000')).toBe(true);
    expect(same(TIME, 'infinity', 'infinity')).toBe(true);
    expect(same(TIME, 'infinity', '2026-11-03T14:02:00+00:00')).toBe(false);
    expect(same('text', '2026-11-03T14:02:00+00:00', '2026-11-03T16:02:00+02:00')).toBe(false);
  });

  it('compares JSON by its content and nothing by its absence', () => {
    expect(same('jsonb', { a: { c: 1, d: [{ f: 1, e: 2 }] } }, { a: { d: [{ e: 2, f: 1 }], c: 1 } })).toBe(true);
    expect(same('jsonb', [1, 2], [2, 1])).toBe(false);
    expect(same('jsonb', [1], { 0: 1 })).toBe(false);
    expect(same('jsonb', { a: 1 }, { a: 2 })).toBe(false);
    expect(same('text', 'a', 'a')).toBe(true);
    expect(same('integer', 1, 2)).toBe(false);
    expect(same('text', null, null)).toBe(true);
    expect(same('text', null, 'a')).toBe(false);
    expect(same('text', 'a', null)).toBe(false);
    expect(same('text', '', null)).toBe(false);
    expect(same('integer', 0, null)).toBe(false);
    expect(same('bytea', null, null)).toBe(true);
    expect(same(TIME, null, '2026-11-03T14:02:00+00:00')).toBe(false);
  });

  it('names the columns that differ, of those it is asked of', () => {
    const x = task({ title: 'T1', body: 'B1', version: 9 });
    expect(differing(TASKS, x, task())).toEqual(['title', 'body']);
    expect(differing(TASKS, x, task(), ['body', 'version', 'status'])).toEqual(['body']);
    expect(differing(TASKS, x, task(), [])).toEqual([]);
    expect(differing(TASKS, x, task(), ['a column the table no longer has'])).toEqual([]);
  });

  it('compares after a restore', () => {
    expect(compareOutcome(TASKS, task(), null)).toEqual({ do: 'add' });
    expect(compareOutcome(TASKS, task({ updated_at: '2026-11-03T15:00:00+00:00', version: 7 }), task())).toEqual(EQUAL);
    expect(compareOutcome(TASKS, task({ status: 'done' }), task())).toEqual(conflictOn('status'));
  });
});
