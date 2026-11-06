import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { MigrationConfig } from 'drizzle-orm/migrator';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate as migrateDrizzle } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { applyMissingMigrations, MIGRATIONS } from '../src/db/client.js';
import { hashToken } from '../src/crypto/tokens.js';
import { isUniqueViolation } from '../src/db/errors.js';
import { tasks } from '../src/db/schema.js';
import { appOn, approvalAsked, as } from './helpers.js';

async function migrate(db: PgliteDatabase, config: MigrationConfig): Promise<void> {
  await migrateDrizzle(db, config);
  await applyMissingMigrations(db, config);
}

describe('department owner and approval policy migration', () => {
  const FORWARD = '0062_pipeline_report';

  it('leaves every department without an owner and every company without rules, with nobody given anything', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo(FORWARD) });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into people (company_id, name, email, status, scope_kind, is_owner) values (${company}, 'Ivan', 'ivan@acme.example', 'active', 'company', true)`);
    const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Dana', 'dana@acme.example', 'active', 'listed') returning id`)).rows[0]!.id;
    const dept = (await db.execute<{ id: string }>(sql`insert into departments (company_id, template_key, role_code) values (${company}, 'development', 'DEV') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into person_access (company_id, person_id, department_id) values (${company}, ${person}, ${dept})`);
    const rows = async (table: string) => (await db.execute(sql.raw(`select to_jsonb(t) - 'owner_person_id' - 'repo_full_test_command' as data from ${table} t order by id`))).rows;
    const before = { departments: await rows('departments'), people: await rows('people'), access: await rows('person_access') };

    const target = await migrationsUpTo('0063_department_owner_approval_policy');
    await migrate(db, { migrationsFolder: target });
    await migrate(db, { migrationsFolder: target });

    expect({ departments: await rows('departments'), people: await rows('people'), access: await rows('person_access') }).toEqual(before);
    expect((await db.execute(sql`select owner_person_id from departments`)).rows).toEqual([{ owner_person_id: null }]);
    expect((await db.execute(sql`select count(*)::int as n from approval_policies`)).rows).toEqual([{ n: 0 }]);
  });

  it('keeps the approvals already asked as they are, and still refuses an approval that says nothing of what it approves', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo(FORWARD) });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const owner = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind, is_owner) values (${company}, 'Ivan', 'ivan@acme.example', 'active', 'company', true) returning id`)).rows[0]!.id;
    const sub = (await db.execute<{ id: string }>(sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status) values (${company}, 'codex', 'personal', 'Plan', ${owner}, 'ready') returning id`)).rows[0]!.id;
    const dept = (await db.execute<{ id: string }>(sql`insert into departments (company_id, template_key, role_code) values (${company}, 'development', 'DEV') returning id`)).rows[0]!.id;
    const agent = (await db.execute<{ id: string }>(sql`insert into agents (company_id, kind, name, department_id, model, subscription_id) values (${company}, 'worker', 'Bruno', ${dept}, '', ${sub}) returning id`)).rows[0]!.id;
    const task = (await db.execute<{ id: string }>(sql`insert into tasks (company_id, number, title, department_id, status) values (${company}, 1, 'Checkout', ${dept}, 'waiting') returning id`)).rows[0]!.id;
    const commit = 'a'.repeat(40);
    await db.execute(sql`insert into requests (company_id, task_id, agent_id, kind, text, commit, decision_topic) values (${company}, ${task}, ${agent}, 'approval', 'Merge?', ${commit}, 'release')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect((await db.execute(sql`select kind, commit, decision_topic, status, approval_channel, approval_kind, approval_amount from requests`)).rows).toEqual([
      { kind: 'approval', commit, decision_topic: 'release', status: 'open', approval_channel: null, approval_kind: null, approval_amount: null },
    ]);
    await expect(db.execute(sql`insert into requests (company_id, task_id, agent_id, kind, text) values (${company}, ${task}, ${agent}, 'approval', 'Nothing named')`)).rejects.toThrow();
    await db.execute(sql`insert into requests (company_id, task_id, agent_id, kind, text, approval_channel, approval_kind) values (${company}, ${task}, ${agent}, 'approval', 'Buy ads', 'spend', 'ads')`);
  });

  it('refuses a stored rule that would let everything through: a mode of limits with no limit', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const dept = (await db.execute<{ id: string }>(sql`insert into departments (company_id, template_key, role_code) values (${company}, 'development', 'DEV') returning id`)).rows[0]!.id;
    await expect(db.execute(sql`insert into approval_policies (company_id, department_id, channel, mode) values (${company}, ${dept}, 'spend', 'within_limits')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into approval_policies (company_id, department_id, channel, mode, limit_amount) values (${company}, ${dept}, 'spend', 'every', 5)`)).rejects.toThrow();
    await db.execute(sql`insert into approval_policies (company_id, department_id, channel, mode, limit_amount) values (${company}, ${dept}, 'spend', 'within_limits', 5)`);
  });
});

describe('limits freshness migration', () => {
  it('keeps an old limits snapshot and leaves its unknown timestamp null on upgrade', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0059_node_connections') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const owner = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Ivan', 'ivan@acme.example', 'active', 'company') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status, limits)
      values (${company}, 'antigravity', 'personal', 'Antigravity', ${owner}, 'ready', '{"status":"rejected","windows":[{"name":"five_hour","utilization":1,"resetsAt":"2026-11-03T00:53:03.947Z"}]}')`);
    const before = (await db.execute(sql`select to_jsonb(s) as data from subscriptions s`)).rows;

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect((await db.execute(sql`select to_jsonb(s) - 'limits_updated_at' as data from subscriptions s`)).rows).toEqual(before);
    expect((await db.execute(sql`select limits_updated_at from subscriptions`)).rows).toEqual([{ limits_updated_at: null }]);
  });
});

describe('notification provenance migration', () => {
  it('preserves old pending wakes and adds nullable structured provenance', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0050_external_wait') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const agent = (await db.execute<{ id: string }>(sql`insert into agents (company_id, kind, name, model) values (${company}, 'worker', 'Bruno', '') returning id`)).rows[0]!.id;
    const task = (await db.execute<{ id: string }>(sql`insert into tasks (company_id, number, title) values (${company}, 1, 'Checkout') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into pending_wakes (company_id, agent_id, task_id, why, text) values (${company}, ${agent}, ${task}, 'reported', 'Verified.')`);
    const before = (await db.execute(sql`select to_jsonb(w) as data from pending_wakes w`)).rows;
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await db.execute(sql`select to_jsonb(w) - 'cause' as data from pending_wakes w`)).rows).toEqual(before);
    expect((await db.execute(sql`select cause from pending_wakes`)).rows).toEqual([{ cause: null }]);
  });
});

describe('migration 0050', () => {
  it('adds a nullable external wait and its deadline index on a fresh database', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const columns = await db.execute(sql`select column_name, data_type, is_nullable from information_schema.columns where table_name = 'tasks'`);
    expect(columns.rows).toContainEqual({ column_name: 'external_wait', data_type: 'jsonb', is_nullable: 'YES' });
    const indexes = await db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where tablename = 'tasks' and indexname = 'tasks_external_wait_until'`);
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]!.indexdef).toContain("external_wait ->> 'until'");
    expect(indexes.rows[0]!.indexdef).toContain('WHERE (external_wait IS NOT NULL)');
  });

  it('upgrades existing tasks without changing them and defaults their wait to null', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0049_turn_program_history') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into tasks (company_id, number, title, status, silent, version)
      select ${company}, n, 'Task ' || n, 'working', 2, 7 from generate_series(1, 150) n`);
    const agent = (await db.execute<{ id: string }>(sql`insert into agents (company_id, kind, name, model) values (${company}, 'worker', 'Bruno', '') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into pending_wakes (company_id, agent_id, task_id, why, text, note)
      select ${company}, ${agent}, id, 'tests', '', '' from tasks where number = 1`);
    const before = (await db.execute(sql`select to_jsonb(t) as data from tasks t order by number`)).rows;
    const beforeWakes = (await db.execute(sql`select to_jsonb(w) as data from pending_wakes w order by id`)).rows;
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await db.execute(sql`select to_jsonb(t) - 'external_wait' - 'work_kind' - 'risk_class' as data from tasks t order by number`)).rows).toEqual(before);
    expect((await db.execute(sql`select to_jsonb(w) - 'task_version' - 'cause' as data from pending_wakes w order by id`)).rows).toEqual(beforeWakes);
    expect((await db.execute(sql`select task_version, cause from pending_wakes`)).rows).toEqual([{ task_version: null, cause: null }]);
    const rows = (await db.execute(sql`select * from tasks order by number`)).rows;
    expect(rows).toHaveLength(150);
    for (const row of rows) expect(row).toHaveProperty('external_wait', null);
  });
});

