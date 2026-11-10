import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { HIDDEN } from '../src/db/agent-sql.js';
import { JOB_STATUSES, TARGET_KINDS, TEST_PART_STATUSES, TEST_RUN_STATUSES } from '../src/db/schema.js';
import { factsOf, parentsFirst, sameShape, type Facts, type Query, type TableFacts } from '../src/modules/merge/facts.js';
import { BOOKKEEPING, CEO_TOPICS, CLOSING, SOFT_REFS, TABLE_RULES, ceosConflict, isSecret, ruleOf, type TableRule } from '../src/modules/merge/rules.js';
import { nameOf, rangeWords, timeWords, valueWords } from '../src/modules/merge/words.js';
import { createTestDb } from './helpers.js';

/* Tables a rule names that no migration has made yet. The checks below skip a name here only while the catalog lacks
   it, so a table that lands is checked at once; the task that makes one takes its name out of this set. */
const LATER = new Set(['applied', 'authority', 'certificates', 'computer_runs', 'machine_access', 'machine_online', 'machine_tickets', 'peer_secrets', 'person_keys', 'recovery_keys', 'tool_calls']);
/* Plan 3 Task 2 adds this column, and takes the name out of this set with it. */
const LATER_COLUMNS = new Set(['task_events.uuid']);
const DIFFERENT_VERSIONS = 'The two databases are of different versions.';

async function testFacts(): Promise<Facts> {
  const client = (await createTestDb()).$client;
  const query: Query = async <T,>(text: string, params?: unknown[]) => (await client.query<T>(text, params)).rows;
  return factsOf(query);
}

function missingFrom(facts: Facts, table: string, columns: readonly string[] = []): string[] {
  const found = facts.tables.get(table);
  if (!found) return LATER.has(table) ? [] : [table];
  const names = found.columns.map(column => column.name);
  return columns.map(column => `${table}.${column}`).filter(name => !names.includes(name.slice(table.length + 1)) && !LATER_COLUMNS.has(name));
}

const columnsARuleNames = (rule: TableRule): string[] => [
  ...(rule.hereOnly ?? []),
  ...(rule.number ? ['number', ...rule.number] : []),
  ...[rule.task, rule.match, rule.sequence].filter(column => column !== undefined),
];

const withTasks = (facts: Facts, change: (tasks: TableFacts) => TableFacts): Facts => ({
  ...facts,
  tables: new Map([...facts.tables].map(([name, table]) => [name, name === 'tasks' ? change(table) : table])),
});

describe('the merge rules', () => {
  it('has a rule for every table', async () => {
    const facts = await testFacts();
    for (const table of facts.tables.keys()) expect(() => ruleOf(table), table).not.toThrow();
    expect(() => ruleOf('nope')).toThrow('No merge rule for public.nope.');
    expect([
      ...Object.entries(TABLE_RULES).flatMap(([table, rule]) => [
        ...missingFrom(facts, table, columnsARuleNames(rule)),
        ...(rule.after ?? []).flatMap(parent => missingFrom(facts, parent)),
      ]),
      ...Object.entries(CLOSING).flatMap(([table, closing]) => missingFrom(facts, table, [closing.column, closing.at, ...(closing.error ? [closing.error] : [])])),
      ...SOFT_REFS.flatMap(ref => [...missingFrom(facts, ref.table, [ref.column, ...(ref.when ? [ref.when.column] : [])]), ...missingFrom(facts, ref.parent)]),
      ...Object.keys(BOOKKEEPING).flatMap(table => missingFrom(facts, table)),
    ]).toEqual([]);
  });

  it('closes only to states its table has, and tells soft references by kinds a subscription has', () => {
    const states: Record<string, readonly string[]> = { jobs: JOB_STATUSES, test_runs: TEST_RUN_STATUSES, test_parts: TEST_PART_STATUSES };
    for (const [table, known] of Object.entries(states)) {
      expect(known, table).toEqual(expect.arrayContaining([...CLOSING[table]!.open, CLOSING[table]!.to]));
    }
    expect(TARGET_KINDS).toEqual(expect.arrayContaining(SOFT_REFS.flatMap(ref => (ref.when ? [ref.when.value] : []))));
  });

  it('gives every hidden table to the CEO or keeps it out', () => {
    for (const table of HIDDEN) {
      const rule = ruleOf(table);
      expect(CEO_TOPICS.includes(rule.topic) || rule.kind === 'skip' || rule.kind === 'add', table).toBe(true);
    }
  });

  it('says whose a conflict is', () => {
    for (const table of ['people', 'public_links', 'nodes', 'machines']) expect(ceosConflict(table), table).toBe(true);
    for (const table of ['tasks', 'agents']) expect(ceosConflict(table), table).toBe(false);
    expect(() => ceosConflict('nope')).toThrow('No merge rule for public.nope.');
  });

  it('hides secrets', () => {
    const secret = [
      ['people', 'password_hash'], ['jobs', 'tool_token_hash'], ['subscriptions', 'secret_enc'], ['nodes', 'key_hash'], ['nodes', 'account'],
      ['machines', 'machine_key'], ['departments', 'repo_token_enc'], ['sessions', 'token_hash'], ['person_keys', 'wrapped'],
      ['person_keys', 'salt'], ['plan_credentials', 'sealed'], ['recovery_keys', 'iv'], ['machine_access', 'grant'],
    ] as const;
    for (const [table, column] of secret) expect(isSecret(table, column), `${table}.${column}`).toBe(true);
    for (const [table, column] of [['tasks', 'title'], ['people', 'email'], ['nodes', 'status'], ['tasks', 'account']] as const) {
      expect(isSecret(table, column), `${table}.${column}`).toBe(false);
    }
    expect(valueWords('machines', 'machine_key', 'x')).toBe('(hidden)');
    expect(nameOf('sessions', null, { token_hash: 'abc' })).toBe('sessions (hidden)');
  });
});

