import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { applyMissingMigrations, MIGRATIONS } from '../src/db/client.js';
import { freshPglite } from './helpers-db.js';

type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type SnapshotRow = { row: Record<string, unknown> };
const mainHistory = [{ idx: 46, when: 1793700000000, tag: '0046_turn_failures' }];
const turnHistory = [
  { idx: 45, when: 1793714531704, tag: '0045_task_lookup_indexes' },
  { idx: 47, when: 1793714572653, tag: '0047_requested_prompt' },
  { idx: 49, when: 1793716912449, tag: '0049_turn_program_history' },
  { idx: 50, when: 1793727699000, tag: '0050_external_wait' },
  { idx: 51, when: 1793727700000, tag: '0051_unfinished_subscription_tails' },
  { idx: 52, when: 1793739121203, tag: '0052_dismissed_command_blocks' },
];

async function oldMigrations(history: typeof mainHistory): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'hh-migration-history-'));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  await cp(MIGRATIONS, folder, { recursive: true });
  const file = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(file, 'utf8')) as { entries: Entry[] };
  journal.entries = [
    ...journal.entries.filter(entry => Number(entry.tag.slice(0, 4)) <= 44),
    ...history.map(entry => ({ ...entry, version: '7', breakpoints: true })),
  ];
  await writeFile(file, JSON.stringify(journal));
  return folder;
}

/* New defaults and the operation id of an open wait, while retaining every preexisting field. */
function changedByLaterMigrations(table: string, rows: SnapshotRow[]): unknown[] {
  /* Migration 0125 gives no subscription an address or protocol of its own: only a compatible API, which none was, names one.
     Migration 0131 gives every plan no fallbacks of its own. */
  if (table === 'subscriptions') return rows.map(row => ({ row: { ...row.row, limits_updated_at: null, base_url: null, api_protocol: null, fallbacks: [] } }));
  /* Every head and member gets the speed skill its role lists, and everyone the machine of a built-in node, empty.
     Migration 0124 gives every card an empty inbox mode of its own, every company the inbox and every turn no inbox wake.
     The tracker's migration gives every card no nudge of its timer yet. */
  if (table === 'agents') return rows.map(({ row }) => ({ row: { ...row, original_name: null, builtin_machine: null, inbox_mode: null, timer_nudged_at: null, ...(['head', 'worker'].includes(row.kind as string) ? { skills: [...(row.skills as string[]), 'hh-work-fast'] } : {}) } }));
  /* Migration 0094 keeps the numbers the company gave: its one task, and no turn. The tracker's migration marks every
     company there before it for its one-time upgrade. Migration 0159 defaults company theme to cyberpunk. */
  if (table === 'companies') return rows.map(row => ({ row: { ...row.row, task_numbers_used: 1, turn_numbers_used: 0, inbox_mode: 'inbox', tracker_due: true, theme: 'cyberpunk' } }));
  if (table === 'jobs') return rows.map(row => ({ row: { ...row.row, builtin_machine: null, inbox_wake: false } }));
  /* The same for a part of a test run: none ran on a machine's built-in node before there were any. */
  if (table === 'test_parts') return rows.map(row => ({ row: { ...row.row, builtin_machine: null } }));
  /* Migration 0098 gives every person an empty Telegram, 0100 makes every one a person and no assistant, the deletion
     of people deletes nobody, and 0145 records no CEO's yes and no finished deletion for anyone. */
  if (table === 'people') return rows.map(row => ({ row: { ...row.row, telegram_username: null, telegram_user_id: null, is_agent: false, assistant_of: null, removed_at: null, deletion_approved_at: null, deletion_approved_by: null, deletion_completed_at: null } }));
  /* Migration 0100: nobody's assistant answered a request before. */
  if (table === 'requests') return rows.map(row => ({ row: { ...row.row, answered_by_assistant_id: null } }));
  if (table !== 'tasks') return rows;
  /* Migration 0088 removes the gate columns; the required route replaces them. Migration 0089 adds the pause, empty, and
     the tracker's migration the goal, the responsible person, the why, the due date and the pipeline, all empty, the
     tracker's first revision of the task, 0148 no priority, and 0164 no asker (these tasks have no person's request on record) and no sub-task reason. */
  const GATE_COLUMNS = ['gates', 'panel', 'stage', 'merging', 'bounces'];
  return rows.map(({ row }) => ({ row: {
    ...Object.fromEntries(Object.entries(row).filter(([column]) => !GATE_COLUMNS.includes(column))), paused: null,
    goal_id: null, responsible_person_id: null, why: '', due_at: null, pipeline_id: null, pipeline_stage_id: null, tracker_revision: 0, priority: null,
    /* Migration 0164: nobody asked for an old task on record, and no sub-task has a reason. */
    asked_by_person_id: null, subtask_reason: null,
    ...(row.external_wait ? { external_wait: { ...(row.external_wait as object), operation: expect.stringMatching(/^[0-9a-f-]{36}$/) as string } } : {}),
  } }));
}