/* A copy of the migrations folder that stops after the given tag, as an older install would have it. */
async function migrationsUpTo(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hh-migrations-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await cp(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex(e => e.tag === tag);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

describe('model checks migration', () => {
  it('adds its tables empty, with nobody given anything and no row of an older database touched', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0067_request_materials') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Dana', 'dana@acme.example', 'active', 'listed') returning id`)).rows[0]!.id;
    const department = (await db.execute<{ id: string }>(sql`insert into departments (company_id, template_key, role_code) values (${company}, 'support', 'SUP') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into person_access (company_id, person_id, department_id) values (${company}, ${person}, ${department})`);
    const older = async () => Promise.all(['companies', 'people', 'departments', 'person_access'].map(async table => (await db.execute(sql.raw(`select to_jsonb(t) as row from ${table} t order by id`))).rows));
    const before = await older();

    const target = await migrationsUpTo('0068_model_checks');
    await migrate(db, { migrationsFolder: target });
    await migrate(db, { migrationsFolder: target });

    expect(await older()).toEqual(before);
    for (const table of ['model_checks', 'model_check_revisions', 'model_check_datasets', 'model_check_evaluations']) {
      expect((await db.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows, table).toEqual([{ n: 0 }]);
    }
  });
});

describe('outbound gateway migration', () => {
  /* Whatever number it ends up with. Until it exists, nothing is migrated and the tests below find no tables. */
  const gatewayTag = async () => (JSON.parse(await readFile(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] }).entries.find(entry => entry.tag.endsWith('_outbound'))?.tag ?? 'none yet';

  it('adds its tables empty, with nobody given anything and no row of two older companies touched', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0069_department_work_mode') });
    for (const name of ['Acme', 'Moonfern']) {
      const company = (await db.execute<{ id: string }>(sql`insert into companies (name, singleton) values (${name}, ${name === 'Acme'}) returning id`)).rows[0]!.id;
      const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Dana', ${`dana@${name}.example`}, 'active', 'listed') returning id`)).rows[0]!.id;
      const department = (await db.execute<{ id: string }>(sql`insert into departments (company_id, template_key, role_code, owner_person_id) values (${company}, 'sales', 'SAL', ${person}) returning id`)).rows[0]!.id;
      await db.execute(sql`insert into person_access (company_id, person_id, department_id) values (${company}, ${person}, ${department})`);
      await db.execute(sql`insert into approval_policies (company_id, department_id, channel, mode, updated_by) values (${company}, ${department}, 'message', 'every', ${person})`);
    }
    const older = async () => Promise.all(['companies', 'people', 'departments', 'person_access', 'approval_policies'].map(async table => (await db.execute(sql.raw(`select to_jsonb(t) as row from ${table} t order by id`))).rows));
    const before = await older();

    const target = await migrationsUpTo(await gatewayTag());
    await migrate(db, { migrationsFolder: target });
    await migrate(db, { migrationsFolder: target });

    expect(await older()).toEqual(before);
    const { rows } = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public' and (tablename ~ '^(outbound_|support_)' or tablename = 'model_check_certificates') order by tablename`);
    expect(rows).toHaveLength(19);
    for (const { tablename } of rows) {
      expect((await db.execute(sql.raw(`select count(*)::int as n from ${tablename}`))).rows, tablename).toEqual([{ n: 0 }]);
    }
  });

  it('leaves its guards in place when it is run again', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    const target = await migrationsUpTo(await gatewayTag());
    await migrate(db, { migrationsFolder: target });
    const guards = sql`select count(*)::int as n from pg_trigger where tgname like 'outbound_guard_%' and not tgisinternal`;
    const [{ n }] = (await db.execute<{ n: number }>(guards)).rows as [{ n: number }];
    expect(n).toBeGreaterThan(0);
    await migrate(db, { migrationsFolder: target });
    expect((await db.execute(guards)).rows).toEqual([{ n }]);
  });
});

describe('migration 0049', () => {
  it.each(['Acme', 'Moonfern'])('adds history indexes on an upgraded %s copy without changing old events', async name => {
    const source = new PGlite();
    onTestFinished(() => source.close());
    let db = drizzle(source);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0047_requested_prompt') });
    await db.execute(sql`insert into companies (id, name) values ('00000000-0000-4000-8000-000000000001', ${name})`);
    await db.execute(sql`insert into agents (company_id, kind, name, model) select id, 'worker', name, '' from companies`);
    await db.execute(sql`insert into agent_events (company_id, agent_id, kind, data)
      select a.company_id, a.id, 'message', case when n % 3 = 0 then '{}'::jsonb
        else jsonb_build_object('silentJob', null, 'text', repeat('step ', 120)) end
      from generate_series(1,30161) n cross join agents a`);
    const fingerprint = sql`select count(*)::int as n, md5(jsonb_agg(to_jsonb(e) order by seq)::text) as checksum from agent_events e`;
    const before = (await db.execute(fingerprint)).rows;
    const copy = new PGlite({ loadDataDir: await source.dumpDataDir('none') });
    onTestFinished(() => copy.close());
    db = drizzle(copy);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await db.execute(fingerprint)).rows).toEqual(before);
    expect(before[0]).toMatchObject({ n: 30161 });
    expect((await db.execute(sql`select indexname from pg_indexes where indexname in
      ('agent_events_program_history', 'agent_events_silent_job', 'tasks_turn_id', 'tasks_product_id') order by indexname`)).rows)
      .toEqual(['agent_events_program_history', 'agent_events_silent_job', 'tasks_product_id', 'tasks_turn_id'].map(indexname => ({ indexname })));
  });
});

describe('migration 0047', () => {
  it.each(['Acme', 'Moonfern'])('keeps old prompts in %s without inventing their requested text', async name => {
    const source = new PGlite();
    onTestFinished(() => source.close());
    let db = drizzle(source);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0044_ceo_delegate') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values (${name}) returning id`)).rows[0]!.id;
    const owner = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Ivan', ${`ivan@${name.toLowerCase()}.example`}, 'active', 'company') returning id`)).rows[0]!.id;
    const sub = (await db.execute<{ id: string }>(sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status) values (${company}, 'anthropic_api', 'api_key', ${name}, ${owner}, 'ready') returning id`)).rows[0]!.id;
    const agent = (await db.execute<{ id: string }>(sql`insert into agents (company_id, kind, name, model, subscription_id) values (${company}, 'worker', 'Bruno', '', ${sub}) returning id`)).rows[0]!.id;
    await db.execute(sql`insert into tasks (company_id, number, title, assignee_agent_id)
      select ${company}, n, 'Task ' || n, ${agent} from generate_series(1, 150) n`);
    await db.execute(sql`insert into task_events (company_id, task_id, kind, text)
      select ${company}, t.id, 'comment', 'Note ' || n from generate_series(1, 702) n
      join tasks t on t.number = 1 + n % 140`);
    await db.execute(sql`insert into jobs (company_id, subscription_id, agent_id, task_id, kind, prompt, timeout_ms, session_id, status)
      select ${company}, ${sub}, ${agent}, case when n % 5 = 0 then null else t.id end, 'conversation',
        case when n % 7 = 0 then '' else ${name} || ' work ' || n end, 60000,
        case when n % 3 = 0 then 'session-' || n else null end,
        (array['queued', 'running', 'done', 'failed'])[1 + n % 4]
      from generate_series(1, 857) n join tasks t on t.number = 1 + n % 150`);
    await db.execute(sql`update jobs set retry_of = (select id from jobs where prompt = ${`${name} work 1`}) where prompt = ${`${name} work 2`}`);
    await db.execute(sql`update jobs set continue_of = (select id from jobs where prompt = ${`${name} work 2`}) where prompt = ${`${name} work 3`}`);
    await db.execute(sql`insert into agent_events (company_id, agent_id, kind, data)
      select ${company}, ${agent}, 'text', jsonb_build_object('text', 'Step ' || n) from generate_series(1, 30161) n`);
    /* Both branches add nullable columns after 0044; every older field must stay identical. */
    const oldJobs = sql`select count(*)::int as n,
      md5(jsonb_agg(to_jsonb(j) - array['requested_prompt', 'failure', 'not_before', 'restarted_at'] order by id)::text) as checksum from jobs j`;
    const before = (await db.execute(oldJobs)).rows;
    /* Upgrade a copy, leaving the generated older installation intact. */
    const copy = new PGlite({ loadDataDir: await source.dumpDataDir('none') });
    onTestFinished(() => copy.close());
    db = drizzle(copy);

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect((await db.execute(oldJobs)).rows).toEqual(before);
    expect((await db.execute(sql`select count(*)::int as n from jobs
      where requested_prompt is null and failure is null and not_before is null and restarted_at is null`)).rows).toEqual([{ n: 857 }]);
    expect((await db.execute(sql`select (select count(*)::int from tasks) as tasks,
      (select count(*)::int from task_events) as task_events,
      (select count(*)::int from agent_events) as agent_events,
      (select count(*)::int from tasks t where not exists (select 1 from task_events e where e.task_id = t.id)) as without_events`)).rows)
      .toEqual([{ tasks: 150, task_events: 702, agent_events: 30161, without_events: 10 }]);
  });
});

describe('migration 0003', () => {
  it('renames the chief of an older install to the orchestrator', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0002_indexes') });

    await db.execute(sql`insert into companies (id, name) values ('00000000-0000-4000-8000-000000000001', 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind)
      values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Ivan', 'ivan@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, owner_person_id, status, target_kind)
      values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'anthropic_api', 'api_key', 'Chief',
        '00000000-0000-4000-8000-000000000002', 'ready', 'chief')`);
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, owner_person_id, status, target_kind)
      values ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'anthropic_api', 'api_key', 'Chief of staff',
        '00000000-0000-4000-8000-000000000002', 'ready', 'any')`);
    await db.execute(sql`insert into agents (company_id, kind, name, model, subscription_id)
      values ('00000000-0000-4000-8000-000000000001', 'chief', 'Chief', 'claude-opus-5-5', '00000000-0000-4000-8000-000000000003')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const agents = await db.execute<{ kind: string; name: string }>(sql`select kind, name from agents`);
    expect(agents.rows).toEqual([{ kind: 'orchestrator', name: 'Orchestrator' }]);
    const subs = await db.execute<{ label: string; target_kind: string }>(sql`select label, target_kind from subscriptions order by id`);
    expect(subs.rows).toEqual([
      { label: 'Orchestrator', target_kind: 'orchestrator' },
      { label: 'Chief of staff', target_kind: 'any' },
    ]);
  });
});

describe('migration 0005', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const DEPT = '00000000-0000-4000-8000-0000000000d1';
  const TEAM = '00000000-0000-4000-8000-0000000000e1';

  async function at0004() {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0004_conversations') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into departments (id, company_id, name, role_code) values (${DEPT}, ${C}, 'Sales', 'SAL')`);
    await db.execute(sql`insert into teams (id, company_id, department_id, name) values (${TEAM}, ${C}, ${DEPT}, 'Outbound')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind, scope_id, is_owner) values
      ('00000000-0000-4000-8000-000000000002', ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company', null, true),
      ('00000000-0000-4000-8000-000000000003', ${C}, 'Maria', 'maria@acme.com', 'active', 'department', ${DEPT}, false),
      ('00000000-0000-4000-8000-000000000004', ${C}, 'Sasha', 'sasha@acme.com', 'invited', 'team', ${TEAM}, false)`);
    return db;
  }

  it('moves single scopes into access lists', async () => {
    const db = await at0004();
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const people = await db.execute<{ name: string; scope_kind: string }>(sql`select name, scope_kind from people order by email`);
    expect(people.rows).toEqual([
      { name: 'Ivan', scope_kind: 'company' },
      { name: 'Maria', scope_kind: 'listed' },
      { name: 'Sasha', scope_kind: 'listed' },
    ]);
    const access = await db.execute<{ name: string; department_id: string | null; team_id: string | null }>(
      sql`select p.name, a.department_id, a.team_id from person_access a join people p on p.id = a.person_id order by p.email`,
    );
    expect(access.rows).toEqual([
      { name: 'Maria', department_id: DEPT, team_id: null },
      { name: 'Sasha', department_id: null, team_id: TEAM },
    ]);
  });

  it('keeps the orchestrator and his conversation', async () => {
    const db = await at0004();
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, owner_person_id, status, target_kind)
      values ('00000000-0000-4000-8000-000000000005', ${C}, 'anthropic_api', 'api_key', 'Orchestrator', '00000000-0000-4000-8000-000000000002', 'ready', 'orchestrator')`);
    await db.execute(sql`insert into agents (id, company_id, kind, name, model, subscription_id)
      values ('00000000-0000-4000-8000-000000000006', ${C}, 'orchestrator', 'Orchestrator', 'claude-opus-5-5', '00000000-0000-4000-8000-000000000005')`);
    await db.execute(sql`insert into agent_events (company_id, agent_id, kind, data) values (${C}, '00000000-0000-4000-8000-000000000006', 'text', '{"text":"Hello"}')`);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const agents = await db.execute<{ kind: string; skills: unknown; overrides: unknown; role_key: string | null }>(sql`select kind, skills, overrides, role_key from agents`);
    expect(agents.rows).toEqual([{ kind: 'orchestrator', skills: [], overrides: {}, role_key: null }]);
    expect((await db.execute(sql`select kind from agent_events`)).rows).toEqual([{ kind: 'text' }]);
  });
});

describe('migration 0007', () => {
  const C = '00000000-0000-4000-8000-000000000001';

  it('adds tasks to an older install and keeps one open turn per company', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0006_access_lists') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind)
      values ('00000000-0000-4000-8000-000000000002', ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    await db.execute(sql`insert into turns (company_id, number, goal, started_by) values (${C}, 1, 'Payments', '00000000-0000-4000-8000-000000000002')`);
    await expect(db.execute(sql`insert into turns (company_id, number, goal, started_by) values (${C}, 2, 'More', '00000000-0000-4000-8000-000000000002')`)).rejects.toThrow();
    await db.execute(sql`update turns set status = 'closed'`);
    await db.execute(sql`insert into turns (company_id, number, goal, started_by) values (${C}, 2, 'More', '00000000-0000-4000-8000-000000000002')`);
    await db.execute(sql`insert into tasks (company_id, number, title) values (${C}, 1, 'Build the payment page')`);
    await expect(db.execute(sql`insert into tasks (company_id, number, title) values (${C}, 1, 'Again')`)).rejects.toThrow();
    const cols = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'departments' and column_name like 'repo_%' order by column_name`);
    expect(cols.rows.map(r => r.column_name)).toEqual(['repo_author_email', 'repo_author_name', 'repo_branch', 'repo_full_test_command', 'repo_test_memory_gb', 'repo_token_enc', 'repo_token_last4', 'repo_url']);
  });
});

