import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { freshPglite, ownDatabases } from './helpers-db.js';
import { migrationsThrough } from './migrations-before.js';
import { freshInstall, migrate, migrationsUpTo } from './migrations-fixture.js';

ownDatabases();

describe('limits freshness migration', () => {
  it('keeps an old limits snapshot and leaves its unknown timestamp null on upgrade', async () => {
    const client = await freshPglite();
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

    /* Later migrations add columns of their own, empty: 0125 the address and protocol of an API connection, 0131 the
       fallbacks of a plan. */
    expect((await db.execute(sql`select to_jsonb(s) - 'limits_updated_at' - 'base_url' - 'api_protocol' - 'fallbacks' as data from subscriptions s`)).rows).toEqual(before);
    expect((await db.execute(sql`select limits_updated_at, base_url, api_protocol, fallbacks from subscriptions`)).rows).toEqual([{ limits_updated_at: null, base_url: null, api_protocol: null, fallbacks: [] }]);
  });
});

describe('notification provenance migration', () => {
  it('preserves old pending wakes and adds nullable structured provenance', async () => {
    const client = await freshPglite();
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
    const client = await freshInstall();
    const db = drizzle(client);
    const columns = await db.execute(sql`select column_name, data_type, is_nullable from information_schema.columns where table_name = 'tasks'`);
    expect(columns.rows).toContainEqual({ column_name: 'external_wait', data_type: 'jsonb', is_nullable: 'YES' });
    const indexes = await db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where tablename = 'tasks' and indexname = 'tasks_external_wait_until'`);
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]!.indexdef).toContain("external_wait ->> 'until'");
    expect(indexes.rows[0]!.indexdef).toContain('WHERE (external_wait IS NOT NULL)');
  });

  it('upgrades existing tasks without changing them and defaults their wait to null', async () => {
    const client = await freshPglite();
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
    const target = await migrationsThrough('external_wait');
    await migrate(db, { migrationsFolder: target });
    await migrate(db, { migrationsFolder: target });
    expect((await db.execute(sql`select to_jsonb(t) - 'external_wait' as data from tasks t order by number`)).rows).toEqual(before);
    expect((await db.execute(sql`select to_jsonb(w) - 'task_version' as data from pending_wakes w order by id`)).rows).toEqual(beforeWakes);
    expect((await db.execute(sql`select task_version from pending_wakes`)).rows).toEqual([{ task_version: null }]);
    const notificationTarget = await migrationsThrough('notification_provenance');
    await migrate(db, { migrationsFolder: notificationTarget });
    await migrate(db, { migrationsFolder: notificationTarget });
    expect((await db.execute(sql`select to_jsonb(w) - 'task_version' - 'cause' as data from pending_wakes w order by id`)).rows).toEqual(beforeWakes);
    expect((await db.execute(sql`select task_version, cause from pending_wakes`)).rows).toEqual([{ task_version: null, cause: null }]);
    const rows = (await db.execute(sql`select * from tasks order by number`)).rows;
    expect(rows).toHaveLength(150);
    for (const row of rows) expect(row).toHaveProperty('external_wait', null);
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
    /* A fresh install migrates: the copy of one is made by migrating it. */
    await freshInstall();

    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0047_requested_prompt') });

    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind) values
      (${P}, ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company'),
      (${ALICE}, ${C}, 'Alice', 'alice@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into machines (id, company_id, person_id, machine_key, hostname) values (${M}, ${C}, ${P}, 'mac-0001-abcd', 'dev-mac')`);

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
    const source = await freshPglite();
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
    /* Without the columns later migrations added: an older command is one for no core. */
    expect((await db.execute(sql`select to_jsonb(c) - 'dismissed_subscription_ids' - 'core' as data from node_codes c order by code_hash`)).rows).toEqual(before);
    expect((await db.execute(sql`select core from node_codes`)).rows).toEqual(Array.from({ length: 3 }, () => ({ core: false })));
    expect((await db.execute(sql`select dismissed_subscription_ids from node_codes`)).rows).toEqual(Array.from({ length: 3 }, () => ({ dismissed_subscription_ids: [] })));
  });
});

