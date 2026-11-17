import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import type { Db } from '../src/db/client.js';
import { AFTER_MIGRATIONS } from '../src/db/net.js';
import { tlsOf } from '../src/modules/tls/store.js';
import { ownDatabases } from './helpers-db.js';
import { freshInstall, migrate, migrationsUpTo, olderInstall, prepareInstalls } from './migrations-fixture.js';

ownDatabases();

/* The outbound gateway's migration, whatever number it ends up with: the journal says which it is and which comes just
   before it. */
const TAGS = (JSON.parse(await readFile(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] }).entries.map(entry => entry.tag);
const GATEWAY = TAGS.find(tag => tag.endsWith('_outbound'))!;
const BEFORE_GATEWAY = TAGS[TAGS.indexOf(GATEWAY) - 1]!;
/* The migration that drops the gateway's tables again, and the one just before it. */
const DROP = TAGS.find(tag => tag.endsWith('_drop_outbound'))!;
const BEFORE_DROP = TAGS[TAGS.indexOf(DROP) - 1]!;

/* Every older install a test here starts from, made once as the file is collected. */
await prepareInstalls([
  '0062_pipeline_report',
  '0067_request_materials',
  BEFORE_GATEWAY,
  GATEWAY,
  '0080_live_stuck_recipients',
  '0083_harness',
  '0084_skill_bricks',
  '0085_work_fast_cards',
  '0097_route_abilities',
  '0129_builtin_node_connections',
  BEFORE_DROP,
]);

describe('department owner and approval policy migration', () => {
  const FORWARD = '0062_pipeline_report';

  it('leaves every department without an owner and every company without rules, with nobody given anything', async () => {
    const client = await olderInstall(FORWARD);
    const db = drizzle(client);
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
    const client = await olderInstall(FORWARD);
    const db = drizzle(client);
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
    const client = await freshInstall();
    const db = drizzle(client);
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const dept = (await db.execute<{ id: string }>(sql`insert into departments (company_id, template_key, role_code) values (${company}, 'development', 'DEV') returning id`)).rows[0]!.id;
    await expect(db.execute(sql`insert into approval_policies (company_id, department_id, channel, mode) values (${company}, ${dept}, 'spend', 'within_limits')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into approval_policies (company_id, department_id, channel, mode, limit_amount) values (${company}, ${dept}, 'spend', 'every', 5)`)).rejects.toThrow();
    await db.execute(sql`insert into approval_policies (company_id, department_id, channel, mode, limit_amount) values (${company}, ${dept}, 'spend', 'within_limits', 5)`);
  });
});

describe('model checks migration', () => {
  it('adds its tables empty, with nobody given anything and no row of an older database touched', async () => {
    const client = await olderInstall('0067_request_materials');
    const db = drizzle(client);
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

  it('adds its tables empty, with nobody given anything and no row of two older companies touched', async () => {
    const client = await olderInstall(BEFORE_GATEWAY);
    const db = drizzle(client);
    for (const name of ['Acme', 'Moonfern']) {
      const company = (await db.execute<{ id: string }>(sql`insert into companies (name, singleton) values (${name}, ${name === 'Acme'}) returning id`)).rows[0]!.id;
      const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Dana', ${`dana@${name}.example`}, 'active', 'listed') returning id`)).rows[0]!.id;
      const department = (await db.execute<{ id: string }>(sql`insert into departments (company_id, template_key, role_code, owner_person_id) values (${company}, 'sales', 'SAL', ${person}) returning id`)).rows[0]!.id;
      await db.execute(sql`insert into person_access (company_id, person_id, department_id) values (${company}, ${person}, ${department})`);
      await db.execute(sql`insert into approval_policies (company_id, department_id, channel, mode, updated_by) values (${company}, ${department}, 'message', 'every', ${person})`);
    }
    const older = async () => Promise.all(['companies', 'people', 'departments', 'person_access', 'approval_policies'].map(async table => (await db.execute(sql.raw(`select to_jsonb(t) as row from ${table} t order by id`))).rows));
    const before = await older();

    const target = await migrationsUpTo(GATEWAY);
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
    const client = await olderInstall(GATEWAY);
    const db = drizzle(client);
    const target = await migrationsUpTo(GATEWAY);
    const guards = sql`select count(*)::int as n from pg_trigger where tgname like 'outbound_guard_%' and not tgisinternal`;
    const [{ n }] = (await db.execute<{ n: number }>(guards)).rows as [{ n: number }];
    expect(n).toBeGreaterThan(0);
    await migrate(db, { migrationsFolder: target });
    expect((await db.execute(guards)).rows).toEqual([{ n }]);
  });
});

describe('the migration that drops the outbound gateway', () => {
  it('drops its tables with their rows, a mailbox sign-in among them, and the function that guarded them, leaving every other row', async () => {
    const client = await olderInstall(BEFORE_DROP);
    const db = drizzle(client);
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name, singleton) values ('Acme', true) returning id`)).rows[0]!.id;
    const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Dana', 'dana@acme.example', 'active', 'listed') returning id`)).rows[0]!.id;
    const department = (await db.execute<{ id: string }>(sql`insert into departments (company_id, template_key, role_code, owner_person_id) values (${company}, 'sales', 'SAL', ${person}) returning id`)).rows[0]!.id;
    await db.execute(sql`insert into approval_policies (company_id, department_id, channel, mode, updated_by) values (${company}, ${department}, 'message', 'every', ${person})`);
    const channel = (await db.execute<{ id: string }>(sql`insert into outbound_channels (company_id, department_id, name, adapter, purpose, audience, created_by) values (${company}, ${department}, 'mail', 'smtp', 'sales', 'direct', ${person}) returning id`)).rows[0]!.id;
    await db.execute(sql`insert into outbound_accounts (company_id, department_id, channel_id, sender_domain, label, config_enc, created_by) values (${company}, ${department}, ${channel}, 'acme.example', 'sales', 'sealed sign-in', ${person})`);
    await db.execute(sql`insert into model_checks (company_id, department_id, kind) values (${company}, ${department}, 'reply')`);
    const kept = async () => Promise.all(['companies', 'people', 'departments', 'approval_policies'].map(async table => (await db.execute(sql.raw(`select to_jsonb(t) as row from ${table} t order by id`))).rows));
    const before = await kept();

    const target = await migrationsUpTo(DROP);
    await migrate(db, { migrationsFolder: target });
    await migrate(db, { migrationsFolder: target });

    expect(await kept()).toEqual(before);
    expect((await db.execute(sql`select tablename from pg_tables where schemaname = 'public' and tablename ~ '^(outbound_|support_|model_check)'`)).rows).toEqual([]);
    expect((await db.execute(sql`select proname from pg_proc where proname = 'outbound_refuse_change'`)).rows).toEqual([]);
  });
});