describe('migration 0011', () => {
  const C = '00000000-0000-4000-8000-000000000001';

  it('puts the reviewer of a task at a gate on its panel, also while the task waits for a person', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0010_turn_plans') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    const gates = JSON.stringify(['rita', 'sam']);
    await db.execute(sql`insert into tasks (company_id, number, title, status, stage, gates) values
      (${C}, 1, 'At gate one', 'review', 1, ${gates}::jsonb),
      (${C}, 2, 'Asking at gate two', 'waiting', 2, ${gates}::jsonb),
      (${C}, 3, 'Asking before its gates', 'waiting', 0, ${gates}::jsonb),
      (${C}, 4, 'Being done', 'working', 0, ${gates}::jsonb)`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const rows = await db.execute<{ number: number; panel: string[] }>(sql`select number, panel from tasks order by number`);
    expect(rows.rows).toEqual([
      { number: 1, panel: ['rita'] },
      { number: 2, panel: ['sam'] },
      { number: 3, panel: [] },
      { number: 4, panel: [] },
    ]);
  });
});

describe('migration 0016', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const P = '00000000-0000-4000-8000-000000000002';
  const D = '00000000-0000-4000-8000-0000000000d1';

  it("keeps the company's notes as the orchestrator's notebook and lets each department number its own", async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0015_memory_timers') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind) values (${P}, ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into notebook_notes (company_id, number, text, person_id, by_orchestrator, removed_at) values
      (${C}, 1, 'Ship on Fridays only.', ${P}, false, null),
      (${C}, 2, 'Prices in EUR.', null, true, null),
      (${C}, 3, 'Old rule.', ${P}, false, '2026-10-30T10:00:00Z')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const rows = await db.execute<{ number: number; text: string; person_id: string | null; by_orchestrator: boolean; removed: boolean; department_id: string | null; agent_id: string | null }>(
      sql`select number, text, person_id, by_orchestrator, removed_at is not null as removed, department_id, agent_id from notebook_notes order by number`,
    );
    expect(rows.rows).toEqual([
      { number: 1, text: 'Ship on Fridays only.', person_id: P, by_orchestrator: false, removed: false, department_id: null, agent_id: null },
      { number: 2, text: 'Prices in EUR.', person_id: null, by_orchestrator: true, removed: false, department_id: null, agent_id: null },
      { number: 3, text: 'Old rule.', person_id: P, by_orchestrator: false, removed: true, department_id: null, agent_id: null },
    ]);

    await db.execute(sql`insert into departments (id, company_id, name, role_code) values (${D}, ${C}, 'Sales', 'SAL')`);
    await db.execute(sql`insert into notebook_notes (company_id, department_id, number, text) values (${C}, ${D}, 1, 'Call back within a day.')`);
    const twice = (insert: Promise<unknown>) => insert.then(() => false, isUniqueViolation);
    expect(await twice(db.execute(sql`insert into notebook_notes (company_id, number, text) values (${C}, 1, 'A second note 1.')`))).toBe(true);
    expect(await twice(db.execute(sql`insert into notebook_notes (company_id, department_id, number, text) values (${C}, ${D}, 1, 'Again.')`))).toBe(true);
  });
});

describe('migration 0020', () => {
  const C = '00000000-0000-4000-8000-000000000001';

  it('takes the threat model off the red team and leaves it with security', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0019_agent_event_jobs') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    const red = JSON.stringify(['hh-task-flow', 'dev-adversarial', 'dev-threat-model']);
    const sec = JSON.stringify(['hh-task-flow', 'dev-security-review', 'dev-threat-model']);
    await db.execute(sql`insert into agents (company_id, kind, name, model, role_key, skills) values
      (${C}, 'worker', 'Red team', '', 'DEV-RED', ${red}::jsonb),
      (${C}, 'worker', 'Security engineer', '', 'DEV-SEC', ${sec}::jsonb)`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const rows = await db.execute<{ name: string; skills: string[] }>(sql`select name, skills from agents order by name`);
    expect(rows.rows).toEqual([
      { name: 'Red team', skills: ['hh-task-flow', 'dev-adversarial'] },
      { name: 'Security engineer', skills: ['hh-task-flow', 'dev-security-review', 'dev-threat-model'] },
    ]);
  });
});