describe('migration 0053', () => {
  it('creates the person rename journal and its indexes on a fresh install', async () => {
    const client = await freshInstall();
    const db = drizzle(client);
    const columns = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'person_changes' order by column_name`);
    expect(columns.rows.map(row => row.column_name)).toEqual(['actor_id', 'after', 'before', 'company_id', 'created_at', 'field', 'id', 'person_id']);
    const indexes = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'person_changes' order by indexname`);
    expect(indexes.rows).toEqual([{ indexname: 'person_changes_company_id' }, { indexname: 'person_changes_person_id' }, { indexname: 'person_changes_pkey' }]);
  });

  it('upgrades existing people intact, keeps the actor when a different person is deleted and cascades with the company', async () => {
    const source = await freshPglite();
    onTestFinished(() => source.close());
    let db = drizzle(source);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0052_dismissed_command_blocks') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Demo') returning id`)).rows[0]!.id;
    const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Clara', 'clara@example.test', 'active', 'listed') returning id`)).rows[0]!.id;
    const actor = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Author', 'author@example.test', 'active', 'listed') returning id`)).rows[0]!.id;
    const people = async () => (await db.execute<{ data: Record<string, unknown> }>(sql`select to_jsonb(p) as data from people p order by id`)).rows;
    const before = await people();
    const copy = new PGlite({ loadDataDir: await source.dumpDataDir('none') });
    onTestFinished(() => copy.close());
    db = drizzle(copy);

    /* 0053 itself leaves every person as it was, field for field. */
    const through0053 = await migrationsUpTo('0053_person_changes');
    await migrate(db, { migrationsFolder: through0053 });
    await migrate(db, { migrationsFolder: through0053 });
    expect(await people()).toStrictEqual(before);

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    /* The later migrations keep every field 0053 knew. Of the fields they add, 0098 gives every person an empty Telegram,
       0100 makes every one a person and no assistant, and the deletion of people deletes nobody; the fields of later ones
       are theirs to check. */
    const known = Object.keys(before[0]!.data);
    const after = await people();
    expect(after.map(row => ({ data: Object.fromEntries(known.map(field => [field, row.data[field]])) }))).toStrictEqual(before);
    expect(after.map(({ data }) => ({ telegram_username: data.telegram_username, telegram_user_id: data.telegram_user_id, is_agent: data.is_agent, assistant_of: data.assistant_of, removed_at: data.removed_at })))
      .toStrictEqual(before.map(() => ({ telegram_username: null, telegram_user_id: null, is_agent: false, assistant_of: null, removed_at: null })));
    await db.execute(sql`insert into person_changes (company_id, person_id, actor_id, field, before, after) values (${company}, ${person}, ${actor}, 'name', 'Clara', 'Clara Ray')`);
    await db.execute(sql`delete from people where id = ${actor}`);
    expect((await db.execute(sql`select actor_id, before, after from person_changes`)).rows).toEqual([{ actor_id: null, before: 'Clara', after: 'Clara Ray' }]);
    await db.execute(sql`delete from people where id = ${person}`);
    await db.execute(sql`delete from companies where id = ${company}`);
    expect((await db.execute(sql`select count(*)::int as n from person_changes`)).rows).toEqual([{ n: 0 }]);
  });
});

