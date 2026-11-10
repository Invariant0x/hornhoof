import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { freshPglite, ownDatabases } from './helpers-db.js';
import { migrationsThrough } from './migrations-before.js';
import { migrate, migrationsUpTo } from './migrations-fixture.js';

ownDatabases();

// Each test runs every migration on a copy as big as a real company's, which takes as long as the machine needs, so
// none of them has a time limit.
describe('migration 0049', () => {
  it.each(['Acme', 'Moonfern'])('adds history indexes on an upgraded %s copy without changing old events', { timeout: 0 }, async name => {
    const source = await freshPglite();
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
  it.each(['Acme', 'Moonfern'])('keeps old prompts in %s without inventing their requested text', { timeout: 0 }, async name => {
    const source = await freshPglite();
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
    /* The merged 0046/0047 prefix adds four nullable fields; every older field stays identical. */
    const oldJobs = sql`select count(*)::int as n,
      md5(jsonb_agg(to_jsonb(j) - array['requested_prompt', 'failure', 'not_before', 'restarted_at'] order by id)::text) as checksum from jobs j`;
    const before = (await db.execute(oldJobs)).rows;
    /* Upgrade a copy, leaving the generated older installation intact. */
    const copy = new PGlite({ loadDataDir: await source.dumpDataDir('none') });
    onTestFinished(() => copy.close());
    db = drizzle(copy);

    const target = await migrationsThrough('requested_prompt');
    await migrate(db, { migrationsFolder: target });
    await migrate(db, { migrationsFolder: target });

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