describe('migration 0023', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const D = '00000000-0000-4000-8000-0000000000d1';

  it('keeps the oldest of two heads of one department, and of two orchestrators, as an older race could leave them', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0022_pending_wakes') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into departments (id, company_id, name, role_code) values (${D}, ${C}, 'Sales', 'SAL')`);
    await db.execute(sql`insert into agents (company_id, department_id, kind, name, model, created_at) values
      (${C}, ${D}, 'head', 'Hana', '', '2026-10-30T10:00:00Z'),
      (${C}, ${D}, 'head', 'Hugo', '', '2026-10-30T10:00:01Z'),
      (${C}, null, 'orchestrator', 'Orchestrator', '', '2026-10-29T10:00:00Z'),
      (${C}, null, 'orchestrator', 'Orchestrator', '', '2026-10-29T10:00:01Z')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const live = await db.execute<{ name: string; kind: string }>(sql`select name, kind from agents where removed_at is null order by kind, created_at`);
    expect(live.rows).toEqual([
      { name: 'Hana', kind: 'head' },
      { name: 'Orchestrator', kind: 'orchestrator' },
    ]);
  });
});

describe('migration 0024', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const P = '00000000-0000-4000-8000-000000000002';
  const KEY = '00000000-0000-4000-8000-0000000000a1';
  const PLAN = '00000000-0000-4000-8000-0000000000a2';
  const A = '00000000-0000-4000-8000-0000000000b1';

  it("starts the agents of company keys in new sessions, as the built-in node keeps their homes apart now", async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0023_impossible_rows') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind) values (${P}, ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, status, owner_person_id) values
      (${KEY}, ${C}, 'anthropic_api', 'api_key', 'Key', 'ready', ${P}),
      (${PLAN}, ${C}, 'claude', 'personal', 'Claude', 'ready', ${P})`);
    await db.execute(sql`insert into agents (id, company_id, kind, name, model) values (${A}, ${C}, 'worker', 'Bruno', '')`);
    await db.execute(sql`insert into jobs (company_id, subscription_id, agent_id, kind, prompt, timeout_ms, status, session_id) values
      (${C}, ${KEY}, ${A}, 'conversation', 'hi', 900000, 'done', 'key-session'),
      (${C}, ${PLAN}, ${A}, 'conversation', 'hi', 900000, 'done', 'plan-session')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const rows = await db.execute<{ subscription_id: string; session_id: string | null }>(sql`select subscription_id, session_id from jobs order by subscription_id`);
    expect(rows.rows).toEqual([
      { subscription_id: KEY, session_id: null },
      { subscription_id: PLAN, session_id: 'plan-session' },
    ]);
  });
});

describe('migration 0031', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const P = '00000000-0000-4000-8000-000000000002';

  it('lends the machines of an older install to test runs, and its repositories need the default memory', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0030_job_answers_ceo') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind) values (${P}, ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into machines (company_id, person_id, machine_key, hostname) values (${C}, ${P}, 'mac-0001-abcd', 'ivan-mac')`);
    await db.execute(sql`insert into departments (company_id, role_code, repo_url) values (${C}, 'DEV', 'https://github.com/acme/shop.git')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect((await db.execute<{ lends_tests: boolean }>(sql`select lends_tests from machines`)).rows).toEqual([{ lends_tests: true }]);
    expect((await db.execute<{ repo_test_memory_gb: number | null }>(sql`select repo_test_memory_gb from departments`)).rows).toEqual([{ repo_test_memory_gb: null }]);
    expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from test_runs`)).rows).toEqual([{ n: 0 }]);
  });
});

describe('migration 0033', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const P = '00000000-0000-4000-8000-000000000002';
  const M = '00000000-0000-4000-8000-0000000000c1';
  const PLAN = '00000000-0000-4000-8000-0000000000a2';
  const WAITING = '00000000-0000-4000-8000-0000000000a3';
  const KEY = '00000000-0000-4000-8000-0000000000a1';
  const A = '00000000-0000-4000-8000-0000000000b1';
  const B = '00000000-0000-4000-8000-0000000000b2';
  const J = '00000000-0000-4000-8000-0000000000d1';
  const T = '00000000-0000-4000-8000-0000000000e1';
  const R = '00000000-0000-4000-8000-0000000000f1';

  it("gives each plan's machine a node of its own, with the plan's id, key and state, and puts its jobs and agents on it", async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0032_company_template') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind) values (${P}, ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into machines (id, company_id, person_id, machine_key, hostname) values (${M}, ${C}, ${P}, 'mac-0001-abcd', 'ivan-mac')`);
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, status, owner_person_id, machine_id, node_key_hash, node_version, last_seen_at) values
      (${PLAN}, ${C}, 'claude', 'personal', 'Claude', 'ready', ${P}, ${M}, 'hash-of-key', '0.9.0', '2026-10-30T10:00:00Z'),
      (${WAITING}, ${C}, 'codex', 'personal', 'Codex', 'waiting_machine', ${P}, null, null, null, null),
      (${KEY}, ${C}, 'anthropic_api', 'api_key', 'Key', 'ready', ${P}, null, null, null, null)`);
    await db.execute(sql`insert into agents (id, company_id, kind, name, model, subscription_id) values
      (${A}, ${C}, 'worker', 'Bruno', '', ${PLAN}), (${B}, ${C}, 'worker', 'Vera', '', ${KEY})`);
    await db.execute(sql`insert into jobs (id, company_id, subscription_id, agent_id, kind, prompt, timeout_ms, status) values
      (${J}, ${C}, ${PLAN}, ${A}, 'conversation', 'hi', 900000, 'running'), (gen_random_uuid(), ${C}, ${KEY}, ${B}, 'conversation', 'hi', 900000, 'running')`);
    await db.execute(sql`insert into tasks (id, company_id, number, title) values (${T}, ${C}, 1, 'Checkout API')`);
    await db.execute(sql`insert into test_runs (id, company_id, number, task_id, agent_id, job_id, command, timeout_ms) values (${R}, ${C}, 1, ${T}, ${A}, ${J}, 'npm test', 1800000)`);
    await db.execute(sql`insert into test_parts (company_id, run_id, part, status, subscription_id, machine_id) values (${C}, ${R}, 1, 'running', ${PLAN}, ${M}), (${C}, ${R}, 2, 'queued', null, null)`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const nodes = await db.execute(sql`select id, company_id, machine_id, subscription_id, key_hash, status, version, last_seen_at from nodes`);
    expect(nodes.rows).toEqual([
      { id: PLAN, company_id: C, machine_id: M, subscription_id: PLAN, key_hash: 'hash-of-key', status: 'ready', version: '0.9.0', last_seen_at: expect.anything() },
    ]);
    const agents = await db.execute(sql`select name, node_id from agents order by name`);
    expect(agents.rows).toEqual([{ name: 'Bruno', node_id: PLAN }, { name: 'Vera', node_id: null }]);
    const jobs = await db.execute(sql`select subscription_id, node_id from jobs order by subscription_id`);
    expect(jobs.rows).toEqual([{ subscription_id: KEY, node_id: null }, { subscription_id: PLAN, node_id: PLAN }]);
    const parts = await db.execute(sql`select part, node_id from test_parts order by part`);
    expect(parts.rows).toEqual([{ part: 1, node_id: PLAN }, { part: 2, node_id: null }]);
    const gone = await db.execute(sql`select table_name, column_name from information_schema.columns where (table_name = 'subscriptions' and column_name in ('machine_id', 'node_key_hash', 'node_version', 'last_seen_at')) or (table_name = 'test_parts' and column_name = 'subscription_id')`);
    expect(gone.rows).toEqual([]);
  });

  it('hides the code of every machine command in the conversations it was written to', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0032_company_template') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into agents (id, company_id, kind, name, model) values (${A}, ${C}, 'orchestrator', 'Orchestrator', '')`);
    const command = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join Ab3_x-9Zq';
    await db.execute(sql`insert into agent_events (company_id, agent_id, kind, data) values
      (${C}, ${A}, 'tool_result', ${JSON.stringify({ text: `{"command":"${command}"}` })}::jsonb),
      (${C}, ${A}, 'text', ${JSON.stringify({ text: `Run this:\n${command}\nthen tell me.` })}::jsonb),
      (${C}, ${A}, 'text', ${JSON.stringify({ text: 'Add --joined to the list.' })}::jsonb)`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const events = await db.execute<{ data: { text: string } }>(sql`select data from agent_events order by seq`);
    const hidden = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join [hidden]';
    expect(events.rows.map(r => r.data.text)).toEqual([`{"command":"${hidden}"}`, `Run this:\n${hidden}\nthen tell me.`, 'Add --joined to the list.']);
  });
});

describe('migrations 0034 to 0037', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const P = '00000000-0000-4000-8000-000000000002';
  const A = '00000000-0000-4000-8000-0000000000b1';
  const T = '00000000-0000-4000-8000-0000000000d1';
  const R = '00000000-0000-4000-8000-0000000000e1';
  const S = '00000000-0000-4000-8000-0000000000c1';

  it('keeps how long an older part waits and that it ran nowhere before, older runs as test runs and older machines as computers', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0033_nodes') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind) values (${P}, ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, status, owner_person_id) values (${S}, ${C}, 'claude', 'personal', 'Claude', 'ready', ${P})`);
    await db.execute(sql`insert into agents (id, company_id, kind, name, model) values (${A}, ${C}, 'worker', 'Bruno', '')`);
    await db.execute(sql`insert into jobs (company_id, subscription_id, agent_id, kind, prompt, timeout_ms) values (${C}, ${S}, ${A}, 'conversation', 'hi', 900000)`);
    const [job] = (await db.execute<{ id: string }>(sql`select id from jobs`)).rows;
    await db.execute(sql`insert into tasks (id, company_id, number, title) values (${T}, ${C}, 1, 'Checkout')`);
    await db.execute(sql`insert into test_runs (id, company_id, number, task_id, agent_id, job_id, command, timeout_ms) values (${R}, ${C}, 1, ${T}, ${A}, ${job!.id}, 'npm test', 60000)`);
    await db.execute(sql`insert into test_parts (company_id, run_id, part, created_at) values (${C}, ${R}, 1, '2026-10-30T10:00:00Z')`);
    await db.execute(sql`insert into machines (company_id, person_id, machine_key, hostname) values (${C}, ${P}, 'mac-0001-abcd', 'ivan-mac')`);

    await migrate(db, { migrationsFolder: await migrationsUpTo('0037_work_repeatable') });
    await migrate(db, { migrationsFolder: await migrationsUpTo('0040_decision_topic') });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    const parts = await db.execute<{ waits: boolean; lost: unknown; computer: string | null }>(sql`select queued_at = created_at as waits, lost, computer from test_parts`);
    expect(parts.rows).toEqual([{ waits: true, lost: [], computer: null }]);
    const runs = await db.execute(sql`select kind, files, memory_gb, repeatable from test_runs`);
    expect(runs.rows).toEqual([{ kind: 'tests', files: [], memory_gb: null, repeatable: false }]);
    const kinds = await db.execute(sql`select kind from machines`);
    expect(kinds.rows).toEqual([{ kind: 'computer' }]);
  });
});