describe('migration 0081', () => {
  const C = '00000000-0000-4000-8000-000000000001';

  it('keeps on every card the text that moved out of a skill it holds, and adds nothing else', async () => {
    const client = await olderInstall('0080_live_stuck_recipients');
    const db = drizzle(client);
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    const cards: Record<string, string[]> = {
      /* What the testing policy took from the engineering rules and from the path of a turn. */
      Developer: ['hh-task-flow', 'dev-engineering-rules'],
      Head: ['dev-work-pipeline', 'dev-gates'],
      Tester: ['dev-engineering-rules', 'dev-testing-policy'],
      /* What to do before asking for a release moved from the department's map to the release pipeline. */
      Lead: ['dev-work-pipeline', 'dev-ci-release', 'dev-testing-policy'],
      /* The four kinds of task moved from implementing a task to test-driven work: a card trimmed by hand held one and not the other. */
      Builder: ['dev-engineering-rules', 'dev-language-rules', 'dev-implement', 'dev-migrations', 'dev-debugging', 'dev-frontend-ui', 'dev-browser-check'],
      Whole: ['dev-implement', 'dev-tdd', 'dev-testing-policy'],
      /* What a gate adds moved out of both review checks into the verdict. */
      Security: ['dev-security-review'],
      Reader: ['dev-review-diff'],
      Reviewer: ['dev-security-review', 'dev-review-verdict', 'dev-testing-policy'],
      /* The checks of a view moved from the interface skill to the check of the running product. */
      Screens: ['dev-frontend-ui'],
      /* These held none of the moved text, so nothing changes. */
      Sales: ['sal-prospecting'],
      Writer: ['dev-docs', 'hh-work-fast'],
    };
    for (const [name, skills] of Object.entries(cards)) {
      await db.execute(sql`insert into agents (company_id, kind, name, model, skills) values (${C}, 'worker', ${name}, '', ${JSON.stringify(skills)}::jsonb)`);
    }

    await migrate(db, { migrationsFolder: await migrationsUpTo('0081_testing_policy_skill') });

    const rows = await db.execute<{ name: string; skills: string[] }>(sql`select name, skills from agents`);
    const after = Object.fromEntries(rows.rows.map(r => [r.name, r.skills]));
    expect(after).toEqual({
      Developer: ['hh-task-flow', 'dev-engineering-rules', 'dev-testing-policy'],
      Head: ['dev-work-pipeline', 'dev-gates', 'dev-ci-release', 'dev-testing-policy'],
      Tester: ['dev-engineering-rules', 'dev-testing-policy'],
      Lead: ['dev-work-pipeline', 'dev-ci-release', 'dev-testing-policy'],
      Builder: [...cards.Builder!, 'dev-tdd', 'dev-testing-policy'],
      Whole: ['dev-implement', 'dev-tdd', 'dev-testing-policy'],
      Security: ['dev-security-review', 'dev-review-verdict', 'dev-testing-policy'],
      Reader: ['dev-review-diff', 'dev-review-verdict', 'dev-testing-policy'],
      Reviewer: ['dev-security-review', 'dev-review-verdict', 'dev-testing-policy'],
      Screens: ['dev-frontend-ui', 'dev-browser-check', 'dev-testing-policy'],
      Sales: ['sal-prospecting'],
      Writer: ['dev-docs', 'hh-work-fast'],
    });
  });
});

describe('migration 0084', () => {
  const C = '00000000-0000-4000-8000-000000000001';

  it('gives what leading and working on code took out of the common skills to every card that leads or works on code, and nothing to the others', async () => {
    const client = await olderInstall('0083_harness');
    const db = drizzle(client);
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    const cards: [name: string, kind: 'head' | 'worker', role: string | null, skills: string[]][] = [
      /* Leading code left the skill every head carries. */
      ['Lead', 'head', 'DEV-HEAD', ['dev-work-pipeline', 'dev-gates']],
      ['Lead of its own', 'head', null, ['dev-work-pipeline']],
      ['Design lead', 'head', 'DSN-HEAD', ['dsn-work-pipeline']],
      /* Working on code left the skill every member carries: a role of development, a card that holds code skills, or Operations fixing code. */
      ['Developer', 'worker', 'DEV-ENG', ['dev-implement', 'dev-tdd']],
      ['Trimmed', 'worker', 'DEV-REV', []],
      ['Designer', 'worker', 'DEV-FE', ['dev-frontend-ui']],
      ['Writer of its own', 'worker', null, ['dev-docs']],
      ['Fixer', 'worker', 'OPS-FIX', ['ops-runbook']],
      ['Integrator', 'worker', 'OPS-INTEG', ['ops-api-connector']],
      ['Already', 'worker', 'DEV-ENG', ['dev-task-flow', 'dev-tdd']],
      /* These hold no code, so nothing changes. */
      ['Seller', 'worker', 'SAL-SDR', ['sal-prospecting']],
      ['Watchdog', 'worker', 'OPS-WATCH', ['ops-task-watch']],
    ];
    for (const [name, kind, role, skills] of cards) {
      await db.execute(sql`insert into agents (company_id, kind, name, model, role_key, skills) values (${C}, ${kind}, ${name}, '', ${role}, ${JSON.stringify(skills)}::jsonb)`);
    }

    await migrate(db, { migrationsFolder: await migrationsUpTo('0084_skill_bricks') });

    const rows = await db.execute<{ name: string; skills: string[] }>(sql`select name, skills from agents`);
    expect(Object.fromEntries(rows.rows.map(r => [r.name, r.skills]))).toEqual({
      Lead: ['dev-work-pipeline', 'dev-gates', 'dev-lead'],
      'Lead of its own': ['dev-work-pipeline', 'dev-lead'],
      'Design lead': ['dsn-work-pipeline'],
      Developer: ['dev-implement', 'dev-tdd', 'dev-task-flow'],
      Trimmed: ['dev-task-flow'],
      Designer: ['dev-frontend-ui', 'dev-task-flow'],
      'Writer of its own': ['dev-docs', 'dev-task-flow'],
      Fixer: ['ops-runbook', 'dev-task-flow'],
      Integrator: ['ops-api-connector', 'dev-task-flow'],
      Already: ['dev-task-flow', 'dev-tdd'],
      Seller: ['sal-prospecting'],
      Watchdog: ['ops-task-watch'],
    });
  });
});

describe('migration 0085', () => {
  const C = '00000000-0000-4000-8000-000000000001';

  it('gives the speed skill every role lists to every head and member that keeps a list of its own, once, and nothing to the orchestrator', async () => {
    const client = await olderInstall('0084_skill_bricks');
    const db = drizzle(client);
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    const cards: [name: string, kind: 'orchestrator' | 'head' | 'worker', role: string | null, skills: string[]][] = [
      ['Lead', 'head', 'DEV-HEAD', ['dev-lead', 'dev-work-pipeline']],
      ['Design lead', 'head', 'DSN-HEAD', ['dsn-work-pipeline']],
      ['Developer', 'worker', 'DEV-GEN', ['dev-task-flow', 'dev-tdd']],
      ['Seller', 'worker', 'SAL-SDR', ['sal-prospecting']],
      ['Trimmed', 'worker', 'OPS-WATCH', []],
      ['Of its own', 'worker', null, ['dev-docs']],
      ['Already', 'worker', 'DEV-ENG', ['hh-work-fast', 'dev-tdd']],
      /* The orchestrator's skills come from code, not from a card. */
      ['Orchestrator', 'orchestrator', null, []],
    ];
    for (const [name, kind, role, skills] of cards) {
      await db.execute(sql`insert into agents (company_id, kind, name, model, role_key, skills) values (${C}, ${kind}, ${name}, '', ${role}, ${JSON.stringify(skills)}::jsonb)`);
    }

    await migrate(db, { migrationsFolder: await migrationsUpTo('0085_work_fast_cards') });

    const rows = await db.execute<{ name: string; skills: string[] }>(sql`select name, skills from agents`);
    expect(Object.fromEntries(rows.rows.map(r => [r.name, r.skills]))).toEqual({
      Lead: ['dev-lead', 'dev-work-pipeline', 'hh-work-fast'],
      'Design lead': ['dsn-work-pipeline', 'hh-work-fast'],
      Developer: ['dev-task-flow', 'dev-tdd', 'hh-work-fast'],
      Seller: ['sal-prospecting', 'hh-work-fast'],
      Trimmed: ['hh-work-fast'],
      'Of its own': ['dev-docs', 'hh-work-fast'],
      Already: ['hh-work-fast', 'dev-tdd'],
      Orchestrator: [],
    });
  });
});