describe('migration histories merged in turn 5', () => {
  it.each(['main', 'turn-5'] as const)('upgrades an existing %s installation with all retained rows and one record per migration', async branch => {
    const source = await freshPglite();
    onTestFinished(() => source.close());
    const oldDb = drizzle(source);
    await migrate(oldDb, { migrationsFolder: await oldMigrations(branch === 'main' ? mainHistory : turnHistory) });
    await source.exec(`
      insert into companies (id, name) values ('00000000-0000-4000-8000-000000000001', 'Retained company');
      insert into people (id, company_id, name, email, status, scope_kind)
        values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Ivan', 'ivan@example.com', 'active', 'company');
      insert into subscriptions (id, company_id, provider, kind, label, owner_person_id, status)
        values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'codex', 'personal', 'Retained plan', '00000000-0000-4000-8000-000000000002', 'ready');
      insert into agents (id, company_id, kind, name, model, subscription_id)
        values ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'worker', 'Developer', '', '00000000-0000-4000-8000-000000000003');
      insert into tasks (id, company_id, number, title, status, version)
        values ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 1, 'Retained task', 'working', 7);
      insert into jobs (id, company_id, subscription_id, agent_id, task_id, prompt, timeout_ms, status, interruption)
        values ('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003',
          '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005', 'Keep these words', 60000, 'failed',
          '{"cause":"machine","at":"2026-11-03T12:00:00Z","node":{"id":null,"name":"Machine"},"task":1,"machine":{"id":null,"name":"Machine"},"diagnosis":{"kind":"unplanned","reason":"unclean_exit","startedAt":null,"at":null,"log":"Retained exit log"}}');
      insert into agent_events (company_id, agent_id, job_id, kind, data)
        values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000006',
          'message', '{"text":"Retained words","failureCase":"retained-failure","operationsPending":"retained-alarm","silentJob":"00000000-0000-4000-8000-000000000006"}');
      insert into node_codes (code_hash, company_id, person_id, subscription_ids, command_enc, expires_at)
        values ('retained-code', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
          array['00000000-0000-4000-8000-000000000003']::uuid[], 'retained-command', '2026-11-04T12:00:00Z');
    `);
    if (branch === 'main') {
      await source.exec(`update jobs set failure = '{"kind":"network","text":"Retained failure","retryable":true}',
        not_before = '2026-11-03T12:01:00Z', restarted_at = '2026-11-03T12:00:00Z'`);
    } else {
      await source.exec(`update jobs set requested_prompt = 'Original requested words';
        update tasks set external_wait = '{"until":"2026-11-04T12:00:00Z","reason":"Retained wait"}';
        update node_codes set dismissed_subscription_ids = array['00000000-0000-4000-8000-000000000003']::uuid[];`);
    }
    const newColumns = branch === 'main'
      ? { jobs: ['requested_prompt'], tasks: ['external_wait', 'work_kind', 'risk_class', 'urgent', 'small'], node_codes: ['dismissed_subscription_ids', 'core'] }
      : { jobs: ['failure', 'not_before', 'restarted_at'], tasks: ['work_kind', 'risk_class', 'urgent', 'small'], node_codes: ['core'] };
    const tables = ['companies', 'people', 'subscriptions', 'agents', 'tasks', 'jobs', 'agent_events', 'node_codes'] as const;
    const before = await Promise.all(tables.map(table => source.query<SnapshotRow>(`select to_jsonb(r) as row from ${table} r`)));
    const recordedBefore = (await oldDb.execute(sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`)).rows;

    const copy = new PGlite({ loadDataDir: await source.dumpDataDir('none') });
    onTestFinished(() => copy.close());
    const db = drizzle(copy);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await applyMissingMigrations(db, { migrationsFolder: MIGRATIONS });

    for (const [index, table] of tables.entries()) {
      const omitted = table in newColumns ? newColumns[table as keyof typeof newColumns] : [];
      const after = await copy.query<SnapshotRow>(`select to_jsonb(r) - $1::text[] as row from ${table} r`, [omitted]);
      const expected = changedByLaterMigrations(table, before[index]!.rows);
      expect(after.rows, table).toEqual(expected);
    }
    expect((await db.execute(sql`select small from tasks`)).rows).toEqual([{ small: false }]);
    const recorded = (await db.execute(sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`)).rows;
    expect(recorded).toEqual(expect.arrayContaining(recordedBefore));
    const journal = JSON.parse(await readFile(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Entry[] };
    expect(recorded).toHaveLength(journal.entries.length);
    expect(new Set(recorded.map(row => Number(row.created_at))).size).toBe(journal.entries.length);
    expect(recorded.map(row => Number(row.created_at))).toEqual(expect.arrayContaining([
      1793700000000, 1793714531704, 1793714572653, 1793716912449, 1793727699000, 1793727700000, 1793739121203,
    ]));
    const indexes = await copy.query<{ indexname: string }>(`select indexname from pg_indexes where indexname in (
      'agent_events_failure_case', 'agent_events_operations_pending', 'agent_events_program_history', 'agent_events_silent_job',
      'tasks_turn_id', 'tasks_product_id', 'tasks_external_wait_until', 'node_codes_active_owner')`);
    expect(indexes.rows).toHaveLength(8);

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await applyMissingMigrations(db, { migrationsFolder: MIGRATIONS });
    expect((await db.execute(sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`)).rows).toEqual(recorded);
    const sourceRecorded = (await oldDb.execute(sql`select id, hash, created_at from drizzle.__drizzle_migrations order by id`)).rows;
    expect(sourceRecorded).toEqual(recordedBefore);
  });
});