describe('migration 0038', () => {
  it("gives an older install's plans no sign-in yet and its nodes no key", async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0037_work_repeatable') });
    const C = '00000000-0000-4000-8000-000000000001';
    const P = '00000000-0000-4000-8000-000000000002';
    const S = '00000000-0000-4000-8000-0000000000c1';
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind) values (${P}, ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, status, owner_person_id) values (${S}, ${C}, 'claude', 'personal', 'Claude', 'ready', ${P})`);
    await db.execute(sql`insert into machines (id, company_id, person_id, machine_key, hostname) values (${S}, ${C}, ${P}, 'mac-0001-abcd', 'ivan-mac')`);
    await db.execute(sql`insert into nodes (id, company_id, machine_id, subscription_id, status) values (${S}, ${C}, ${S}, ${S}, 'ready')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect((await db.execute(sql`select cred_version, lease_node_id from subscriptions`)).rows).toEqual([{ cred_version: 0, lease_node_id: null }]);
    expect((await db.execute(sql`select public_key, account from nodes`)).rows).toEqual([{ public_key: null, account: null }]);
    expect((await db.execute(sql`select count(*)::int as n from plan_credentials`)).rows).toEqual([{ n: 0 }]);
  });
});

describe('migration 0039', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const H = '00000000-0000-4000-8000-0000000000b1';
  const W = '00000000-0000-4000-8000-0000000000b2';
  const T = '00000000-0000-4000-8000-0000000000d1';

  it('starts the lines of an older install with no result given back, and refuses a return without its cycle', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0038_plan_credentials') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into agents (id, company_id, kind, name, model) values (${H}, ${C}, 'head', 'Hana', ''), (${W}, ${C}, 'worker', 'Bruno', '')`);
    await db.execute(sql`insert into tasks (id, company_id, number, title, status, closed_at) values (${T}, ${C}, 1, 'Checkout', 'done', now())`);
    await db.execute(sql`insert into task_events (company_id, task_id, kind, agent_id, text) values (${C}, ${T}, 'submitted', ${W}, 'Done')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    /* Earlier hand-ins are not lit as returns: the map starts without any. */
    expect((await db.execute(sql`select * from map_returns`)).rows).toEqual([]);
    expect((await db.execute(sql`select kind, text from task_events`)).rows).toEqual([{ kind: 'submitted', text: 'Done' }]);
    await db.execute(sql`insert into map_returns (company_id, upstream_agent_id, downstream_agent_id) values (${C}, ${H}, ${W})`);
    expect((await db.execute(sql`select work_epoch, returned_epoch, returned_at from map_returns`)).rows).toEqual([{ work_epoch: 0, returned_epoch: null, returned_at: null }]);
    await expect(db.execute(sql`update map_returns set returned_at = now(), source_key = 'task:1'`)).rejects.toThrow();
    await expect(db.execute(sql`update map_returns set returned_epoch = 1, returned_at = now(), source_key = 'task:1'`)).rejects.toThrow();
    await expect(db.execute(sql`insert into map_returns (company_id, upstream_agent_id, downstream_agent_id) values (${C}, ${H}, ${W})`)).rejects.toThrow();
  });
});

describe('migration 0040', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const W = '00000000-0000-4000-8000-0000000000b2';
  const T = '00000000-0000-4000-8000-0000000000d1';

  it('keeps older requests with their answers and no topic, which gives them to the CEO', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0039_map_returns') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into agents (id, company_id, kind, name, model) values (${W}, ${C}, 'worker', 'Bruno', '')`);
    await db.execute(sql`insert into tasks (id, company_id, number, title, status) values (${T}, ${C}, 1, 'Checkout', 'waiting')`);
    await db.execute(sql`insert into requests (company_id, task_id, agent_id, kind, text, status) values (${C}, ${T}, ${W}, 'question', 'Which cards?', 'open')`);
    await db.execute(sql`insert into requests (company_id, task_id, agent_id, kind, text, status, answer) values (${C}, ${T}, ${W}, 'question', 'Which banks?', 'answered', 'Any.')`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const rows = await db.execute(sql`select text, status, answer, decision_topic from requests order by text`);
    expect(rows.rows).toEqual([
      { text: 'Which banks?', status: 'answered', answer: 'Any.', decision_topic: null },
      { text: 'Which cards?', status: 'open', answer: null, decision_topic: null },
    ]);
  });
});

describe('migration 0044', () => {
  const C = '00000000-0000-4000-8000-000000000001';

  it('marks nobody the CEO delegate, so people who see the whole company take no decision only the CEO takes until the CEO marks one', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0043_turn_exits') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    const person = async (name: string, status: string, scope: string, owner: boolean) =>
      (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind, is_owner) values (${C}, ${name}, ${`${name.toLowerCase()}@acme.com`}, ${status}, ${scope}, ${owner}) returning id`)).rows[0]!.id;
    const ivan = await person('Ivan', 'active', 'company', true);
    const david = await person('David', 'active', 'company', false);
    const zoe = await person('Zoe', 'active', 'company', false);
    await person('Dana', 'active', 'listed', false);
    await person('Ilya', 'invited', 'company', false);
    await person('Olga', 'disabled', 'company', false);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect.soft((await db.execute(sql`select name, is_owner, is_ceo_delegate from people order by name`)).rows).toEqual([
      { name: 'Dana', is_owner: false, is_ceo_delegate: false },
      { name: 'David', is_owner: false, is_ceo_delegate: false },
      { name: 'Ilya', is_owner: false, is_ceo_delegate: false },
      { name: 'Ivan', is_owner: true, is_ceo_delegate: false },
      { name: 'Olga', is_owner: false, is_ceo_delegate: false },
      { name: 'Zoe', is_owner: false, is_ceo_delegate: false },
    ]);
    await db.execute(sql`insert into people (company_id, name, email, status, scope_kind) values (${C}, 'Nina', 'nina@acme.com', 'active', 'company')`);
    expect((await db.execute(sql`select is_ceo_delegate from people where name = 'Nina'`)).rows).toEqual([{ is_ceo_delegate: false }]);
    expect((await db.execute(sql`select decision_input_pending from jobs`)).rows).toEqual([]);
    expect((await db.execute(sql`select answered_by_agent_id, answer_job_id, answer_source_seq from requests`)).rows).toEqual([]);

    /* The upgraded install at work: a merge only the CEO approves waits, and only the CEO may approve it. */
    const { app } = await appOn(client);
    const plan = (await db.execute<{ id: string }>(sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status) values (${C}, 'claude', 'personal', 'Ivan', ${ivan}, 'waiting_machine') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into agents (company_id, kind, name, model, subscription_id) values (${C}, 'orchestrator', 'Orchestrator', '', ${plan})`);
    const request = await approvalAsked(app);
    const signedIn = async (personId: string) => {
      const token = `session-of-${personId}`;
      await db.execute(sql`insert into sessions (token_hash, person_id, expires_at) values (${hashToken(token)}, ${personId}, now() + interval '1 day')`);
      return token;
    };
    const approve = async (personId: string) => app.inject({ method: 'POST', url: `/api/requests/${request.id}`, payload: { approve: true }, ...as(await signedIn(personId)) });
    for (const id of [david, zoe]) {
      const refused = await approve(id);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.reason).toBe('decision_not_allowed');
    }
    expect((await db.execute(sql`select status from requests`)).rows).toEqual([{ status: 'open' }]);
    expect((await approve(ivan)).statusCode).toBe(200);
    expect((await db.execute(sql`select status, answered_by from requests`)).rows).toEqual([{ status: 'approved', answered_by: ivan }]);
  });
});

describe('migration 0045', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const D = '00000000-0000-4000-8000-000000000002';
  const TURN = '10000000-0000-4000-8000-000000000001';
  const PRODUCT = '20000000-0000-4000-8000-000000000001';

  it('keeps the turn and product indexes in the schema for future migrations', () => {
    const indexes = getTableConfig(tasks).indexes.map(i => ({ name: i.config.name, columns: i.config.columns }));
    expect(indexes).toEqual(expect.arrayContaining([
      { name: 'tasks_turn_id', columns: [expect.objectContaining({ name: 'turn_id' })] },
      { name: 'tasks_product_id', columns: [expect.objectContaining({ name: 'product_id' })] },
    ]));
  });

  it('creates both indexes on a fresh install', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });

    const indexes = await db.execute(sql`select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'tasks' and indexname in ('tasks_turn_id', 'tasks_product_id') order by indexname`);
    expect(indexes.rows).toEqual([
      { indexname: 'tasks_product_id', indexdef: 'CREATE INDEX tasks_product_id ON public.tasks USING btree (product_id)' },
      { indexname: 'tasks_turn_id', indexdef: 'CREATE INDEX tasks_turn_id ON public.tasks USING btree (turn_id)' },
    ]);
  });

  it('upgrades existing tasks intact and uses the indexes for turn and product reads', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0044_ceo_delegate') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into departments (id, company_id, name, role_code) values (${D}, ${C}, 'Development', 'DEV')`);
    await db.execute(sql`insert into turns (id, company_id, number, goal, status)
      select ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ${C}, n, 'Earlier turn', 'closed' from generate_series(1, 100) n`);
    await db.execute(sql`insert into departments (id, company_id, parent_id, name, role_code)
      select ('20000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ${C}, ${D}, 'Product ' || n, 'DEV' from generate_series(1, 100) n`);
    await db.execute(sql`insert into tasks (company_id, department_id, number, title, turn_id, product_id)
      select ${C}, ${D}, n, 'Task ' || n,
        ('10000000-0000-4000-8000-' || lpad((1 + n % 100)::text, 12, '0'))::uuid,
        ('20000000-0000-4000-8000-' || lpad((1 + n % 100)::text, 12, '0'))::uuid
      from generate_series(1, 20000) n`);
    await db.execute(sql`insert into tasks (company_id, number, title) values (${C}, 20001, 'No turn or product')`);
    /* Migrations 0050 and 0062 check their new nullable fields separately; every earlier field must stay identical. */
    const fingerprint = sql`select count(*)::int as n, md5(string_agg((to_jsonb(t) - 'external_wait' - 'work_kind' - 'risk_class')::text, '' order by number)) as checksum from tasks t`;
    const before = await db.execute(fingerprint);
    expect(before.rows[0]).toMatchObject({ n: 20001 });

    const started = performance.now();
    await migrate(db, { migrationsFolder: MIGRATIONS });
    console.info(`Migration 0045 on 20001 tasks: ${(performance.now() - started).toFixed(1)} ms`);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await db.execute(fingerprint)).rows).toEqual(before.rows);
    await db.execute(sql`analyze tasks`);

    const turn = await db.execute<{ 'QUERY PLAN': string }>(sql`explain select * from tasks
      where company_id = ${C} and turn_id = ${TURN} order by number`);
    const product = await db.execute<{ 'QUERY PLAN': string }>(sql`explain select * from tasks
      where company_id = ${C} and department_id = ${D} and product_id in (${PRODUCT})`);
    const turnPlan = turn.rows.map(r => r['QUERY PLAN']).join('\n');
    const productPlan = product.rows.map(r => r['QUERY PLAN']).join('\n');
    console.info(`Turn tasks:\n${turnPlan}\nProduct tasks:\n${productPlan}`);
    expect(turnPlan).toContain('Index Scan on tasks_turn_id');
    expect(productPlan).toContain('Index Scan on tasks_product_id');
    expect((await db.execute(sql`select count(*)::int as n from tasks where turn_id = ${TURN}`)).rows).toEqual([{ n: 200 }]);
    expect((await db.execute(sql`select count(*)::int as n from tasks where product_id = ${PRODUCT}`)).rows).toEqual([{ n: 200 }]);
  });
});