describe('migration 0086 composable skills', () => {
  const C = '00000000-0000-4000-8000-000000000001';

  it('preserves sole and mixed pending staffing cards when retiring the developer role', async () => {
    const client = await olderInstall('0085_work_fast_cards');
    const db = drizzle(client);
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Proposal upgrade')`);
    const agent = (await db.execute<{ id: string }>(sql`insert into agents (company_id, kind, name, model) values (${C}, 'orchestrator', 'Coordinator', '') returning id`)).rows[0]!.id;
    const legacy = { role: 'DEV-GEN', name: 'Mira', model: 'saved-model', checked: true, skills: { on: ['dev-tdd'], off: [] } };
    const other = { role: 'DEV-BE', name: 'Backend', checked: false };
    for (const [brief, items] of [['01 sole', [legacy]], ['02 mixed', [other, legacy]]] as const) {
      await db.execute(sql`insert into proposals (company_id, agent_id, kind, brief, items) values (${C}, ${agent}, 'staff', ${brief}, ${JSON.stringify(items)}::jsonb)`);
    }
    const read = async () => (await db.execute<{ fields: unknown; items: unknown }>(sql`select to_jsonb(p) - 'items' as fields, items from proposals p order by brief`)).rows;
    const before = await read();
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const after = await read();
    expect(after.map(row => row.fields)).toEqual(before.map(row => row.fields));
    expect(after.map(row => row.items)).toEqual([[{ ...legacy, role: 'DEV-ENG' }], [other, { ...legacy, role: 'DEV-ENG' }]]);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect(await read()).toEqual(after);
  });

  it('retires only the saved DEV-GEN role key without changing card text, skill choices or run settings', async () => {
    const client = await olderInstall('0085_work_fast_cards');
    const db = drizzle(client);
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind, is_owner)
      values (${C}, 'Owner', 'owner@acme.example', 'active', 'company', true) returning id`)).rows[0]!.id;
    const codex = (await db.execute<{ id: string }>(sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status)
      values (${C}, 'codex', 'personal', 'Codex plan', ${person}, 'ready') returning id`)).rows[0]!.id;
    const claude = (await db.execute<{ id: string }>(sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status)
      values (${C}, 'claude', 'personal', 'Claude plan', ${person}, 'needs_login') returning id`)).rows[0]!.id;
    const dept = (await db.execute<{ id: string }>(sql`insert into departments (company_id, template_key, role_code)
      values (${C}, 'development', 'DEV') returning id`)).rows[0]!.id;
    const product = (await db.execute<{ id: string }>(sql`insert into departments (company_id, parent_id, name, role_code)
      values (${C}, ${dept}, 'Checkout', 'DEV') returning id`)).rows[0]!.id;
    const team = (await db.execute<{ id: string }>(sql`insert into teams (company_id, department_id, name)
      values (${C}, ${dept}, 'Matrix') returning id`)).rows[0]!.id;
    const base = '  Keep my exact assignment.\nСохранить пробелы и строки.\nLiteral \\n stays literal.  ';
    const skills = ['retired-kept', 'dev-tdd', 'dev-review-diff', 'dev-tdd'];
    const overrides = { base, skills: { 'retired-kept': 'My retired procedure.\n', 'dev-tdd': '  Custom tests.  ' } };
    const hashes = { 'DEV-GEN': 'old-role-hash', 'DEV-ENG': 'already-saved-role-hash', 'retired-kept': 'retired-hash', 'dev-tdd': 'custom-hash' };
    await db.execute(sql`insert into agents (company_id, kind, name, role_key, model, department_id, product_id, team_id, subscription_id,
      skills, overrides, template_hashes, effort, timer_minutes, timer_order, timer_at, timer_for_work, switched_off_at, context_used, created_by)
      values (${C}, 'worker', 'Custom legacy', 'DEV-GEN', 'gpt-6.1-sol', ${dept}, ${product}, ${team}, ${codex},
      ${JSON.stringify(skills)}::jsonb, ${JSON.stringify(overrides)}::jsonb, ${JSON.stringify(hashes)}::jsonb, 'xhigh', 17,
      '  Keep this timer order.\nDo not rewrite it.  ', '2026-11-06T12:34:56.123Z', true, '2026-11-06T13:00:00.456Z', 0.37, ${person})`);
    await db.execute(sql`insert into agents (company_id, kind, name, role_key, model, subscription_id, skills, overrides, template_hashes, removed_at) values
      (${C}, 'worker', 'Trimmed legacy', 'DEV-GEN', '', ${claude}, '[]', '{"base":""}', '{}', null),
      (${C}, 'worker', 'Removed legacy', 'DEV-GEN', 'claude-sonnet-5-5', ${claude}, '["unknown-skill"]', '{"base":"Archived assignment."}', '{"DEV-GEN":"archived-hash"}', '2026-11-05T12:00:00Z'),
      (${C}, 'worker', 'Existing developer', 'DEV-ENG', '', null, '["dev-tdd"]', '{"base":"Existing assignment."}', '{"DEV-ENG":"existing-hash"}', null),
      (${C}, 'worker', 'Other role', 'DEV-BE', '', null, '["dev-tdd"]', '{}', '{}', null),
      (${C}, 'worker', 'No role', null, '', null, '["retired-kept"]', '{"base":"Roleless assignment."}', '{}', null)`);
    /* Later migrations add the machine of an employee's built-in node and each card's own inbox mode, empty on every row,
       0125 the address and protocol of an API connection, empty on every plan, 0131 each plan's fallbacks, none yet, and
       the tracker's 0138 each card's timer nudge, none yet. */
    const cards = async () => (await db.execute<{ name: string; data: string }>(sql`select name, (to_jsonb(a) - 'role_key' - 'builtin_machine' - 'inbox_mode' - 'timer_nudged_at')::text as data from agents a order by name`)).rows;
    const plans = async () => (await db.execute<{ data: string }>(sql`select (to_jsonb(s) - 'base_url' - 'api_protocol' - 'fallbacks')::text as data from subscriptions s order by id`)).rows;
    const before = { cards: await cards(), plans: await plans() };

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect({ cards: await cards(), plans: await plans() }).toEqual(before);
    expect((await db.execute<{ name: string; role_key: string | null }>(sql`select name, role_key from agents order by name`)).rows).toEqual([
      { name: 'Custom legacy', role_key: 'DEV-ENG' },
      { name: 'Existing developer', role_key: 'DEV-ENG' },
      { name: 'No role', role_key: null },
      { name: 'Other role', role_key: 'DEV-BE' },
      { name: 'Removed legacy', role_key: 'DEV-ENG' },
      { name: 'Trimmed legacy', role_key: 'DEV-ENG' },
    ]);
    expect((await db.execute<{ base: string }>(sql`select overrides ->> 'base' as base from agents where name = 'Custom legacy'`)).rows).toEqual([{ base }]);
  });

  it('appends only missing split company abilities to saved selections and preserves custom bodies, hashes and list order', async () => {
    const client = await olderInstall('0085_work_fast_cards');
    const db = drizzle(client);
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    const cards = [
      { name: 'All missing', kind: 'worker', skills: ['retired-kept', 'orch-company', 'hh-work-fast'], after: ['retired-kept', 'orch-company', 'hh-work-fast', 'orch-staff', 'orch-people', 'orch-resources'] },
      { name: 'Partly selected', kind: 'head', skills: ['orch-resources', 'orch-company', 'orch-staff'], after: ['orch-resources', 'orch-company', 'orch-staff', 'orch-people'] },
      { name: 'Already selected', kind: 'worker', skills: ['orch-people', 'orch-company', 'orch-resources', 'orch-staff', 'orch-staff'], after: ['orch-people', 'orch-company', 'orch-resources', 'orch-staff', 'orch-staff'] },
      { name: 'Saved orchestrator', kind: 'orchestrator', skills: ['orch-company'], after: ['orch-company', 'orch-staff', 'orch-people', 'orch-resources'] },
      { name: 'Not selected', kind: 'worker', skills: ['orch-staff', 'retired-kept'], after: ['orch-staff', 'retired-kept'] },
      { name: 'Empty selection', kind: 'worker', skills: [], after: [] },
    ];
    const overrides = {
      base: '  Preserve this assignment.\n',
      skills: {
        'orch-company': 'Original custom company method.',
        'orch-staff': 'Do not replace this saved staff method.',
        'orch-people': '  Preserve this people method.  ',
        'orch-resources': 'Resources custom method.\n',
        'retired-kept': 'A saved retired ability.',
      },
    };
    const hashes = { 'orch-company': 'company-hash', 'orch-staff': 'staff-hash', 'orch-people': 'people-hash', 'orch-resources': 'resources-hash', 'retired-kept': 'retired-hash' };
    for (const card of cards) {
      await db.execute(sql`insert into agents (company_id, kind, name, model, skills, overrides, template_hashes, effort, timer_minutes, timer_order, timer_at, timer_for_work)
        values (${C}, ${card.kind}, ${card.name}, 'custom-model', ${JSON.stringify(card.skills)}::jsonb, ${JSON.stringify(overrides)}::jsonb,
        ${JSON.stringify(hashes)}::jsonb, 'high', 23, 'Keep the custom timer.', '2026-11-06T10:00:00Z', true)`);
    }
    /* Later migrations add the machine of an employee's built-in node and each card's own inbox mode, empty on every row,
       and the tracker's 0138 each card's timer nudge, none yet. */
    const unchanged = async () => (await db.execute<{ name: string; data: string }>(sql`select name, (to_jsonb(a) - 'skills' - 'builtin_machine' - 'inbox_mode' - 'timer_nudged_at')::text as data from agents a order by name`)).rows;
    const before = await unchanged();

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await unchanged()).toEqual(before);
    const selected = (await db.execute<{ name: string; skills: string[] }>(sql`select name, skills from agents order by name`)).rows;
    expect(Object.fromEntries(selected.map(row => [row.name, row.skills]))).toEqual(Object.fromEntries(cards.map(card => [card.name, card.after])));
  });
});

describe('migration 0106, the tables of the network', () => {
  it('marks the sessions of an older install as made before the __Host- cookie', async () => {
    const client = await olderInstall('0097_route_abilities');
    const db = drizzle(client);
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind) values (${company}, 'Ivan', 'ivan@acme.example', 'active', 'company') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into sessions (token_hash, person_id, expires_at) values ('older', ${person}, now() + interval '1 day')`);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await db.execute(sql`select before_host_cookie from sessions`)).rows).toEqual([{ before_host_cookie: true }]);
  });
});

