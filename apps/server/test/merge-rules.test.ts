import { describe, expect, it } from 'vitest';
import { HIDDEN } from '../src/db/agent-sql.js';
import { factsOf, sameShape, type Facts, type Query } from '../src/modules/merge/facts.js';
import { BOOKKEEPING, CLOSING, SOFT_REFS, TABLE_RULES, ceos, ceosConflict, isSecret, ruleOf } from '../src/modules/merge/rules.js';
import { nameOf, rangeWords, timeWords, valueWords } from '../src/modules/merge/words.js';
import { openTestDb } from './helpers-db.js';

/* What the catalog says of a database as the migrations leave it. */
async function facts(): Promise<Facts> {
  const { client } = await openTestDb();
  const q: Query = async <T>(text: string, params?: unknown[]) => (await client.query<T>(text, params)).rows;
  return factsOf(q);
}

describe('the rule of each table in a merge', () => {
  it('has a rule for every table', async () => {
    const { tables } = await facts();
    expect(Object.keys(TABLE_RULES).sort()).toEqual([...tables.keys()].sort());
    for (const name of tables.keys()) expect(ruleOf(name)).toBe(TABLE_RULES[name]);
    expect(() => ruleOf('nope')).toThrow('No merge rule for public.nope.');
    const has = (table: string, column: string) => tables.get(table)?.columns.some(found => found.name === column) ?? false;
    /* Whatever a rule names is there, so no rule speaks of a column that was renamed since. */
    for (const [table, cases] of Object.entries(CLOSING)) {
      for (const closing of cases) {
        for (const column of [closing.column, closing.at, ...(closing.error ? [closing.error] : []), ...Object.keys(closing.also ?? {})]) expect([table, column, has(table, column)]).toEqual([table, column, true]);
      }
    }
    for (const ref of SOFT_REFS) {
      expect([ref.table, ref.column, has(ref.table, ref.column), tables.has(ref.parent)]).toEqual([ref.table, ref.column, true, true]);
      if (ref.when) expect([ref.table, ref.when.column, has(ref.table, ref.when.column)]).toEqual([ref.table, ref.when.column, true]);
    }
    for (const [table, rule] of Object.entries(TABLE_RULES)) {
      for (const column of [...(rule.hereOnly ?? []), ...(rule.number ?? []), ...(rule.number ? ['number'] : []), ...(rule.task ? [rule.task] : []), ...(rule.match ? [rule.match] : []), ...(rule.sequence ? [rule.sequence] : [])]) {
        expect([table, column, has(table, column)]).toEqual([table, column, true]);
      }
      for (const other of rule.after ?? []) expect(tables.has(other)).toBe(true);
    }
    for (const table of Object.keys(BOOKKEEPING)) expect(tables.has(table)).toBe(true);
  });

  it('never compares what the leader recomputes', async () => {
    const { tables } = await facts();
    const own = ['server_order', 'server_why', 'memory', 'cores', 'copy_state', 'copy_progress', 'copy_error', 'copy_at', 'copy_name', 'copy_old', 'data_left_at', 'upload_state', 'link_rtt_ms', 'link_mbps', 'internet_rtt_ms', 'internet_mbps'];
    expect(BOOKKEEPING.machines).toEqual(expect.arrayContaining(own));
    /* How far a bot has read its messages is the leader's own count, and a person's layout has its own clock. */
    expect([BOOKKEEPING.telegram_bots, BOOKKEEPING.map_layouts]).toEqual([['update_offset'], ['updated_at']]);
    /* A bot's token is the company's way out to a person: two that differ are the CEO's to settle. */
    expect([ceosConflict('telegram_bots'), ceosConflict('map_layouts')]).toEqual([true, false]);
    /* A place the CEO pinned is his word, so two that differ are his to settle. */
    expect(BOOKKEEPING.machines).not.toContain('server_pin');
    for (const [table, columns] of Object.entries(BOOKKEEPING)) {
      for (const column of columns) expect([table, column, tables.get(table)?.columns.some(found => found.name === column)]).toEqual([table, column, true]);
    }
  });

  it('classifies conflicts by topic independently of the Operations SQL reader', () => {
    expect(HIDDEN).toContain('applied');
    /* What a person's guarded route alone writes is the CEO's too, hidden or not. */
    for (const name of ['requests', 'request_internal', 'proposals', 'approval_policies', 'wait_policies', 'task_waits']) expect([name, ceosConflict(name)]).toEqual([name, true]);
    for (const name of ['tasks', 'turns', 'agents', 'departments', 'jobs', 'notebook_notes', 'backlog_items']) expect([name, ceosConflict(name)]).toEqual([name, false]);
    expect(['people', 'applied', 'sessions', 'a_table_of_another_build', 'tasks', 'jobs'].map(ceos)).toEqual([true, false, true, true, false, false]);
  });

  it('carries over nothing that belongs to the machine that leads, and lets nothing run again', () => {
    for (const name of ['node_codes', 'machine_tickets', 'pending_wakes', 'sign_in_attempts', 'link_tls', 'wait_notices', 'harness_builds', 'harness_products', 'program_instances', 'program_deliveries', 'program_operator_cases', 'program_operator_signals', 'telegram_replies']) {
      expect([name, ruleOf(name).kind]).toEqual([name, 'skip']);
    }
    const closes = (table: string) => (CLOSING[table] ?? []).flatMap(closing => closing.open.map(open => [open, closing.to]));
    expect(closes('jobs')).toEqual([['queued', 'failed'], ['running', 'failed']]);
    expect(closes('computer_runs')).toEqual([['waiting', 'lost'], ['sent', 'lost']]);
    expect(closes('test_runs')).toEqual([['running', 'stopped']]);
    expect(closes('test_parts')).toEqual([['queued', 'stopped'], ['running', 'stopped']]);
    expect(closes('node_connections')).toEqual([[null, 'server_stopped']]);
  });

  it('reads the catalog', async () => {
    const found = await facts();
    const tasks = found.tables.get('tasks')!;
    expect(tasks.key).toEqual(['id']);
    expect(tasks.columns.find(column => column.name === 'created_at')).toEqual({ name: 'created_at', type: 'timestamp with time zone', nullable: false });
    expect(tasks.fks.some(fk => fk.parent === 'turns' && fk.columns.join() === 'turn_id' && fk.parentColumns.join() === 'id')).toBe(true);
    expect(tasks.referencedBy.some(fk => fk.table === 'turns' && fk.columns.join() === 'task_id')).toBe(true);
    expect(found.tables.get('map_returns')!.key).toEqual(['company_id', 'upstream_agent_id', 'downstream_agent_id']);
    /* A key of two columns that another table points at with two. */
    expect(found.tables.get('request_internal')!.fks.some(fk => fk.parent === 'requests' && fk.columns.join() === 'company_id,request_id' && fk.parentColumns.join() === 'company_id,id')).toBe(true);
    const at = (name: string) => found.order.indexOf(name);
    expect(found.order.slice().sort()).toEqual([...found.tables.keys()].sort());
    expect(at('companies')).toBeLessThan(at('people'));
    expect(at('people')).toBeLessThan(at('departments'));
    /* Tables that point at each other in a circle stand together. */
    expect(Math.abs(at('tasks') - at('turns'))).toBe(1);
    expect(at('departments')).toBeLessThan(at('teams'));
    expect(at('teams')).toBeLessThan(at('agents'));
    expect(at('agents')).toBeLessThan(at('agent_changes'));
    expect(at('task_events')).toBeLessThan(at('map_returns'));
    expect(at('agent_events')).toBeLessThan(at('map_returns'));
    expect(sameShape(found, found)).toBeNull();
    const without = (change: (columns: { name: string; type: string; nullable: boolean }[]) => { name: string; type: string; nullable: boolean }[]): Facts => {
      const tables = new Map(found.tables);
      tables.set('teams', { ...tables.get('teams')!, columns: change(tables.get('teams')!.columns) });
      return { tables, order: found.order };
    };
    const sentence = 'The two databases are of different versions.';
    expect(sameShape(found, without(columns => columns.slice(1)))).toBe(sentence);
    expect(sameShape(without(columns => columns.map((column, index) => (index === 1 ? { ...column, type: 'bigint' } : column))), found)).toBe(sentence);
    const fewer = new Map(found.tables);
    fewer.delete('teams');
    expect(sameShape(found, { tables: fewer, order: found.order })).toBe(sentence);
  });

  it('hides secrets', () => {
    const secret = [
      ['people', 'password_hash'], ['jobs', 'tool_token_hash'], ['subscriptions', 'secret_enc'], ['nodes', 'key_hash'], ['nodes', 'account'], ['machines', 'machine_key'],
      ['departments', 'repo_token_enc'], ['sessions', 'token_hash'], ['person_keys', 'wrapped'], ['person_keys', 'salt'], ['machine_access', 'grant'], ['requests', 'answer'], ['attachments', 'bytes'],
    ] as const;
    for (const [table, column] of secret) expect([table, column, isSecret(table, column)]).toEqual([table, column, true]);
    for (const [table, column] of [['tasks', 'title'], ['people', 'email'], ['nodes', 'status']] as const) expect([table, column, isSecret(table, column)]).toEqual([table, column, false]);
    expect(valueWords('machines', 'machine_key', 'x')).toBe('(hidden)');
    expect(nameOf('sessions', null, { token_hash: 'abc' })).toBe('sessions (hidden)');
  });

  it('says rows and times in plain words', () => {
    expect(nameOf('tasks', { number: 57, title: 'Fix login' }, { id: 't1' })).toBe('task #57 "Fix login"');
    expect(nameOf('tasks', { number: 57, title: 'x'.repeat(300) }, { id: 't1' })).toBe(`task #57 "${'x'.repeat(200)}..."`);
    expect(nameOf('turns', { number: 19, title: 'Network' }, { id: 'u1' })).toBe('turn 19 "Network"');
    expect(nameOf('people', { name: 'Ivan', email: 'ivan@acme.test' }, { id: 'p1' })).toBe('Ivan (ivan@acme.test)');
    for (const table of ['agents', 'departments', 'teams']) expect(nameOf(table, { name: 'Sales' }, { id: 'x' })).toBe('Sales');
    expect([nameOf('machines', { hostname: 'marat-mac' }, { id: 'm1' }), nameOf('machines', { hostname: '' }, { id: 'm1' })]).toEqual(['marat-mac', 'a machine']);
    expect(nameOf('subscriptions', { label: 'Team plan' }, { id: 's1' })).toBe('Team plan');
    expect(nameOf('jobs', { id: '0f0f0f0f-0000-4000-8000-00000000000a' }, { id: '0f0f0f0f-0000-4000-8000-00000000000a' })).toBe('job 0f0f0f0f');
    expect(nameOf('map_returns', { work_epoch: 2 }, { company_id: 'c', upstream_agent_id: 'a', downstream_agent_id: 'b' })).toBe('map_returns c, a, b');
    /* With no row, from the key. */
    expect(nameOf('tasks', null, { id: 't1' })).toBe('tasks t1');
    expect([valueWords('tasks', 'title', null), valueWords('tasks', 'title', 'Fix'), valueWords('tasks', 'after', ['a', 'b']), valueWords('tasks', 'silent', 3)]).toEqual(['nothing', '"Fix"', '["a","b"]', '3']);
    expect(valueWords('tasks', 'body', 'y'.repeat(300))).toBe(`"${'y'.repeat(200)}..."`);
    const now = new Date('2026-11-05T10:00:00Z');
    expect(timeWords(new Date('2026-11-03T14:02:00Z'), now)).toBe('3 Nov 14:02 UTC');
    expect(timeWords(new Date('2025-12-31T23:59:00Z'), now)).toBe('31 Dec 2025 23:59 UTC');
    expect(rangeWords(new Date('2026-11-03T14:02:00Z'), new Date('2026-11-03T15:30:00Z'), now)).toBe('14:02 to 15:30 UTC');
    expect(rangeWords(new Date('2026-11-03T23:50:00Z'), new Date('2026-11-04T00:10:00Z'), now)).toBe('3 Nov 23:50 to 4 Nov 00:10 UTC');
  });
});