describe('migration 0051', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const P = '00000000-0000-4000-8000-000000000002';
  const M = '991d4eb4-0000-4000-8000-000000000003';
  const TASK = '00000000-0000-4000-8000-000000000004';
  const AGENT = '00000000-0000-4000-8000-000000000005';
  const JOB = '00000000-0000-4000-8000-000000000006';
  const RUN = '00000000-0000-4000-8000-000000000007';
  const TAIL = '1f6db355-484e-4c57-b516-ca0c2fa8be3e';
  const LIVE = '606af686-0000-4000-8000-000000000001';
  const CLAUDE_WITH_AGENT = '00000000-0000-4000-8000-000000000011';
  const CLAUDE_READY = '00000000-0000-4000-8000-000000000012';
  const KIMI_WAITING = '00000000-0000-4000-8000-000000000013';
  const GLM_WITH_NODE_RUN = '00000000-0000-4000-8000-000000000014';
  const GLM_READY = '00000000-0000-4000-8000-000000000015';
  const ALICE = '00000000-0000-4000-8000-000000000022';
  const ALICE_WAITING = '00000000-0000-4000-8000-000000000016';

  it('passes on a fresh install and removes unfinished waiting_machine tails on a machine with test runs while keeping ready, agent-assigned, node-run and another owner subscriptions', async () => {
    const freshClient = new PGlite();
    onTestFinished(() => freshClient.close());
    const freshDb = drizzle(freshClient);
    await migrate(freshDb, { migrationsFolder: MIGRATIONS });

    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0047_requested_prompt') });

    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind) values
      (${P}, ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company'),
      (${ALICE}, ${C}, 'Alice', 'alice@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into machines (id, company_id, person_id, machine_key, hostname) values (${M}, ${C}, ${P}, 'mac-0001-abcd', 'ivan-mac')`);

    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, status, owner_person_id, removed_at, created_at) values
      (${ALICE_WAITING}, ${C}, 'codex', 'personal', 'Codex', 'waiting_machine', ${ALICE}, null, '2026-11-02T12:30:00Z'),
      (${TAIL}, ${C}, 'codex', 'personal', 'Codex', 'waiting_machine', ${P}, '2026-11-02T14:58:09Z', '2026-11-02T13:59:58Z'),
      (${LIVE}, ${C}, 'codex', 'personal', 'Codex', 'ready', ${P}, null, '2026-11-02T14:58:12Z'),
      (${CLAUDE_WITH_AGENT}, ${C}, 'claude', 'personal', 'Claude', 'waiting_machine', ${P}, null, '2026-11-02T13:00:00Z'),
      (${CLAUDE_READY}, ${C}, 'claude', 'personal', 'Claude', 'ready', ${P}, null, '2026-11-02T14:00:00Z'),
      (${GLM_WITH_NODE_RUN}, ${C}, 'glm', 'personal', 'GLM', 'waiting_machine', ${P}, null, '2026-11-02T13:30:00Z'),
      (${GLM_READY}, ${C}, 'glm', 'personal', 'GLM', 'ready', ${P}, null, '2026-11-02T14:30:00Z'),
      (${KIMI_WAITING}, ${C}, 'kimi', 'personal', 'Kimi', 'waiting_machine', ${P}, null, '2026-11-02T15:00:00Z')`);

    await db.execute(sql`insert into nodes (id, company_id, machine_id, subscription_id, key_hash, status, last_seen_at) values
      (${ALICE_WAITING}, ${C}, ${M}, ${ALICE_WAITING}, 'alice-codex-hash', 'needs_login', '2026-11-02T12:31:00Z'),
      (${TAIL}, ${C}, ${M}, ${TAIL}, null, 'ready', '2026-11-02T14:58:09Z'),
      (${LIVE}, ${C}, ${M}, ${LIVE}, 'live-codex-hash', 'ready', '2026-11-03T16:00:00Z'),
      (${CLAUDE_READY}, ${C}, ${M}, ${CLAUDE_READY}, 'claude-ready-hash', 'ready', '2026-11-03T16:00:00Z'),
      (${GLM_WITH_NODE_RUN}, ${C}, ${M}, ${GLM_WITH_NODE_RUN}, null, 'needs_login', '2026-11-02T13:45:00Z'),
      (${GLM_READY}, ${C}, ${M}, ${GLM_READY}, 'glm-ready-hash', 'ready', '2026-11-03T16:00:00Z')`);
    await db.execute(sql`insert into plan_credentials (subscription_id, company_id, node_id, kind, version, sealed) values
      (${ALICE_WAITING}, ${C}, ${ALICE_WAITING}, 'token', 1, 'alice-bundle'),
      (${TAIL}, ${C}, ${TAIL}, 'token', 1, 'tail-bundle')`);

    for (let i = 1; i <= 8; i++) {
      await db.execute(sql`insert into agents (company_id, kind, name, model, subscription_id, node_id) values (${C}, 'worker', ${`Agent ${i}`}, '', ${LIVE}, ${LIVE})`);
    }
    await db.execute(sql`insert into agents (id, company_id, kind, name, model, subscription_id) values (${AGENT}, ${C}, 'worker', 'Claude Agent', '', ${CLAUDE_WITH_AGENT})`);
    await db.execute(sql`insert into tasks (id, company_id, number, title) values (${TASK}, ${C}, 1, 'Verify test parts on Mac')`);
    await db.execute(sql`insert into jobs (id, company_id, subscription_id, agent_id, prompt, timeout_ms, status, kind) values (${JOB}, ${C}, ${CLAUDE_READY}, ${AGENT}, 'Run tests', 60000, 'done', 'conversation')`);
    await db.execute(sql`insert into test_runs (id, company_id, number, task_id, agent_id, job_id, command, parts, timeout_ms, status) values (${RUN}, ${C}, 1, ${TASK}, ${AGENT}, ${JOB}, 'npm test', 17, 60000, 'passed')`);
    for (let part = 1; part <= 16; part++) {
      await db.execute(sql`insert into test_parts (company_id, run_id, part, status, node_id, machine_id) values (${C}, ${RUN}, ${part}, 'passed', ${CLAUDE_READY}, ${M})`);
    }
    await db.execute(sql`insert into test_parts (company_id, run_id, part, status, node_id, machine_id) values (${C}, ${RUN}, 17, 'passed', ${GLM_WITH_NODE_RUN}, ${M})`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const codexSubs = await db.execute<{ id: string }>(sql`select id from subscriptions where provider = 'codex' order by created_at`);
    expect(codexSubs.rows).toEqual([{ id: ALICE_WAITING }, { id: LIVE }]);
    const codexNodes = await db.execute<{ id: string }>(sql`select id from nodes where subscription_id in (${ALICE_WAITING}, ${TAIL}, ${LIVE}) order by subscription_id`);
    expect(codexNodes.rows).toEqual([{ id: ALICE_WAITING }, { id: LIVE }]);
    const codexCreds = await db.execute<{ subscription_id: string }>(sql`select subscription_id from plan_credentials order by subscription_id`);
    expect(codexCreds.rows).toEqual([{ subscription_id: ALICE_WAITING }]);

    const keptSubs = await db.execute<{ id: string }>(sql`select id from subscriptions order by created_at`);
    expect(keptSubs.rows).toEqual([
      { id: ALICE_WAITING },
      { id: CLAUDE_WITH_AGENT },
      { id: GLM_WITH_NODE_RUN },
      { id: CLAUDE_READY },
      { id: GLM_READY },
      { id: LIVE },
      { id: KIMI_WAITING },
    ]);
    const glmPart = await db.execute<{ node_id: string | null }>(sql`select node_id from test_parts where run_id = ${RUN} and part = 17`);
    expect(glmPart.rows).toEqual([{ node_id: GLM_WITH_NODE_RUN }]);
  });
});

describe('migration 0052', () => {
  it('keeps old sealed install commands usable and defaults dismissed plan blocks to an empty list', async () => {
    const source = new PGlite();
    onTestFinished(() => source.close());
    let db = drizzle(source);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0051_unfinished_subscription_tails') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Demo') returning id`)).rows[0]!.id;
    const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, title, scope_kind, status) values (${company}, 'Demo', 'demo@example.test', 'CEO', 'company', 'active') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into node_codes (code_hash, company_id, person_id, subscription_ids, command_enc, expires_at, used_at)
      select md5(n::text), ${company}, ${person}, '{}'::uuid[], 'sealed-demo-' || n, now() + interval '24 hours', case when n = 2 then now() end from generate_series(1,3) n`);
    const before = (await db.execute(sql`select to_jsonb(c) as data from node_codes c order by code_hash`)).rows;
    const copy = new PGlite({ loadDataDir: await source.dumpDataDir('none') });
    onTestFinished(() => copy.close());
    db = drizzle(copy);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await db.execute(sql`select to_jsonb(c) - 'dismissed_subscription_ids' as data from node_codes c order by code_hash`)).rows).toEqual(before);
    expect((await db.execute(sql`select dismissed_subscription_ids from node_codes`)).rows).toEqual(Array.from({ length: 3 }, () => ({ dismissed_subscription_ids: [] })));
  });
});

describe('migration 0053', () => {
  it('creates the person rename journal and its indexes on a fresh install', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const columns = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'person_changes' order by column_name`);
    expect(columns.rows.map(row => row.column_name)).toEqual(['actor_id', 'after', 'before', 'company_id', 'created_at', 'field', 'id', 'person_id']);
    const indexes = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'person_changes' order by indexname`);
    expect(indexes.rows).toEqual([{ indexname: 'person_changes_company_id' }, { indexname: 'person_changes_person_id' }, { indexname: 'person_changes_pkey' }]);
  });

  it('upgrades existing people intact, keeps the actor when a different person is deleted and cascades with the company', async () => {
    const source = new PGlite();
    onTestFinished(() => source.close());
    let db = drizzle(source);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0052_dismissed_command_blocks') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Demo') returning id`)).rows[0]!.id;
    const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Lisa', 'lisa@example.test', 'active', 'listed') returning id`)).rows[0]!.id;
    const actor = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Author', 'author@example.test', 'active', 'listed') returning id`)).rows[0]!.id;
    const before = (await db.execute(sql`select to_jsonb(p) as data from people p order by id`)).rows;
    const copy = new PGlite({ loadDataDir: await source.dumpDataDir('none') });
    onTestFinished(() => copy.close());
    db = drizzle(copy);

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect((await db.execute(sql`select to_jsonb(p) as data from people p order by id`)).rows).toEqual(before);
    await db.execute(sql`insert into person_changes (company_id, person_id, actor_id, field, before, after) values (${company}, ${person}, ${actor}, 'name', 'Lisa', 'Lisa Ray')`);
    await db.execute(sql`delete from people where id = ${actor}`);
    expect((await db.execute(sql`select actor_id, before, after from person_changes`)).rows).toEqual([{ actor_id: null, before: 'Lisa', after: 'Lisa Ray' }]);
    await db.execute(sql`delete from people where id = ${person}`);
    await db.execute(sql`delete from companies where id = ${company}`);
    expect((await db.execute(sql`select count(*)::int as n from person_changes`)).rows).toEqual([{ n: 0 }]);
  });
});