describe('a database from before the link had a certificate', () => {
  it('reads as having none, as the keeper meets it before an update migrates', async () => {
    const client = await olderInstall('0097_route_abilities');
    const db = drizzle(client);
    expect(await tlsOf(db as unknown as Db, '00000000-0000-4000-8000-000000000001')).toBeNull();
  });
});

describe('migration 0107, the fences and the journal', () => {
  const tablesOfPublic = sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`;
  const journaledTables = sql`select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'net_journal' and n.nspname = 'public' order by 1`;

  async function fullyMigrated(): Promise<{ client: PGlite; db: PgliteDatabase }> {
    const client = await freshInstall();
    const db = drizzle(client);
    return { client, db };
  }

  it('adds the fences, and the journal once migrated', async () => {
    const { client, db } = await fullyMigrated();
    const schemas = await db.execute(sql`select nspname from pg_namespace where nspname in ('net', 'net_local') order by 1`);
    expect(schemas.rows).toEqual([{ nspname: 'net' }, { nspname: 'net_local' }]);
    expect((await db.execute(journaledTables)).rows).toEqual([]);

    await client.exec(AFTER_MIGRATIONS);

    expect((await db.execute(journaledTables)).rows).toEqual((await db.execute(tablesOfPublic)).rows);
    const fence = await db.execute(sql`select t.tgdeferrable, t.tginitdeferred from pg_trigger t where t.tgname = 'net_fence' and t.tgrelid = 'net.journal'::regclass`);
    expect(fence.rows).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);
    const keys = await db.execute(sql`select distinct c.condeferrable, c.condeferred from pg_constraint c join pg_namespace n on n.oid = c.connamespace where c.contype = 'f' and n.nspname = 'public'`);
    expect(keys.rows).toEqual([{ condeferrable: true, condeferred: false }]);
    const withoutKey = await db.execute(sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p')`);
    expect(withoutKey.rows).toEqual([]);

    const runnableByPublic = sql`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'net' and has_function_privilege('public', p.oid, 'EXECUTE')`;
    expect((await db.execute(runnableByPublic)).rows).toEqual([]);
    await client.exec(`CREATE FUNCTION net.later() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
    await client.exec(AFTER_MIGRATIONS);
    expect((await db.execute(runnableByPublic)).rows).toEqual([]);

    await client.exec('SELECT net.detach_journal()');
    expect((await db.execute(journaledTables)).rows).toEqual((await db.execute(tablesOfPublic)).rows);
  });

  it('refuses a table it could not journal, rather than leave it out', async () => {
    const { client } = await fullyMigrated();
    await client.exec('CREATE TABLE no_key (a integer)');
    await expect(client.exec(AFTER_MIGRATIONS)).rejects.toThrow(/no_key/);
    await client.exec(`DROP TABLE no_key; CREATE TABLE "${'n'.repeat(56)}" (a integer PRIMARY KEY)`);
    await expect(client.exec(AFTER_MIGRATIONS)).rejects.toThrow(/too long/);
  });
});

describe('migrations 0108 and 0109, where each change came from', () => {
  async function fullyMigrated(): Promise<{ client: PGlite; db: PgliteDatabase }> {
    const client = await freshInstall();
    const db = drizzle(client);
    return { client, db };
  }

  it('keeps the base of each step, with the indexes pruning reads by', async () => {
    const { db } = await fullyMigrated();
    const columns = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'applied' order by 1`);
    expect(columns.rows.map(row => row.column_name)).toEqual(['at', 'base', 'source']);
    const indexes = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where schemaname = 'public' and indexname in ('applied_base', 'applied_at', 'tool_calls_at') order by 1`);
    expect(indexes.rows.map(row => row.indexname)).toEqual(['applied_at', 'applied_base', 'tool_calls_at']);
  });

  it('gives every event of a task a name that holds across machines', async () => {
    const { db } = await fullyMigrated();
    const column = await db.execute(sql`select is_nullable, column_default from information_schema.columns where table_name = 'task_events' and column_name = 'uuid'`);
    expect(column.rows).toEqual([{ is_nullable: 'NO', column_default: 'gen_random_uuid()' }]);
  });

  it('records a database call in the lease check, and nothing for a check without a call', async () => {
    const { client, db } = await fullyMigrated();
    const lease = `'net.assert_lease(interval, uuid, uuid, jsonb)'::regprocedure`;
    expect((await db.execute(sql.raw(`select has_function_privilege('public', ${lease}, 'EXECUTE') as may`))).rows).toEqual([{ may: false }]);
    const INVOCATION = '00000000-0000-4000-8000-0000000000aa';
    const JOB = '00000000-0000-4000-8000-0000000000bb';
    /* No job stands behind this call, which the check of that is told to let pass. */
    await client.exec(`SET session_replication_role = replica`);
    await client.exec(`SELECT net.assert_lease('2 s', NULL, '${JOB}', '{"ok":true}')`);
    expect((await db.execute(sql`select 1 from tool_calls`)).rows).toEqual([]);
    expect((await db.execute(sql`select 1 from applied`)).rows).toEqual([]);

    await client.exec(`SELECT net.assert_lease('2 s', '${INVOCATION}', '${JOB}', '{"ok":true}')`);
    expect((await db.execute(sql`select id, job_id, answer from tool_calls`)).rows).toEqual([{ id: INVOCATION, job_id: JOB, answer: { ok: true } }]);
    expect((await db.execute(sql`select source, base from applied`)).rows).toEqual([{ source: `tool:${INVOCATION}:0`, base: `tool:${INVOCATION}` }]);
  });
});

describe("migration 0110, the tables of the company's network", () => {
  async function fullyMigrated(): Promise<{ client: PGlite; db: PgliteDatabase }> {
    const client = await freshInstall();
    const db = drizzle(client);
    await client.exec(AFTER_MIGRATIONS);
    return { client, db };
  }
  const codeOf = (work: Promise<unknown>): Promise<string | undefined> => work.then(() => undefined, (err: { code?: string; cause?: { code?: string } }) => err.cause?.code ?? err.code);

  it("adds what a machine is in the network, and the authority's tables, journaled and closed", async () => {
    const { db } = await fullyMigrated();
    const columns = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'machines'`);
    expect(columns.rows.map(row => row.column_name)).toEqual(expect.arrayContaining(['network_id', 'role', 'sign_key', 'web_port', 'peer_port', 'commit', 'uptime_s', 'fsync_p99_ms', 'disk_free', 'report_at']));
    const tables = await db.execute<{ relname: string; closed: boolean; journaled: boolean }>(sql`select c.relname, c.relrowsecurity as closed,
      exists (select from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'net_journal') as journaled
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('authority', 'certificates', 'peer_secrets') order by 1`);
    expect(tables.rows).toEqual(['authority', 'certificates', 'peer_secrets'].map(relname => ({ relname, closed: true, journaled: true })));
  });

  it('keeps one row to a network id, and only the roles and kinds there are', async () => {
    const { client, db } = await fullyMigrated();
    /* No company or person stands behind these machines, which the check of that is told to let pass. */
    await client.exec(`SET session_replication_role = replica`);
    const machine = (key: string, more: string, values: string) =>
      db.execute(sql.raw(`insert into machines (company_id, person_id, machine_key${more}) values (gen_random_uuid(), gen_random_uuid(), '${key}'${values})`));
    await machine('a', ', network_id, role', `, 'n1', 'data'`);
    await machine('b', ', role', `, 'worker'`);
    await machine('c', '', '');
    expect(await codeOf(machine('d', ', network_id', `, 'n1'`))).toBe('23505');
    expect(await codeOf(machine('e', ', role', `, 'copy'`))).toBe('23514');
    expect(await codeOf(db.execute(sql`insert into peer_secrets (kind, secret_enc) values ('x', 's')`))).toBe('23514');
    await db.execute(sql`insert into peer_secrets (kind, secret_enc) values ('app', 's'), ('data', 's')`);
  });
});