describe('migration 0056', () => {
  it('makes only unstarted stale wakes obsolete', async () => {
    const source = await freshPglite();
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
    const source = await freshPglite();
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
    const client = await freshInstall();
    const db = drizzle(client);
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

    const target = await migrationsThrough('pipeline_report');
    await migrate(db, { migrationsFolder: target });
    await migrate(db, { migrationsFolder: target });

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
    /* Since 0129 a connection of a machine's built-in node, which has no node of its own, has none (#1060). */
    { column_name: 'node_id', is_nullable: 'YES' },
    { column_name: 'report', is_nullable: 'YES' },
  ];

  it('makes the history of node connections on a fresh install, with its indexes', async () => {
    const client = await freshInstall();
    const db = drizzle(client);
    expect((await tableOf(db)).rows).toEqual(COLUMNS);
    const indexes = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'node_connections' and indexname <> 'node_connections_pkey' order by indexname`);
    expect(indexes.rows.map(r => r.indexname)).toEqual(['node_connections_machine', 'node_connections_node']);
  });

  it("starts empty on the previous release's database, keeps its nodes, and grants no one anything", async () => {
    const source = await freshPglite();
    onTestFinished(() => source.close());
    let db = drizzle(source);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0058_program_operator') });
    const one = async (statement: Parameters<typeof db.execute>[0]) => (await db.execute<{ id: string }>(statement)).rows[0]!.id;
    const company = await one(sql`insert into companies (name) values ('Demo') returning id`);
    const person = await one(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Clara', 'clara@example.test', 'active', 'company') returning id`);
    const machine = await one(sql`insert into machines (company_id, person_id, machine_key, hostname) values (${company}, ${person}, 'mac-0001-abcd', 'clara-mac') returning id`);
    const node = await one(sql`insert into nodes (company_id, machine_id, status) values (${company}, ${machine}, 'ready') returning id`);
    const before = (await db.execute(sql`select to_jsonb(n) as data from nodes n`)).rows;
    const copy = new PGlite({ loadDataDir: await source.dumpDataDir('none') });
    onTestFinished(() => copy.close());
    db = drizzle(copy);

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    /* Every old node field must survive; later migrations may add fields of their own. */
    expect((await db.execute(sql`select to_jsonb(n) as data from nodes n`)).rows).toMatchObject(before);
    expect((await db.execute(sql`select * from node_connections`)).rows).toEqual([]);
    expect((await db.execute(sql`select grantee from information_schema.role_table_grants where table_name = 'node_connections' and grantee <> current_user`)).rows).toEqual([]);
    await db.execute(sql`insert into node_connections (company_id, machine_id, node_id, connected_at) values (${company}, ${machine}, ${node}, now())`);
    await db.execute(sql`delete from nodes where id = ${node}`);
    expect((await db.execute(sql`select * from node_connections`)).rows).toEqual([]);
  });

  it('refuses a cause on a connection that has not ended, and an end with no cause', async () => {
    const client = await freshInstall();
    const db = drizzle(client);
    const one = async (statement: Parameters<typeof db.execute>[0]) => (await db.execute<{ id: string }>(statement)).rows[0]!.id;
    const company = await one(sql`insert into companies (name) values ('Demo') returning id`);
    const person = await one(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Clara', 'clara@example.test', 'active', 'company') returning id`);
    const machine = await one(sql`insert into machines (company_id, person_id, machine_key, hostname) values (${company}, ${person}, 'mac-0001-abcd', 'clara-mac') returning id`);
    const node = await one(sql`insert into nodes (company_id, machine_id, status) values (${company}, ${machine}, 'ready') returning id`);
    await expect(db.execute(sql`insert into node_connections (company_id, machine_id, node_id, connected_at, cause) values (${company}, ${machine}, ${node}, now(), 'network')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into node_connections (company_id, machine_id, node_id, connected_at, disconnected_at) values (${company}, ${machine}, ${node}, now(), now())`)).rejects.toThrow();
  });
});

describe('migration 0057', () => {
  const columnsOf = (db: PgliteDatabase) =>
    db.execute<{ column_name: string; is_nullable: string }>(sql`select column_name, is_nullable from information_schema.columns where table_name = 'attachments' and column_name in ('job_id', 'person_id') order by column_name`);

  it('lets a picture have a person instead of a turn on a fresh install', async () => {
    const client = await freshInstall();
    const db = drizzle(client);
    expect((await columnsOf(db)).rows).toEqual([{ column_name: 'job_id', is_nullable: 'YES' }, { column_name: 'person_id', is_nullable: 'YES' }]);
    const indexes = await db.execute(sql`select indexname from pg_indexes where indexname = 'attachments_person_id'`);
    expect(indexes.rows).toHaveLength(1);
  });

  it("keeps the previous release's files as they were and takes a person's picture after them", async () => {
    const source = await freshPglite();
    onTestFinished(() => source.close());
    let db = drizzle(source);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0056_obsolete_wakes') });
    const one = async (statement: Parameters<typeof db.execute>[0]) => (await db.execute<{ id: string }>(statement)).rows[0]!.id;
    const company = await one(sql`insert into companies (name) values ('Demo') returning id`);
    const person = await one(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Clara', 'clara@example.test', 'active', 'listed') returning id`);
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

    /* Later migrations add the hash of a file in the store, which a file the database still holds the bytes of has not. */
    expect((await db.execute(sql`select to_jsonb(a) - 'person_id' - 'operator_case_id' - 'sha256' as data from attachments a`)).rows).toEqual(before);
    expect((await db.execute(sql`select person_id, operator_case_id, sha256 from attachments`)).rows).toEqual([{ person_id: null, operator_case_id: null, sha256: null }]);
    await db.execute(sql`insert into attachments (company_id, agent_id, person_id, name, media_type, bytes, size) values (${company}, ${agent}, ${person}, 'screen.png', 'image/png', '\\x89504e47', 4)`);
    expect((await db.execute(sql`select name from attachments where job_id is null and person_id = ${person}`)).rows).toEqual([{ name: 'screen.png' }]);
  });
});