describe('migration 0056', () => {
  it('makes only unstarted stale wakes obsolete', async () => {
    const source = new PGlite();
    onTestFinished(() => source.close());
    let db = drizzle(source);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0053_person_changes') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Demo') returning id`)).rows[0]!.id;
    const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Owner', 'owner@example.test', 'active', 'company') returning id`)).rows[0]!.id;
    const sub = (await db.execute<{ id: string }>(sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status) values (${company}, 'anthropic_api', 'api_key', 'Key', ${person}, 'ready') returning id`)).rows[0]!.id;
    const machine = (await db.execute<{ id: string }>(sql`insert into machines (company_id, person_id, machine_key, hostname) values (${company}, ${person}, 'build-key', 'build-box') returning id`)).rows[0]!.id;
    const node = (await db.execute<{ id: string }>(sql`insert into nodes (company_id, machine_id, status) values (${company}, ${machine}, 'ready') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into jobs (company_id, subscription_id, prompt, timeout_ms, status, error, failure, started_at, node_id) values
      (${company}, ${sub}, 'Unstarted stale', 1000, 'failed', 'stale', '{"kind":"unknown","text":"Old failure","retryable":false}', null, null),
      (${company}, ${sub}, 'Started stale', 1000, 'failed', 'stale', '{"kind":"unknown","text":"Running failure","retryable":false}', now(), null),
      (${company}, ${sub}, 'Node stale', 1000, 'failed', 'stale', '{"kind":"unknown","text":"Node failure","retryable":false}', null, ${node}),
      (${company}, ${sub}, 'Timeout', 1000, 'failed', 'timeout', null, null, null)`);

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    const rows = await db.execute<{ prompt: string; status: string; error: string }>(sql`select prompt, status, error from jobs order by prompt`);
    expect(rows.rows).toEqual([
      { prompt: 'Node stale', status: 'failed', error: 'stale' },
      { prompt: 'Started stale', status: 'failed', error: 'stale' },
      { prompt: 'Timeout', status: 'failed', error: 'timeout' },
      { prompt: 'Unstarted stale', status: 'obsolete', error: 'stale' },
    ]);
  });
});

describe('migration 0062', () => {
  const previous = async () => {
    const source = new PGlite();
    onTestFinished(() => source.close());
    const db = drizzle(source);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0061_test_run_commit') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Demo') returning id`)).rows[0]!.id;
    const task = async (number: number, status: string, body: string) => {
      const closed = status === 'done' || status === 'cancelled' ? sql`now()` : sql`null`;
      await db.execute(sql`insert into tasks (company_id, number, title, body, status, closed_at) values (${company}, ${number}, ${`Task ${number}`}, ${body}, ${status}, ${closed})`);
    };
    return { db, task };
  };
  const labels = async (db: PgliteDatabase) => (await db.execute<{ number: number; work_kind: string | null; risk_class: string | null }>(sql`select number, work_kind, risk_class from tasks order by number`)).rows;

  it('makes the fields and the tables on a fresh install, and grants no one anything', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const columns = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'tasks' and column_name in ('work_kind', 'risk_class') order by column_name`);
    expect(columns.rows.map(c => c.column_name)).toEqual(['risk_class', 'work_kind']);
    expect((await db.execute(sql`select * from turn_snapshots`)).rows).toEqual([]);
    expect((await db.execute(sql`select * from test_part_timings`)).rows).toEqual([]);
    expect((await db.execute(sql`select grantee from information_schema.role_table_grants where table_name in ('turn_snapshots', 'test_part_timings') and grantee <> current_user`)).rows).toEqual([]);
  });

  it("moves the first line of open tasks' bodies into the fields, and changes nothing else", async () => {
    const { db, task } = await previous();
    await task(1, 'open', 'Вид: известное поведение. Класс риска: нет.\n\nФаза А.');
    await task(2, 'working', 'Вид: ошибка. Класс риска: безопасность.\nТело.');
    await task(3, 'blocked', 'Вид: неизвестный путь. Класс риска: данные');
    await task(4, 'waiting', 'Вид: старый код. Класс риска: деньги.');
    await task(5, 'planned', 'Вид: ошибка. Класс риска: доступ.');
    await task(6, 'done', 'Вид: ошибка. Класс риска: данные.');
    await task(7, 'cancelled', 'Вид: ошибка. Класс риска: данные.');
    await task(8, 'open', 'No such line.\nВид: ошибка. Класс риска: данные.');
    await task(9, 'open', 'Вид: что-то новое. Класс риска: не знаю.');
    await task(10, 'open', 'Вид: ошибка.');
    const before = (await db.execute(sql`select to_jsonb(t) as data from tasks t order by number`)).rows;

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await labels(db)).toEqual([
      { number: 1, work_kind: 'known_behavior', risk_class: 'none' },
      { number: 2, work_kind: 'bug', risk_class: 'security' },
      { number: 3, work_kind: 'unknown_path', risk_class: 'data' },
      { number: 4, work_kind: 'legacy_code', risk_class: 'money' },
      { number: 5, work_kind: 'bug', risk_class: 'access' },
      { number: 6, work_kind: null, risk_class: null },
      { number: 7, work_kind: null, risk_class: null },
      { number: 8, work_kind: null, risk_class: null },
      { number: 9, work_kind: null, risk_class: null },
      { number: 10, work_kind: 'bug', risk_class: null },
    ]);
    expect((await db.execute(sql`select to_jsonb(t) - 'work_kind' - 'risk_class' as data from tasks t order by number`)).rows).toEqual(before);
  });

  it('refuses a kind or a risk class it does not know', async () => {
    const { db, task } = await previous();
    await task(1, 'open', '');
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await db.execute(sql`update tasks set work_kind = 'bug', risk_class = 'none'`);
    await expect(db.execute(sql`update tasks set work_kind = 'feature'`)).rejects.toThrow();
    await expect(db.execute(sql`update tasks set risk_class = 'fun'`)).rejects.toThrow();
  });
});

describe('migration 0059', () => {
  const tableOf = (db: PgliteDatabase) =>
    db.execute<{ column_name: string; is_nullable: string }>(sql`select column_name, is_nullable from information_schema.columns where table_name = 'node_connections' order by column_name`);
  const COLUMNS = [
    { column_name: 'cause', is_nullable: 'YES' },
    { column_name: 'close_code', is_nullable: 'YES' },
    { column_name: 'close_reason', is_nullable: 'YES' },
    { column_name: 'company_id', is_nullable: 'NO' },
    { column_name: 'connected_at', is_nullable: 'NO' },
    { column_name: 'disconnected_at', is_nullable: 'YES' },
    { column_name: 'error', is_nullable: 'YES' },
    { column_name: 'id', is_nullable: 'NO' },
    { column_name: 'machine_id', is_nullable: 'NO' },
    { column_name: 'node_id', is_nullable: 'NO' },
    { column_name: 'report', is_nullable: 'YES' },
  ];

  it('makes the history of node connections on a fresh install, with its indexes', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await tableOf(db)).rows).toEqual(COLUMNS);
    const indexes = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'node_connections' and indexname <> 'node_connections_pkey' order by indexname`);
    expect(indexes.rows.map(r => r.indexname)).toEqual(['node_connections_machine', 'node_connections_node']);
  });

  it("starts empty on the previous release's database, keeps its nodes, and grants no one anything", async () => {
    const source = new PGlite();
    onTestFinished(() => source.close());
    let db = drizzle(source);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0058_program_operator') });
    const one = async (statement: Parameters<typeof db.execute>[0]) => (await db.execute<{ id: string }>(statement)).rows[0]!.id;
    const company = await one(sql`insert into companies (name) values ('Demo') returning id`);
    const person = await one(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Lisa', 'lisa@example.test', 'active', 'company') returning id`);
    const machine = await one(sql`insert into machines (company_id, person_id, machine_key, hostname) values (${company}, ${person}, 'mac-0001-abcd', 'lisa-mac') returning id`);
    const node = await one(sql`insert into nodes (company_id, machine_id, status) values (${company}, ${machine}, 'ready') returning id`);
    const before = (await db.execute(sql`select to_jsonb(n) as data from nodes n`)).rows;
    const copy = new PGlite({ loadDataDir: await source.dumpDataDir('none') });
    onTestFinished(() => copy.close());
    db = drizzle(copy);

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect((await db.execute(sql`select to_jsonb(n) as data from nodes n`)).rows).toEqual(before);
    expect((await db.execute(sql`select * from node_connections`)).rows).toEqual([]);
    expect((await db.execute(sql`select grantee from information_schema.role_table_grants where table_name = 'node_connections' and grantee <> current_user`)).rows).toEqual([]);
    await db.execute(sql`insert into node_connections (company_id, machine_id, node_id, connected_at) values (${company}, ${machine}, ${node}, now())`);
    await db.execute(sql`delete from nodes where id = ${node}`);
    expect((await db.execute(sql`select * from node_connections`)).rows).toEqual([]);
  });

  it('refuses a cause on a connection that has not ended, and an end with no cause', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const one = async (statement: Parameters<typeof db.execute>[0]) => (await db.execute<{ id: string }>(statement)).rows[0]!.id;
    const company = await one(sql`insert into companies (name) values ('Demo') returning id`);
    const person = await one(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Lisa', 'lisa@example.test', 'active', 'company') returning id`);
    const machine = await one(sql`insert into machines (company_id, person_id, machine_key, hostname) values (${company}, ${person}, 'mac-0001-abcd', 'lisa-mac') returning id`);
    const node = await one(sql`insert into nodes (company_id, machine_id, status) values (${company}, ${machine}, 'ready') returning id`);
    await expect(db.execute(sql`insert into node_connections (company_id, machine_id, node_id, connected_at, cause) values (${company}, ${machine}, ${node}, now(), 'network')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into node_connections (company_id, machine_id, node_id, connected_at, disconnected_at) values (${company}, ${machine}, ${node}, now(), now())`)).rejects.toThrow();
  });
});