describe('migration 0111, what joined machines need', () => {
  async function fullyMigrated(): Promise<{ client: PGlite; db: PgliteDatabase }> {
    const client = await freshInstall();
    const db = drizzle(client);
    await client.exec(AFTER_MIGRATIONS);
    /* No company or person stands behind the rows of these tests, which the check of that is told to let pass. */
    await client.exec(`SET session_replication_role = replica`);
    return { client, db };
  }
  const codeOf = (work: Promise<unknown>): Promise<string | undefined> => work.then(() => undefined, (err: { code?: string; cause?: { code?: string } }) => err.cause?.code ?? err.code);

  it('adds its tables, journaled and closed, and what a machine says of its link and its update', async () => {
    const { db } = await fullyMigrated();
    const columns = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'machines'`);
    expect(columns.rows.map(row => row.column_name)).toEqual(
      expect.arrayContaining(['addresses', 'path', 'direct_fails', 'renew_at', 'update_commit', 'update_state', 'go_commit', 'go_at', 'failed_commit', 'failed_at', 'owner_pin']),
    );
    const tables = await db.execute<{ relname: string; closed: boolean; journaled: boolean }>(sql`select c.relname, c.relrowsecurity as closed,
      exists (select from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'net_journal') as journaled
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('machine_tickets', 'machine_online', 'person_keys') order by 1`);
    expect(tables.rows).toEqual(['machine_online', 'machine_tickets', 'person_keys'].map(relname => ({ relname, closed: true, journaled: true })));
    await db.execute(sql`insert into machines (company_id, person_id, machine_key) values (gen_random_uuid(), gen_random_uuid(), 'a')`);
    expect((await db.execute(sql`select addresses, direct_fails, path from machines`)).rows).toEqual([{ addresses: [], direct_fails: false, path: null }]);
    await db.execute(sql`insert into node_codes (code_hash, company_id, person_id, subscription_ids, expires_at) values ('h', gen_random_uuid(), gen_random_uuid(), '{}', now())`);
    expect((await db.execute(sql`select core from node_codes`)).rows).toEqual([{ core: false }]);
  });

  it('takes only the paths, update states, kinds and amounts there are', async () => {
    const { db } = await fullyMigrated();
    const machine = (key: string, column: string, value: string | null) =>
      db.execute(sql.raw(`insert into machines (company_id, person_id, machine_key, ${column}) values (gen_random_uuid(), gen_random_uuid(), '${key}', ${value === null ? 'null' : `'${value}'`})`));
    for (const [key, path] of [['a', 'direct'], ['b', 'relay'], ['c', null]] as const) await machine(key, 'path', path);
    expect(await codeOf(machine('d', 'path', 'lan'))).toBe('23514');
    for (const [key, state] of [['e', 'ready'], ['f', 'installing'], ['g', 'failed']] as const) await machine(key, 'update_state', state);
    expect(await codeOf(machine('h', 'update_state', 'done'))).toBe('23514');

    const id = (await db.execute<{ id: string }>(sql`select id from machines limit 1`)).rows[0]!.id;
    await db.execute(sql`insert into machine_online (machine_id, day, seconds) values (${id}, '2026-11-10', 86400)`);
    expect(await codeOf(db.execute(sql`insert into machine_online (machine_id, day, seconds) values (${id}, '2026-11-11', 86401)`))).toBe('23514');
    expect(await codeOf(db.execute(sql`insert into machine_online (machine_id, day, seconds) values (${id}, '2026-11-10', 5)`))).toBe('23505');

    const key = (iterations: number) => db.execute(sql`insert into person_keys (person_id, company_id, public_key, wrapped, salt, iv, iterations) values (gen_random_uuid(), gen_random_uuid(), 'p', 'w', 's', 'i', ${iterations})`);
    await key(600000);
    expect(await codeOf(key(599999))).toBe('23514');

    await db.execute(sql`insert into peer_secrets (kind, secret_enc) values ('visit', 's')`);
    expect(await codeOf(db.execute(sql`insert into peer_secrets (kind, secret_enc) values ('x', 's')`))).toBe('23514');
  });
});

describe('migration 0112, computer access per machine', () => {
  async function fullyMigrated(): Promise<PgliteDatabase> {
    const client = await freshInstall();
    const db = drizzle(client);
    await client.exec(AFTER_MIGRATIONS);
    /* No company or person stands behind the rows of these tests, which the check of that is told to let pass. */
    await client.exec(`SET session_replication_role = replica`);
    return db;
  }
  const codeOf = (work: Promise<unknown>): Promise<string | undefined> => work.then(() => undefined, (err: { code?: string; cause?: { code?: string } }) => err.cause?.code ?? err.code);

  it('adds access per machine and its commands, journaled and closed', async () => {
    const db = await fullyMigrated();
    const tables = await db.execute<{ relname: string; closed: boolean; journaled: boolean }>(sql`select c.relname, c.relrowsecurity as closed,
      exists (select from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'net_journal') as journaled
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('machine_access', 'computer_runs') order by 1`);
    expect(tables.rows).toEqual(['computer_runs', 'machine_access'].map(relname => ({ relname, closed: true, journaled: true })));
  });

  it('takes only the states and times of a command there are, and a request only whole', async () => {
    const db = await fullyMigrated();
    const run = (state: string, timeout: number) =>
      db.execute(sql`insert into computer_runs (company_id, machine_id, command, timeout_s, state) values (gen_random_uuid(), gen_random_uuid(), 'true', ${timeout}, ${state})`);
    for (const state of ['waiting', 'sent', 'done', 'lost']) await run(state, 300);
    await run('waiting', 1);
    await run('waiting', 1800);
    expect(await codeOf(run('queued', 300))).toBe('23514');
    expect(await codeOf(run('waiting', 0))).toBe('23514');
    expect(await codeOf(run('waiting', 1801))).toBe('23514');

    await db.execute(sql`insert into machine_access (machine_id, company_id) values (gen_random_uuid(), gen_random_uuid())`);
    await db.execute(sql`insert into machine_access (machine_id, company_id, asked_reason, asked_at) values (gen_random_uuid(), gen_random_uuid(), 'look', now())`);
    expect(await codeOf(db.execute(sql`insert into machine_access (machine_id, company_id, asked_reason) values (gen_random_uuid(), gen_random_uuid(), 'look')`))).toBe('23514');
  });
});

describe('migrations 0113 and 0114, the backups', () => {
  async function fullyMigrated(): Promise<PgliteDatabase> {
    const client = await freshInstall();
    const db = drizzle(client);
    await client.exec(AFTER_MIGRATIONS);
    /* No company or person stands behind the rows of these tests, which the check of that is told to let pass. */
    await client.exec(`SET session_replication_role = replica`);
    return db;
  }
  const codeOf = (work: Promise<unknown>): Promise<string | undefined> => work.then(() => undefined, (err: { code?: string; cause?: { code?: string } }) => err.cause?.code ?? err.code);

  it("adds each machine's age key and holdings, and the recovery keys, journaled and closed", async () => {
    const db = await fullyMigrated();
    await db.execute(sql`insert into machines (company_id, person_id, machine_key) values (gen_random_uuid(), gen_random_uuid(), 'a')`);
    expect((await db.execute(sql`select age_key, keeps_backups, held_backups from machines`)).rows).toEqual([{ age_key: null, keeps_backups: true, held_backups: [] }]);
    const tables = await db.execute<{ relname: string; closed: boolean; journaled: boolean }>(sql`select c.relname, c.relrowsecurity as closed,
      exists (select from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'net_journal') as journaled
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = 'recovery_keys'`);
    expect(tables.rows).toEqual([{ relname: 'recovery_keys', closed: true, journaled: true }]);
    const key = (recipient: string) => db.execute(sql`insert into recovery_keys (company_id, recipient, link_name, link_url, made_by) values (gen_random_uuid(), ${recipient}, 'acme', 'https://acme.hornhoof.org', gen_random_uuid())`);
    await key('age1first');
    expect(await codeOf(key('age1first'))).toBe('23505');
  });

  it('adds net.backups, fenced, with only the reasons, sizes and hashes there are', async () => {
    const db = await fullyMigrated();
    const fence = await db.execute<{ deferrable: boolean; deferred: boolean }>(sql`select t.tgdeferrable as deferrable, t.tginitdeferred as deferred from pg_trigger t
      where t.tgrelid = 'net.backups'::regclass and t.tgname = 'net_fence'`);
    expect(fence.rows).toEqual([{ deferrable: true, deferred: true }]);
    const backup = (over: { reason?: string; size?: number; sha256?: string } = {}) =>
      db.execute(sql`insert into net.backups (id, company_id, dumped_at, made_at, reason, size, sha256, signer, serial, recipients, migrations, head)
        values (gen_random_uuid(), gen_random_uuid(), now(), now(), ${over.reason ?? 'timer'}, ${over.size ?? 10}, ${over.sha256 ?? 'a'.repeat(64)}, gen_random_uuid(), 'ab', '{}', 106, '{}')`);
    await backup();
    await backup({ reason: 'update' });
    expect(await codeOf(backup({ reason: 'other' }))).toBe('23514');
    expect(await codeOf(backup({ size: 0 }))).toBe('23514');
    expect(await codeOf(backup({ sha256: 'XYZ' }))).toBe('23514');
    expect((await db.execute(sql`select holders from net.backups limit 1`)).rows).toEqual([{ holders: [] }]);
  });
});

describe('migration 0115, the merge records', () => {
  const RECORDS = ['merges', 'merge_rows', 'merge_conflicts', 'merge_consumed', 'restores', 'horizon'];

  async function fullyMigrated(): Promise<PgliteDatabase> {
    const client = await freshInstall();
    const db = drizzle(client);
    await client.exec(AFTER_MIGRATIONS);
    return db;
  }
  const codeOf = (work: Promise<unknown>): Promise<string | undefined> => work.then(() => undefined, (err: { code?: string; cause?: { code?: string } }) => err.cause?.code ?? err.code);

  it('adds the merge records, fenced', async () => {
    const db = await fullyMigrated();
    const fenced = await db.execute<{ name: string; deferrable: boolean; deferred: boolean }>(sql`select c.relname as name, t.tgdeferrable as deferrable, t.tginitdeferred as deferred
      from pg_class c join pg_trigger t on t.tgrelid = c.oid and t.tgname = 'net_fence'
      where c.relnamespace = 'net'::regnamespace and c.relname = any(${sql.raw(`'{${RECORDS.join(',')}}'`)}::text[]) order by c.relname`);
    expect(fenced.rows).toEqual([...RECORDS].sort().map(name => ({ name, deferrable: true, deferred: true })));
  });

  it('takes a fork among the reasons of a backup', async () => {
    const db = await fullyMigrated();
    const backup = (reason: string) =>
      db.execute(sql`insert into net.backups (id, company_id, dumped_at, made_at, reason, size, sha256, signer, serial, recipients, migrations, head)
        values (gen_random_uuid(), gen_random_uuid(), now(), now(), ${reason}, 10, ${'a'.repeat(64)}, gen_random_uuid(), 'ab', '{}', 107, '{}')`);
    for (const reason of ['timer', 'update', 'fork']) await backup(reason);
    expect(await codeOf(backup('other'))).toBe('23514');
  });

  it('takes only the merges, conflicts and rows there are', async () => {
    const db = await fullyMigrated();
    const merge = (source: string, status = 'pending') => db.execute<{ id: string }>(sql`insert into net.merges (source, label, status) values (${source}, 'a database', ${status}) returning id`);
    const id = (await merge('kept:hornhoof_before_20261110_090000')).rows[0]!.id;
    await merge('machine:0f0f');
    expect(await codeOf(merge('other:x'))).toBe('23514');
    expect(await codeOf(merge('kept:other', 'other'))).toBe('23514');
    expect(await codeOf(merge('kept:hornhoof_before_20261110_090000'))).toBe('23505');
    const conflict = (over: { kind?: string; op?: string; key?: string; carried?: string | null } = {}) =>
      db.execute(sql`insert into net.merge_conflicts (merge, carried, tbl, key, op, kind, topic, why)
        values (${id}, ${over.carried ?? null}, 'tasks', ${over.key ?? '{"id": "1"}'}::jsonb, ${over.op ?? 'update'}, ${over.kind ?? 'differs'}, 'work', 'Both changed it.')`);
    await conflict();
    expect(await codeOf(conflict({ kind: 'other' }))).toBe('23514');
    expect(await codeOf(conflict({ op: 'other' }))).toBe('23514');
    /* One conflict of a merge for a row, but for those carried from other databases, each by the id it had there. */
    expect(await codeOf(conflict())).toBe('23505');
    await conflict({ carried: '0f0f0f0f-0000-4000-8000-00000000000a' });
    await conflict({ carried: '0f0f0f0f-0000-4000-8000-00000000000b' });
    const row = (how: string) => db.execute(sql`insert into net.merge_rows (merge, tbl, key, how) values (${id}, 'tasks', '{"id": "1"}'::jsonb, ${how})`);
    await row('rewritten');
    expect(await codeOf(row('other'))).toBe('23514');
    /* The horizon is there from the start, a week back: whatever a build before pruned is older than that. */
    expect((await db.execute(sql`select below < now() - interval '6 days' and below > now() - interval '8 days' as a_week_back from net.horizon`)).rows).toEqual([{ a_week_back: true }]);
    expect(await codeOf(db.execute(sql`insert into net.horizon (id, below) values (false, now())`))).toBe('23514');
    expect(await codeOf(db.execute(sql`insert into net.horizon (below) values (now())`))).toBe('23505');
  });
});

describe('migration 0116, the server order and the copies', () => {
  async function fullyMigrated(): Promise<PgliteDatabase> {
    const client = await freshInstall();
    const db = drizzle(client);
    await client.exec(AFTER_MIGRATIONS);
    /* No company or person stands behind the rows of these tests, which the check of that is told to let pass. */
    await client.exec(`SET session_replication_role = replica`);
    return db;
  }
  const codeOf = (work: Promise<unknown>): Promise<string | undefined> => work.then(() => undefined, (err: { code?: string; cause?: { code?: string } }) => err.cause?.code ?? err.code);

  it("adds the server order and the copy's columns", async () => {
    const db = await fullyMigrated();
    const columns = await db.execute<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'machines'`);
    expect(columns.rows.map(row => row.column_name)).toEqual(
      expect.arrayContaining(['server_order', 'server_pin', 'server_why', 'memory', 'cores', 'copy_state', 'copy_progress', 'copy_error', 'copy_at', 'copy_name', 'copy_old', 'data_left_at', 'upload_state']),
    );
    expect((await db.execute(sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'public_links' and column_name = 'next_key_enc'`)).rows).toHaveLength(1);
    let made = 0;
    const machine = (column: string, value: string | number) =>
      db.execute(sql.raw(`insert into machines (company_id, person_id, machine_key, ${column}) values (gen_random_uuid(), gen_random_uuid(), 'm${made++}', ${typeof value === 'number' ? value : `'${value}'`})`));
    /* One machine to a place, and a place is 1 or more. */
    await machine('server_order', 2);
    expect(await codeOf(machine('server_order', 2))).toBe('23505');
    expect(await codeOf(machine('server_order', 0))).toBe('23514');
    /* Any number of machines never take the server, one machine to a pinned place, and a pinned place is 2 or more. */
    await machine('server_pin', 'none');
    await machine('server_pin', 'none');
    await machine('server_pin', '2');
    expect(await codeOf(machine('server_pin', '2'))).toBe('23505');
    expect(await codeOf(machine('server_pin', '1'))).toBe('23514');
    expect(await codeOf(machine('server_pin', 'x'))).toBe('23514');
    for (const state of ['making', 'remaking', 'ready', 'stopped']) await machine('copy_state', state);
    for (const error of ['disk_full', 'apply', 'led', 'setup']) await machine('copy_error', error);
    for (const state of ['waiting', 'received', 'kept']) await machine('upload_state', state);
    await machine('copy_progress', 0);
    await machine('copy_progress', 99);
    expect(await codeOf(machine('copy_state', 'other'))).toBe('23514');
    expect(await codeOf(machine('copy_error', 'other'))).toBe('23514');
    expect(await codeOf(machine('upload_state', 'other'))).toBe('23514');
    expect(await codeOf(machine('copy_progress', 100))).toBe('23514');
  });

  it('adds the pulse, fenced, and the sources of a merge a machine gives', async () => {
    const db = await fullyMigrated();
    const fenced = await db.execute<{ deferrable: boolean; deferred: boolean }>(sql`select t.tgdeferrable as deferrable, t.tginitdeferred as deferred
      from pg_class c join pg_trigger t on t.tgrelid = c.oid and t.tgname = 'net_fence' where c.relnamespace = 'net'::regnamespace and c.relname = 'pulse'`);
    expect(fenced.rows).toEqual([{ deferrable: true, deferred: true }]);
    await db.execute(sql`insert into net.pulse (at) values (now())`);
    expect(await codeOf(db.execute(sql`insert into net.pulse (at) values (now())`))).toBe('23505');
    expect(await codeOf(db.execute(sql`insert into net.pulse (id, at) values (false, now())`))).toBe('23514');
    const merge = (source: string, machine: string | null = null) => db.execute(sql`insert into net.merges (source, label, machine) values (${source}, 'a database', ${machine})`);
    await merge('upload:hornhoof_upload_0f0f0f0f0f0f0f0f_20261111t090000', '0f0f0f0f-0000-4000-8000-00000000000a');
    await merge('machine:0f0f0f0f-0000-4000-8000-00000000000a:1', '0f0f0f0f-0000-4000-8000-00000000000a');
    await merge('kept:hornhoof_before_20261110_090000');
    expect(await codeOf(merge('other:x'))).toBe('23514');
  });
});

describe('migration 0117, the measures of the server order', () => {
  async function fullyMigrated(): Promise<PgliteDatabase> {
    const client = await freshInstall();
    const db = drizzle(client);
    await client.exec(AFTER_MIGRATIONS);
    /* No company or person stands behind the rows of these tests, which the check of that is told to let pass. */
    await client.exec(`SET session_replication_role = replica`);
    return db;
  }
  const codeOf = (work: Promise<unknown>): Promise<string | undefined> => work.then(() => undefined, (err: { code?: string; cause?: { code?: string } }) => err.cause?.code ?? err.code);

  it("adds the measures and the ranking's row", async () => {
    const db = await fullyMigrated();
    const MEASURES = ['link_rtt_ms', 'link_mbps', 'internet_rtt_ms', 'internet_mbps'];
    const machine = (column: string, value: number | null) =>
      db.execute(sql`insert into machines (company_id, person_id, machine_key, ${sql.raw(column)}) values (gen_random_uuid(), gen_random_uuid(), ${`m-${column}-${String(value)}`}, ${value})`);
    for (const column of MEASURES) {
      /* A machine that has measured nothing yet has none, and nothing is less than nothing. */
      await machine(column, null);
      await machine(column, 0);
      expect(await codeOf(machine(column, -1)), column).toBe('23514');
    }
    const fenced = await db.execute<{ deferrable: boolean; deferred: boolean }>(sql`select t.tgdeferrable as deferrable, t.tginitdeferred as deferred
      from pg_class c join pg_trigger t on t.tgrelid = c.oid and t.tgname = 'net_fence' where c.relnamespace = 'net'::regnamespace and c.relname = 'ranking'`);
    expect(fenced.rows).toEqual([{ deferrable: true, deferred: true }]);
    await db.execute(sql`insert into net.ranking (rescored_at) values (now())`);
    expect(await codeOf(db.execute(sql`insert into net.ranking (rescored_at) values (now())`))).toBe('23505');
    expect(await codeOf(db.execute(sql`insert into net.ranking (id) values (false)`))).toBe('23514');
  });
});

describe('migration 0118, the tables of a server move', () => {
  async function fullyMigrated(): Promise<PgliteDatabase> {
    const client = await freshInstall();
    const db = drizzle(client);
    await client.exec(AFTER_MIGRATIONS);
    /* No company, person or machine stands behind the rows of these tests, which the check of that is told to let pass. */
    await client.exec(`SET session_replication_role = replica`);
    return db;
  }
  const codeOf = (work: Promise<unknown>): Promise<string | undefined> => work.then(() => undefined, (err: { code?: string; cause?: { code?: string } }) => err.cause?.code ?? err.code);
  const fencedOf = async (db: PgliteDatabase, table: string) =>
    (await db.execute<{ deferrable: boolean; deferred: boolean }>(sql`select t.tgdeferrable as deferrable, t.tginitdeferred as deferred
      from pg_class c join pg_trigger t on t.tgrelid = c.oid and t.tgname = 'net_fence' where c.relnamespace = 'net'::regnamespace and c.relname = ${table}`)).rows;
  const A = '0f0f0f0f-0000-4000-8000-00000000000a';
  const B = '0f0f0f0f-0000-4000-8000-00000000000b';

  it('holds one move', async () => {
    const db = await fullyMigrated();
    expect(await fencedOf(db, 'move')).toEqual([{ deferrable: true, deferred: true }]);
    const move = (state: string, reason: string | null, ended: boolean) =>
      db.execute(sql`insert into net.move (machine_id, from_machine_id, asked_by, asked_at, state, reason, ended_at) values (${A}, ${B}, ${A}, now(), ${state}, ${reason}, ${ended ? sql`now()` : sql`null`})`);
    /* A move that failed says why and when; one that goes on says neither. */
    for (const [state, reason, ended] of [['failed', 'behind', false], ['failed', null, true], ['preparing', 'behind', false], ['switching', null, true], ['preparing', 'behind', true], ['failed', 'late', true], ['done', null, false]] as const) {
      expect(await codeOf(move(state, reason, ended)), `${state} ${reason} ${ended}`).toBe('23514');
    }
    await move('preparing', null, false);
    const [made] = (await db.execute<{ request: string }>(sql`select request::text as request from net.move`)).rows;
    expect(made!.request).toMatch(/^[0-9a-f-]{36}$/);
    expect(await codeOf(move('preparing', null, false))).toBe('23505');
    await db.execute(sql`update net.move set state = 'failed', reason = 'no_answer', ended_at = now()`);
  });

  it('records a handover', async () => {
    const db = await fullyMigrated();
    expect(await fencedOf(db, 'handovers')).toEqual([{ deferrable: true, deferred: true }]);
    const slots = { ['0f'.repeat(16)]: 'copy_0f0f0f0f0f0f0f0f_2' };
    await db.execute(sql`insert into net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at, slots)
      values (gen_random_uuid(), ${A}, 4, ${'0f'.repeat(16)}, '0/3000000', ${B}, now(), ${JSON.stringify(slots)}::jsonb)`);
    expect((await db.execute<{ slots: object }>(sql`select slots from net.handovers`)).rows).toEqual([{ slots }]);
    expect(await codeOf(db.execute(sql`insert into net.handovers (id, from_machine_id, term_number, term_machine, to_machine_id, at) values (gen_random_uuid(), ${A}, 4, 'm', ${B}, now())`))).toBe('23502');
    /* One with no slot to say holds none. */
    await db.execute(sql`insert into net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at) values (gen_random_uuid(), ${A}, 5, 'm', '0/4000000', ${B}, now())`);
    expect((await db.execute(sql`select 1 from net.handovers where slots = '{}'::jsonb`)).rows).toHaveLength(1);
  });

  it("names a built-in node's machine", async () => {
    const db = await fullyMigrated();
    for (const table of ['jobs', 'agents', 'test_parts']) {
      const [{ n }] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = 'builtin_machine' and data_type = 'text' and is_nullable = 'YES'`)).rows as [{ n: number }];
      expect(n, table).toBe(1);
      const [check] = (await db.execute<{ def: string }>(sql`select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname = ${table} and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%builtin_machine%'`)).rows;
      expect(check?.def, table).toContain('^[0-9a-f]{32}([0-9a-f]{32})?$');
    }
    /* A network id of either length, in lowercase hex, and nothing else. */
    const said = async (value: string) => (await db.execute<{ ok: boolean }>(sql`select ${value} ~ '^[0-9a-f]{32}([0-9a-f]{32})?$' as ok`)).rows[0]!.ok;
    expect([await said('0f'.repeat(16)), await said('0f'.repeat(32)), await said('ABC'), await said('0'.repeat(33))]).toEqual([true, true, false, false]);
  });

  it('records the handover a state ended with', async () => {
    const db = await fullyMigrated();
    await db.execute(sql`insert into net_local.state (term_number, term_machine, machine, cluster) values (1, 'm', 'm', 'c')`);
    await db.execute(sql`update net_local.state set handed_to = ${'0f'.repeat(16)}, handed_lsn = '0/3000000', handed_at = now()`);
    for (const one of ['handed_to', 'handed_lsn', 'handed_at']) expect(await codeOf(db.execute(sql`update net_local.state set ${sql.raw(one)} = null`)), one).toBe('23514');
    await db.execute(sql`update net_local.state set handed_to = null, handed_lsn = null, handed_at = null`);
  });
});


