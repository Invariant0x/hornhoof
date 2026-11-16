import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';
import { freshPglite } from './helpers-db.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

describe('durable wait notices migration', () => {
  it('creates an empty outbox with durable deduplication and a pending index on a fresh database', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const tables = await db.execute(sql`select table_name from information_schema.tables where table_name = 'wait_notices'`);
    expect(tables.rows).toEqual([{ table_name: 'wait_notices' }]);
    const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`select indexname, indexdef from pg_indexes where tablename = 'wait_notices'`);
    expect(indexes.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ indexname: 'wait_notices_dedup', indexdef: expect.stringContaining('UNIQUE') }),
      expect.objectContaining({ indexname: 'wait_notices_pending', indexdef: expect.stringContaining('delivered_at IS NULL') }),
    ]));
    expect((await db.execute(sql`select * from wait_notices`)).rows).toEqual([]);
  });

  it('upgrades the previous schema twice with existing legacy waits and wakes intact', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsBefore('task_wait_notices') });
    await db.execute(sql`insert into companies(name) values ('Acme')`);
    await db.execute(sql`insert into agents(company_id,kind,name,model) select id,'worker','Bruno','' from companies`);
    await db.execute(sql`insert into tasks(company_id,number,title,external_wait) select id,1,'Acceptance','{"reason":"Machine","since":"2026-11-04T16:00:00Z","until":"2026-11-04T17:00:00Z"}'::jsonb from companies`);
    await db.execute(sql`insert into pending_wakes(company_id,agent_id,task_id,why) select a.company_id,a.id,t.id,'comment' from agents a join tasks t on t.company_id=a.company_id`);
    const beforeTasks = (await db.execute(sql`select to_jsonb(t) as data from tasks t`)).rows;
    const beforeWakes = (await db.execute(sql`select to_jsonb(w) as data from pending_wakes w`)).rows;
    const upgraded = await migrationsThrough('task_wait_notices');
    await migrate(db, { migrationsFolder: upgraded });
    await migrate(db, { migrationsFolder: upgraded });
    expect((await db.execute(sql`select to_jsonb(t) as data from tasks t`)).rows).toEqual(beforeTasks);
    expect((await db.execute(sql`select to_jsonb(w) as data from pending_wakes w`)).rows).toEqual(beforeWakes);
    expect((await db.execute(sql`select table_name from information_schema.tables where table_name = 'wait_notices'`)).rows).toHaveLength(1);
  });

  /* Two companies with every kind of source open, and what is over beside them. Each thing that exists today keeps its facts. */
  async function beforeWaits() {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsBefore('task_wait_ownership') });
    const one = async <T,>(statement: ReturnType<typeof sql>) => (await db.execute<T & Record<string, unknown>>(statement)).rows[0]!;
    const company = (name: string, singleton: boolean) => one<{ id: string }>(sql`insert into companies(name,singleton) values (${name},${singleton}) returning id`);
    const agent = (companyId: string, name: string) => one<{ id: string }>(sql`insert into agents(company_id,kind,name,model) values (${companyId},'worker',${name},'') returning id`);
    const task = (companyId: string, number: number, fields: { status?: string; assignee?: string; wait?: object; after?: string[]; panel?: string[]; bounces?: number; stage?: number; closed?: boolean }) => one<{ id: string }>(sql`
      insert into tasks(company_id,number,title,status,assignee_agent_id,executor_agent_id,external_wait,after,panel,bounces,stage,closed_at)
      values (${companyId},${number},${`Task ${number}`},${fields.status ?? 'working'},${fields.assignee ?? null},${fields.assignee ?? null},${fields.wait ? JSON.stringify(fields.wait) : null}::jsonb,
        ${JSON.stringify(fields.after ?? [])}::jsonb,${JSON.stringify(fields.panel ?? [])}::jsonb,${fields.bounces ?? 0},${fields.stage ?? 0},${fields.closed ? new Date().toISOString() : null})
      returning id`);
    return { client, db, one, company, agent, task };
  }

  const WAIT = { reason: 'Machine', since: '2026-11-04T16:00:00Z', until: '2026-11-04T17:00:00Z' };

  it('gives every open source of every company a wait with no plan, and makes up no date or alarm', async () => {
    const { db, one, company, agent, task } = await beforeWaits();
    const [acme, other] = [await company('Acme', true), await company('Other', false)];
    const [bruno, rita, sam] = [await agent(acme.id, 'Bruno'), await agent(acme.id, 'Rita'), await agent(other.id, 'Sam')];
    const onEmployee = await task(acme.id, 1, { assignee: bruno.id, wait: { ...WAIT, on: { kind: 'employee', name: 'Rita', employee: rita.id } } });
    const onEvent = await task(other.id, 2, { assignee: sam.id, wait: { ...WAIT, on: { kind: 'external', event: 'machine' } } });
    const prerequisite = await task(acme.id, 3, { assignee: rita.id });
    const finished = await task(acme.id, 4, { status: 'done', closed: true });
    const following = await task(acme.id, 5, { assignee: bruno.id, after: [prerequisite.id, finished.id, prerequisite.id] });
    const reviewed = await task(acme.id, 6, { status: 'review', assignee: rita.id, panel: [bruno.id, rita.id], bounces: 2, stage: 1 });
    await db.execute(sql`insert into task_events(company_id,task_id,kind,agent_id,text,data) values (${acme.id},${reviewed.id},'verdict',${bruno.id},'Fine.',${JSON.stringify({ pass: true, stage: 1, round: 2 })}::jsonb)`);
    await db.execute(sql`insert into task_events(company_id,task_id,kind,agent_id,text,data) values (${acme.id},${reviewed.id},'verdict',${rita.id},'An old round.',${JSON.stringify({ pass: true, stage: 1, round: 1 })}::jsonb)`);
    const asked = await one<{ id: string }>(sql`insert into requests(company_id,task_id,agent_id,kind,text) values (${acme.id},${following.id},${bruno.id},'question','Which one?') returning id`);
    await db.execute(sql`insert into requests(company_id,task_id,agent_id,kind,text,status) values (${acme.id},${following.id},${bruno.id},'question','Answered.','answered')`);
    const ann = await one<{ id: string }>(sql`insert into people(company_id,name,email,status,scope_kind) values (${acme.id},'Ann','ann@example.test','active','company') returning id`);
    const plan = await one<{ id: string }>(sql`insert into subscriptions(company_id,provider,kind,label,owner_person_id,status) values (${acme.id},'claude','personal','Plan',${ann.id},'ready') returning id`);
    const job = await one<{ id: string }>(sql`insert into jobs(company_id,subscription_id,agent_id,kind,prompt,timeout_ms,status) values (${acme.id},${plan.id},${bruno.id},'conversation','Work.',60000,'running') returning id`);
    const running = await one<{ id: string }>(sql`insert into test_runs(company_id,number,task_id,agent_id,job_id,kind,command,parts,timeout_ms,status) values (${acme.id},1,${following.id},${bruno.id},${job.id},'test','npm test',1,60000,'running') returning id`);
    await db.execute(sql`insert into test_runs(company_id,number,task_id,agent_id,job_id,kind,command,parts,timeout_ms,status,finished_at) values (${acme.id},2,${following.id},${bruno.id},${job.id},'test','npm test',1,60000,'passed',now())`);
    await db.execute(sql`insert into test_parts(company_id,run_id,part,environment_selection,environment_receipt) values (${acme.id},${running.id},1,'{"selection":"kept","after":[]}'::jsonb,'{"digest":"kept"}'::jsonb)`);
    const facts = async (table: string) => (await db.execute(sql.raw(`select to_jsonb(r) as data from ${table} r order by id`))).rows;
    const [runs, parts, requests, before] = [await facts('test_runs'), await facts('test_parts'), await facts('requests'), await facts('tasks')];
    const upgraded = await migrationsThrough('task_wait_ownership');

    await migrate(db, { migrationsFolder: upgraded });

    const operation = async (id: string) => (await one<{ op: string }>(sql`select external_wait->>'operation' as op from tasks where id=${id}`)).op;
    const rows = (await db.execute<{ task_id: string; kind: string; source_key: string; owner_agent_id: string | null; company_id: string; source_state: object }>(sql`select * from task_waits`)).rows;
    const seen = rows.map(row => [row.company_id, row.task_id, row.kind, row.source_key, row.owner_agent_id]).sort();
    expect(seen).toEqual([
      [acme.id, onEmployee.id, 'external', `wait_for:${await operation(onEmployee.id)}`, rita.id],
      [other.id, onEvent.id, 'external', `wait_for:${await operation(onEvent.id)}`, sam.id],
      [acme.id, following.id, 'after', `task:${prerequisite.id}`, rita.id],
      [acme.id, reviewed.id, 'review', `review:${reviewed.id}:2:${rita.id}`, rita.id],
      [acme.id, following.id, 'person', `request:${asked.id}`, null],
      [acme.id, following.id, 'run', `run:${running.id}`, bruno.id],
    ].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        state: 'legacy_needs_plan', generation: 1, level: 0, source_revision: 0, plan: null, owner_due_at: null, head_due_at: null, decision_due_at: null, next_action_at: null, next_review_at: null, review_ordinal: 0,
        attention_agent_id: null, final_decision_person_id: null, fallback_to_ceo: false, outcome: null, proof_ref: null, ended_at: null,
      });
    }
    expect((await db.execute(sql`select id from wait_notices`)).rows).toEqual([]);
    expect(await facts('test_runs')).toEqual(runs);
    expect(await facts('test_parts')).toEqual(parts);
    expect(await facts('requests')).toEqual(requests);
    expect(await facts('tasks')).toEqual(before.map(({ data }) => {
      const kept = data as { external_wait: object | null };
      return { data: kept.external_wait ? { ...kept, external_wait: { ...kept.external_wait, operation: expect.stringMatching(new RegExp(`^${UUID}$`)) as string } } : kept };
    }));
    const operations = new Set([await operation(onEmployee.id), await operation(onEvent.id)]);
    expect(operations.size).toBe(2);
    for (const op of operations) expect(op).toMatch(new RegExp(`^${UUID}$`));
    await migrate(db, { migrationsFolder: upgraded });
    expect((await db.execute(sql`select id from task_waits`)).rows).toHaveLength(rows.length);
  });

  it('leaves no wait behind on a closed task, whatever its row still says', async () => {
    const { db, company, agent, task } = await beforeWaits();
    const acme = await company('Acme', true);
    const bruno = await agent(acme.id, 'Bruno');
    const closed = await task(acme.id, 1, { status: 'cancelled', closed: true, wait: WAIT });
    await task(acme.id, 2, { status: 'done', closed: true, after: [closed.id], panel: [bruno.id] });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await db.execute(sql`select id from task_waits`)).rows).toEqual([]);
    expect((await db.execute<{ w: object }>(sql`select external_wait as w from tasks where id=${closed.id}`)).rows[0]!.w).toEqual(WAIT);
  });

  it('creates the private tables empty, seeding no policy for any company', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await db.execute(sql`select id from task_waits`)).rows).toEqual([]);
    expect((await db.execute(sql`select id from wait_policies`)).rows).toEqual([]);
    const indexes = await db.execute<{ indexname: string; indexdef: string }>(sql`select indexname, indexdef from pg_indexes where tablename in ('task_waits', 'wait_notices')`);
    expect(indexes.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ indexname: 'task_waits_open_source', indexdef: expect.stringContaining('UNIQUE') }),
      expect.objectContaining({ indexname: 'wait_notices_one_per_level', indexdef: expect.stringContaining('UNIQUE') }),
    ]));
  });
});