describe('migration 0057', () => {
  const columnsOf = (db: PgliteDatabase) =>
    db.execute<{ column_name: string; is_nullable: string }>(sql`select column_name, is_nullable from information_schema.columns where table_name = 'attachments' and column_name in ('job_id', 'person_id') order by column_name`);

  it('lets a picture have a person instead of a turn on a fresh install', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await columnsOf(db)).rows).toEqual([{ column_name: 'job_id', is_nullable: 'YES' }, { column_name: 'person_id', is_nullable: 'YES' }]);
    const indexes = await db.execute(sql`select indexname from pg_indexes where indexname = 'attachments_person_id'`);
    expect(indexes.rows).toHaveLength(1);
  });

  it("keeps the previous release's files as they were and takes a person's picture after them", async () => {
    const source = new PGlite();
    onTestFinished(() => source.close());
    let db = drizzle(source);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0056_obsolete_wakes') });
    const one = async (statement: Parameters<typeof db.execute>[0]) => (await db.execute<{ id: string }>(statement)).rows[0]!.id;
    const company = await one(sql`insert into companies (name) values ('Demo') returning id`);
    const person = await one(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Lisa', 'lisa@example.test', 'active', 'listed') returning id`);
    const sub = await one(sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status) values (${company}, 'anthropic_api', 'api_key', 'Key', ${person}, 'ready') returning id`);
    const agent = await one(sql`insert into agents (company_id, kind, name, model, subscription_id) values (${company}, 'worker', 'Bruno', '', ${sub}) returning id`);
    const job = await one(sql`insert into jobs (company_id, subscription_id, agent_id, kind, prompt, timeout_ms, status) values (${company}, ${sub}, ${agent}, 'conversation', 'go', 900000, 'done') returning id`);
    await db.execute(sql`insert into attachments (company_id, job_id, agent_id, name, media_type, bytes, size) values (${company}, ${job}, ${agent}, 'shot.png', 'image/png', '\\x89504e47', 4)`);
    const before = (await db.execute(sql`select to_jsonb(a) as data from attachments a`)).rows;
    const copy = new PGlite({ loadDataDir: await source.dumpDataDir('none') });
    onTestFinished(() => copy.close());
    db = drizzle(copy);

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect((await db.execute(sql`select to_jsonb(a) - 'person_id' - 'operator_case_id' as data from attachments a`)).rows).toEqual(before);
    expect((await db.execute(sql`select person_id, operator_case_id from attachments`)).rows).toEqual([{ person_id: null, operator_case_id: null }]);
    await db.execute(sql`insert into attachments (company_id, agent_id, person_id, name, media_type, bytes, size) values (${company}, ${agent}, ${person}, 'screen.png', 'image/png', '\\x89504e47', 4)`);
    expect((await db.execute(sql`select name from attachments where job_id is null and person_id = ${person}`)).rows).toEqual([{ name: 'screen.png' }]);
  });
});

describe('migration 0046', () => {
  it('recovers a missing migration below the newest recorded timestamp exactly once', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await db.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('another branch', 1793700000001)`);
    const before = (await db.execute(sql`select * from drizzle.__drizzle_migrations order by id`)).rows;
    await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = 1793700000000`);
    await db.execute(sql`alter table jobs drop column failure, drop column not_before, drop column restarted_at`);
    await db.execute(sql`drop index agent_events_failure_case`);
    await db.execute(sql`drop index agent_events_operations_pending`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const columns = (await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'jobs'`)).rows.map(c => c.column_name);
    expect(columns).toEqual(expect.arrayContaining(['failure', 'not_before', 'restarted_at']));
    const indexes = (await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'agent_events'`)).rows.map(i => i.indexname);
    expect(indexes).toEqual(expect.arrayContaining(['agent_events_failure_case', 'agent_events_operations_pending']));
    const after = (await db.execute(sql`select * from drizzle.__drizzle_migrations order by id`)).rows;
    expect(after.filter(row => Number(row.created_at) !== 1793700000000)).toEqual(before.filter(row => Number(row.created_at) !== 1793700000000));
    expect(after.filter(row => Number(row.created_at) === 1793700000000)).toEqual([expect.objectContaining({ hash: before.find(row => Number(row.created_at) === 1793700000000)!.hash })]);
    expect(logged).toHaveBeenCalledExactlyOnceWith('Applied missing migration 0046_turn_failures');
  });

  it('does nothing on a second start even if a recorded hash differs', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    await db.execute(sql`update drizzle.__drizzle_migrations set hash = 'old file' where created_at = 1793700000000`);
    const before = (await db.execute(sql`select * from drizzle.__drizzle_migrations order by id`)).rows;

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect((await db.execute(sql`select * from drizzle.__drizzle_migrations order by id`)).rows).toEqual(before);
    expect(logged).not.toHaveBeenCalled();
  });

  it.each([['agent_events_failure_case', 'failureCase'], ['agent_events_operations_pending', 'operationsPending']])('indexes %s only when %s is present', async (name, field) => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0044_ceo_delegate') });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const indexes = (await db.execute<{ indexname: string; indexdef: string }>(sql`select indexname, indexdef from pg_indexes where tablename = 'agent_events'`)).rows;
    const index = indexes.find(i => i.indexname === name);
    expect(index, name).toBeDefined();
    expect(index!.indexdef).toContain(`(data ->> '${field}'::text)`);
    expect(index!.indexdef).toContain(`WHERE ((data ->> '${field}'::text) IS NOT NULL)`);
  });

  it('keeps older turns with no failure, delayed start or program restart, and stores each on new turns', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0044_ceo_delegate') });
    await db.execute(sql`insert into companies (name) values ('Acme')`);
    await db.execute(sql`insert into people (company_id, name, email, status, scope_kind) select id, 'Ivan', 'ivan@acme.com', 'active', 'company' from companies`);
    await db.execute(sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status) select company_id, 'codex', 'personal', 'Plan', id, 'ready' from people`);
    await db.execute(sql`insert into jobs (company_id, subscription_id, prompt, timeout_ms) select company_id, id, 'Work', 900000 from subscriptions`);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await db.execute(sql`select failure, not_before, restarted_at from jobs`)).rows).toEqual([{ failure: null, not_before: null, restarted_at: null }]);
    await db.execute(sql`update jobs set failure = '{"kind":"network","text":"Offline","retryable":true}', not_before = '2026-11-03T12:01:00Z', restarted_at = '2026-11-03T12:00:00Z'`);
    expect((await db.execute(sql`select failure->>'kind' as kind, not_before > restarted_at as waits from jobs`)).rows).toEqual([{ kind: 'network', waits: true }]);
  });
});
