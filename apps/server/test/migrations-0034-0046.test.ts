import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { hashToken } from '../src/crypto/tokens.js';
import { tasks } from '../src/db/schema.js';
import { appOn, approvalAsked, as } from './helpers.js';
import { freshPglite, ownDatabases } from './helpers-db.js';
import { migrationsThrough } from './migrations-before.js';
import { freshInstall, migrate, migrationsUpTo } from './migrations-fixture.js';

ownDatabases();

describe('migrations 0034 to 0037', () => {
  const C = '00000000-0000-4000-8000-000000000001';
  const P = '00000000-0000-4000-8000-000000000002';
  const A = '00000000-0000-4000-8000-0000000000b1';
  const T = '00000000-0000-4000-8000-0000000000d1';
  const R = '00000000-0000-4000-8000-0000000000e1';
  const S = '00000000-0000-4000-8000-0000000000c1';

  it('keeps how long an older part waits and that it ran nowhere before, older runs as test runs and older machines as computers', async () => {
    const client = await freshPglite();
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
    await db.execute(sql`insert into machines (company_id, person_id, machine_key, hostname) values (${C}, ${P}, 'mac-0001-abcd', 'dev-mac')`);

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
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0037_work_repeatable') });
    const C = '00000000-0000-4000-8000-000000000001';
    const P = '00000000-0000-4000-8000-000000000002';
    const S = '00000000-0000-4000-8000-0000000000c1';
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    await db.execute(sql`insert into people (id, company_id, name, email, status, scope_kind) values (${P}, ${C}, 'Ivan', 'ivan@acme.com', 'active', 'company')`);
    await db.execute(sql`insert into subscriptions (id, company_id, provider, kind, label, status, owner_person_id) values (${S}, ${C}, 'claude', 'personal', 'Claude', 'ready', ${P})`);
    await db.execute(sql`insert into machines (id, company_id, person_id, machine_key, hostname) values (${S}, ${C}, ${P}, 'mac-0001-abcd', 'dev-mac')`);
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
    const client = await freshPglite();
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
    const client = await freshPglite();
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
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsUpTo('0043_turn_exits') });
    await db.execute(sql`insert into companies (id, name) values (${C}, 'Acme')`);
    const person = async (name: string, status: string, scope: string, owner: boolean) =>
      (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind, is_owner) values (${C}, ${name}, ${`${name.toLowerCase()}@acme.com`}, ${status}, ${scope}, ${owner}) returning id`)).rows[0]!.id;
    const ivan = await person('Ivan', 'active', 'company', true);
    const daniel = await person('Daniel', 'active', 'company', false);
    const zoe = await person('Zoe', 'active', 'company', false);
    await person('Dana', 'active', 'listed', false);
    await person('Ilya', 'invited', 'company', false);
    await person('Olga', 'disabled', 'company', false);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect.soft((await db.execute(sql`select name, is_owner, is_ceo_delegate from people order by name`)).rows).toEqual([
      { name: 'Dana', is_owner: false, is_ceo_delegate: false },
      { name: 'Daniel', is_owner: false, is_ceo_delegate: false },
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
    for (const id of [daniel, zoe]) {
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
    const client = await freshInstall();
    const db = drizzle(client);

    const indexes = await db.execute(sql`select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'tasks' and indexname in ('tasks_turn_id', 'tasks_product_id') order by indexname`);
    expect(indexes.rows).toEqual([
      { indexname: 'tasks_product_id', indexdef: 'CREATE INDEX tasks_product_id ON public.tasks USING btree (product_id)' },
      { indexname: 'tasks_turn_id', indexdef: 'CREATE INDEX tasks_turn_id ON public.tasks USING btree (turn_id)' },
    ]);
  });

  it('upgrades existing tasks intact and uses the indexes for turn and product reads', async () => {
    const client = await freshPglite();
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
    const fingerprint = sql`select count(*)::int as n, md5(string_agg(to_jsonb(t)::text, '' order by number)) as checksum from tasks t`;
    const before = await db.execute(fingerprint);
    expect(before.rows[0]).toMatchObject({ n: 20001 });

    const target = await migrationsThrough('task_lookup_indexes');
    await migrate(db, { migrationsFolder: target });
    await migrate(db, { migrationsFolder: target });
    expect((await db.execute(fingerprint)).rows).toEqual(before.rows);
    await db.execute(sql`analyze tasks`);

    const turn = await db.execute<{ 'QUERY PLAN': string }>(sql`explain select * from tasks
      where company_id = ${C} and turn_id = ${TURN} order by number`);
    const product = await db.execute<{ 'QUERY PLAN': string }>(sql`explain select * from tasks
      where company_id = ${C} and department_id = ${D} and product_id in (${PRODUCT})`);
    const turnPlan = turn.rows.map(r => r['QUERY PLAN']).join('\n');
    const productPlan = product.rows.map(r => r['QUERY PLAN']).join('\n');
    expect(turnPlan).toContain('Index Scan on tasks_turn_id');
    expect(productPlan).toContain('Index Scan on tasks_product_id');
    expect((await db.execute(sql`select count(*)::int as n from tasks where turn_id = ${TURN}`)).rows).toEqual([{ n: 200 }]);
    expect((await db.execute(sql`select count(*)::int as n from tasks where product_id = ${PRODUCT}`)).rows).toEqual([{ n: 200 }]);
  });
});

describe('migration 0046', () => {
  it('recovers a missing migration below the newest recorded timestamp exactly once', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    const client = await freshInstall();
    const db = drizzle(client);
    await db.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('another branch', 1793700000001)`);
    const before = (await db.execute(sql`select * from drizzle.__drizzle_migrations order by id`)).rows;
    await db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = 1793700000000`);
    await db.execute(sql`alter table jobs drop column failure, drop column not_before, drop column restarted_at`);
    await db.execute(sql`drop index agent_events_failure_case`);
    await db.execute(sql`drop index agent_events_operations_pending`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const retryIndex = await db.execute(sql`select split_part(indexdef, ' WHERE ', 1) as definition,
      regexp_replace(split_part(indexdef, ' WHERE ', 2), '[()]', '', 'g') as predicate
      from pg_indexes where schemaname = 'public' and indexname = 'jobs_agent_conversation_retry_waiting'`);
    expect(retryIndex.rows, 'the recovered database has the 0172 retry index').toEqual([{
      definition: 'CREATE INDEX jobs_agent_conversation_retry_waiting ON public.jobs USING btree (company_id, agent_id, created_at)',
      predicate: "kind = 'conversation'::text AND status = 'queued'::text AND not_before IS NOT NULL AND continue_of IS NOT NULL",
    }]);
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
    const client = await freshInstall();
    const db = drizzle(client);
    await db.execute(sql`update drizzle.__drizzle_migrations set hash = 'old file' where created_at = 1793700000000`);
    const before = (await db.execute(sql`select * from drizzle.__drizzle_migrations order by id`)).rows;

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect((await db.execute(sql`select * from drizzle.__drizzle_migrations order by id`)).rows).toEqual(before);
    expect(logged).not.toHaveBeenCalled();
  });

  it.each([['agent_events_failure_case', 'failureCase'], ['agent_events_operations_pending', 'operationsPending']])('indexes %s only when %s is present', async (name, field) => {
    const client = await freshPglite();
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
    const client = await freshPglite();
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