describe('migration 0119, the tables of takeovers, parked job results and the hidden link', () => {
  async function fullyMigrated(): Promise<PgliteDatabase> {
    const client = await freshInstall();
    const db = drizzle(client);
    await client.exec(AFTER_MIGRATIONS);
    /* No company, person or machine stands behind the rows of these tests, which the check of that is told to let pass. */
    await client.exec(`SET session_replication_role = replica`);
    return db;
  }
  const codeOf = (work: Promise<unknown>): Promise<string | undefined> => work.then(() => undefined, (err: { code?: string; cause?: { code?: string } }) => err.cause?.code ?? err.code);
  const A = '0f0f0f0f-0000-4000-8000-00000000000a';
  const B = '0f0f0f0f-0000-4000-8000-00000000000b';

  it('records the kind of each handover', async () => {
    const db = await fullyMigrated();
    const handover = (more = sql``, values = sql``) =>
      db.execute(sql`insert into net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at${more}) values (gen_random_uuid(), ${A}, 4, 'm', '0/3000000', ${B}, now()${values})`);
    /* One that says nothing of its kind was planned. */
    await handover();
    expect((await db.execute(sql`select kind, heard_at, reach, noted_at, reason from net.handovers`)).rows).toEqual([{ kind: 'planned', heard_at: null, reach: null, noted_at: null, reason: null }]);
    await handover(sql`, kind, heard_at, reach, reason`, sql`, 'takeover', now(), now(), 'disk_full'`);
    await handover(sql`, kind, noted_at`, sql`, 'ceo', now()`);
    expect(await codeOf(handover(sql`, kind`, sql`, 'other'`))).toBe('23514');
    expect(await codeOf(handover(sql`, reason`, sql`, 'other'`))).toBe('23514');
  });

  it("parks a job's messages", async () => {
    const db = await fullyMigrated();
    const fenced = (await db.execute<{ deferrable: boolean; deferred: boolean }>(sql`select t.tgdeferrable as deferrable, t.tginitdeferred as deferred
      from pg_class c join pg_trigger t on t.tgrelid = c.oid and t.tgname = 'net_fence' where c.relnamespace = 'net'::regnamespace and c.relname = 'parked'`)).rows;
    expect(fenced).toEqual([{ deferrable: true, deferred: true }]);
    const node = { kind: 'machine', id: A };
    const park = (kind: string) => db.execute(sql`insert into net.parked (job_id, node, kind, body) values (${B}, ${JSON.stringify(node)}::jsonb, ${kind}, '{"n":1}'::jsonb)`);
    for (const kind of ['listed', 'started', 'event', 'done']) await park(kind);
    expect(await codeOf(park('other'))).toBe('23514');
    const rows = (await db.execute<{ node: object; body: object; applied_at: Date | null; at: Date | string }>(sql`select node, body, applied_at, at from net.parked where kind = 'event'`)).rows;
    expect(rows).toHaveLength(1);
    expect([rows[0]!.node, rows[0]!.body, rows[0]!.applied_at, rows[0]!.at === null]).toEqual([node, { n: 1 }, null, false]);
    /* The messages of one job are found by it. */
    expect((await db.execute(sql`select 1 from pg_indexes where schemaname = 'net' and tablename = 'parked' and indexname = 'parked_job'`)).rows).toHaveLength(1);
  });

  it('keeps the led term of an old database, hides a link, and knows a copy that saves what it led', async () => {
    const db = await fullyMigrated();
    const column = async (table: string, name: string) =>
      (await db.execute<{ type: string; nullable: string; def: string | null }>(sql`select data_type as type, is_nullable as nullable, column_default as def from information_schema.columns
        where table_schema = 'public' and table_name = ${table} and column_name = ${name}`)).rows[0];
    expect(await column('machines', 'copy_old_led')).toEqual({ type: 'bigint', nullable: 'YES', def: null });
    expect(await column('public_links', 'hidden')).toEqual({ type: 'boolean', nullable: 'NO', def: 'false' });
    const [check] = (await db.execute<{ def: string }>(sql`select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname = 'machines' and c.conname = 'machines_copy_state'`)).rows;
    for (const state of ['making', 'remaking', 'ready', 'stopped', 'saving']) expect(check?.def, state).toContain(`'${state}'`);
    expect(check?.def).not.toContain('other');
  });
});