describe('the catalog', () => {
  it('reads tables, keys and foreign keys both ways', async () => {
    const facts = await testFacts();
    const tasks = facts.tables.get('tasks')!;
    expect(tasks.key).toEqual(['id']);
    expect(tasks.columns).toContainEqual({ name: 'number', type: 'integer' });
    expect(tasks.columns).toContainEqual({ name: 'closed_at', type: 'timestamp with time zone' });
    expect(tasks.fks).toContainEqual(expect.objectContaining({ table: 'tasks', columns: ['turn_id'], parent: 'turns', parentColumns: ['id'] }));
    expect(tasks.referencedBy).toContainEqual(expect.objectContaining({ table: 'turns', columns: ['task_id'], parent: 'tasks', parentColumns: ['id'] }));
    expect(facts.tables.get('map_returns')!.key).toEqual(['company_id', 'upstream_agent_id', 'downstream_agent_id']);
  });

  it('orders parents first and each table after what its rule names', async () => {
    const { order, tables } = await testFacts();
    expect([...order].sort()).toEqual([...tables.keys()].sort());
    for (const [parent, child] of [['departments', 'teams'], ['teams', 'agents'], ['task_events', 'map_returns'], ['agent_events', 'map_returns'], ['tasks', 'turns'], ['tasks', 'test_runs']] as const) {
      expect(order.indexOf(parent), `${parent} before ${child}`).toBeLessThan(order.indexOf(child));
    }
  });

  it('breaks a cycle by name, and only a cycle', () => {
    const order = (parents: Record<string, string[]>) => parentsFirst(new Map(Object.entries(parents)));
    expect(order({ b: ['c'], a: ['b'], c: [] })).toEqual(['c', 'b', 'a']);
    expect(order({ a: ['a'] })).toEqual(['a']);
    expect(order({ turns: ['tasks'], tasks: ['turns'] })).toEqual(['tasks', 'turns']);
    expect(order({ a: ['b'], b: ['c'], c: ['a'] })).toEqual(['a', 'b', 'c']);
    /* A table that only hangs on a cycle waits for it, though its name comes first. */
    expect(order({ a_child: ['m'], m: ['n'], n: ['m'] })).toEqual(['m', 'n', 'a_child']);
    /* A cycle that hangs on another waits for the whole of it. */
    expect(order({ a: ['b', 'y'], b: ['a'], y: ['z'], z: ['y'] })).toEqual(['y', 'z', 'a', 'b']);
    /* What a rule names that the database lacks asks for nothing. */
    expect(order({ a: ['later'] })).toEqual(['a']);
  });

  it('compares the shape of two databases by tables, columns and types', async () => {
    const facts = await testFacts();
    expect(sameShape(facts, facts)).toBeNull();
    expect(sameShape(facts, withTasks(facts, tasks => ({ ...tasks, columns: [...tasks.columns].reverse() })))).toBeNull();
    expect(sameShape(facts, withTasks(facts, tasks => ({ ...tasks, fks: [], key: [] })))).toBeNull();
    expect(sameShape(facts, withTasks(facts, tasks => ({ ...tasks, columns: tasks.columns.slice(1) })))).toBe(DIFFERENT_VERSIONS);
    expect(sameShape(facts, withTasks(facts, tasks => ({ ...tasks, columns: tasks.columns.map(column => ({ ...column, type: 'bytea' })) })))).toBe(DIFFERENT_VERSIONS);
    expect(sameShape(facts, { ...facts, tables: new Map([...facts.tables].filter(([name]) => name !== 'tasks')) })).toBe(DIFFERENT_VERSIONS);
  });
});

describe('the words', () => {
  const long = 'x'.repeat(300);
  const cut = `${'x'.repeat(200)}...`;

  it('names a row by what people call it', () => {
    const key = { id: '1234567890ab' };
    expect(nameOf('tasks', { number: 57, title: 'Fix login' }, key)).toBe('task #57 "Fix login"');
    expect(nameOf('tasks', { number: 57, title: long }, key)).toBe(`task #57 "${cut}"`);
    expect(nameOf('turns', { number: 3, title: 'Launch' }, key)).toBe('turn 3 "Launch"');
    expect(nameOf('people', { name: 'Ana', email: 'ana@hornhoof.test' }, key)).toBe('Ana (ana@hornhoof.test)');
    for (const table of ['agents', 'departments', 'teams']) expect(nameOf(table, { name: 'Dev' }, key)).toBe('Dev');
    expect(nameOf('machines', { hostname: 'build-1' }, key)).toBe('build-1');
    expect(nameOf('machines', { hostname: '' }, key)).toBe('a machine');
    expect(nameOf('subscriptions', { label: 'Team plan' }, key)).toBe('Team plan');
    expect(nameOf('jobs', { status: 'done' }, key)).toBe('job 12345678');
  });

  it('names a row from its key when nothing else says', () => {
    expect(nameOf('requests', { text: 'Why?' }, { id: 'r1' })).toBe('requests r1');
    expect(nameOf('map_returns', {}, { company_id: 'c', upstream_agent_id: 'u', downstream_agent_id: 'd' })).toBe('map_returns c, u, d');
    expect(nameOf('task_events', null, { id: 7 })).toBe('task_events 7');
    expect(nameOf('tasks', null, { id: 't1' })).toBe('tasks t1');
    expect(nameOf('jobs', null, { id: '1234567890ab' })).toBe('job 12345678');
    expect(nameOf('departments', { name: null, template_key: 'sales' }, { id: 'd1' })).toBe('departments d1');
    expect(nameOf('invites', { person_id: 'p' }, { token_hash: 'abc' })).toBe('invites (hidden)');
    expect(nameOf('requests', null, { id: long })).toBe(`requests ${cut}`);
  });

  it('says a value in plain words', () => {
    expect(valueWords('tasks', 'title', 'Fix login')).toBe('"Fix login"');
    expect(valueWords('tasks', 'title', long)).toBe(`"${cut}"`);
    expect(valueWords('tasks', 'title', null)).toBe('nothing');
    expect(valueWords('tasks', 'title', undefined)).toBe('nothing');
    expect(valueWords('tasks', 'stage', 2)).toBe('2');
    expect(valueWords('tasks', 'gates', ['a', 'b'])).toBe('["a","b"]');
    expect(valueWords('tasks', 'gates', [long])).toBe(`["${'x'.repeat(198)}...`);
    expect(valueWords('people', 'password_hash', null)).toBe('(hidden)');
  });

  const now = new Date('2026-11-04T09:00:00Z');

  it('says a time in UTC, with the year when it is not this one', () => {
    expect(timeWords(new Date('2026-11-03T14:02:00Z'), now)).toBe('3 Nov 14:02 UTC');
    expect(timeWords(new Date('2026-01-09T04:05:59Z'), now)).toBe('9 Jan 04:05 UTC');
    expect(timeWords(new Date('2025-12-31T23:59:00Z'), now)).toBe('31 Dec 2025 23:59 UTC');
  });

  it('says a range in UTC, with the days only when they differ', () => {
    expect(rangeWords(new Date('2026-11-03T14:02:00Z'), new Date('2026-11-03T15:30:00Z'), now)).toBe('14:02 to 15:30 UTC');
    expect(rangeWords(new Date('2026-11-03T23:50:00Z'), new Date('2026-11-04T00:10:00Z'), now)).toBe('3 Nov 23:50 to 4 Nov 00:10 UTC');
    expect(rangeWords(new Date('2025-12-31T23:50:00Z'), new Date('2026-01-01T00:10:00Z'), now)).toBe('31 Dec 2025 23:50 to 1 Jan 00:10 UTC');
  });

  it('takes the present time when none is given', () => {
    vi.useFakeTimers({ toFake: ['Date'], now });
    onTestFinished(() => { vi.useRealTimers(); });
    expect(timeWords(new Date('2026-11-03T14:02:00Z'))).toBe('3 Nov 14:02 UTC');
    expect(timeWords(new Date('2025-11-03T14:02:00Z'))).toBe('3 Nov 2025 14:02 UTC');
    expect(rangeWords(new Date('2025-11-03T14:02:00Z'), new Date('2026-11-04T00:10:00Z'))).toBe('3 Nov 2025 14:02 to 4 Nov 00:10 UTC');
  });
});