describe('migration 0131, the fallbacks of a plan', () => {
  it('gives every plan an empty list of fallbacks, keeps the plans and cards as they were, and puts nobody on a fallback', async () => {
    const client = await olderInstall('0129_builtin_node_connections');
    const db = drizzle(client);
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const owner = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind, is_owner) values (${company}, 'Ivan', 'ivan@acme.example', 'active', 'company', true) returning id`)).rows[0]!.id;
    const plan = (await db.execute<{ id: string }>(sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status, budget) values (${company}, 'antigravity', 'personal', 'Plan', ${owner}, 'ready', 70) returning id`)).rows[0]!.id;
    await db.execute(sql`insert into subscriptions (company_id, provider, kind, label, owner_person_id, status) values (${company}, 'codex', 'personal', 'Spare', ${owner}, 'ready')`);
    const dept = (await db.execute<{ id: string }>(sql`insert into departments (company_id, template_key, role_code) values (${company}, 'development', 'DEV') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into agents (company_id, kind, name, department_id, model, effort, subscription_id) values (${company}, 'worker', 'Bruno', ${dept}, 'gemini-4-argon', 'high', ${plan})`);
    const plans = async () => (await db.execute(sql`select to_jsonb(s) - 'fallbacks' as data from subscriptions s order by id`)).rows;
    const cards = async () => (await db.execute(sql`select to_jsonb(a) as data from agents a order by id`)).rows;
    const before = { plans: await plans(), cards: await cards() };

    const target = await migrationsUpTo('0131_plan_fallbacks');
    await migrate(db, { migrationsFolder: target });
    await migrate(db, { migrationsFolder: target });

    expect({ plans: await plans(), cards: await cards() }).toEqual(before);
    expect((await db.execute(sql`select fallbacks from subscriptions order by id`)).rows).toEqual([{ fallbacks: [] }, { fallbacks: [] }]);
    expect((await db.execute(sql`select count(*)::int as n from agent_fallbacks`)).rows).toEqual([{ n: 0 }]);
  });
});
