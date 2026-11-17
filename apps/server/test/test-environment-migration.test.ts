import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';

import { migrationsBefore } from './migrations-before.js';
import { freshPglite } from './helpers-db.js';
type Db = ReturnType<typeof drizzle>;
async function open() {
  const client = await freshPglite(); onTestFinished(() => client.close()); return drizzle(client);
}
const id = async (db: Db, query: ReturnType<typeof sql>) => (await db.execute<{ id: string }>(query)).rows[0].id;
async function legacyRun(db: Db, name: string, singleton: boolean) {
  const company = await id(db, sql`insert into companies(name,singleton) values(${name},${singleton}) returning id`);
  const person = await id(db, sql`insert into people(company_id,name,email,status,scope_kind) values(${company},${name},${`${name}@example.test`},'active','company') returning id`);
  const subscription = await id(db, sql`insert into subscriptions(company_id,provider,kind,label,owner_person_id,status) values(${company},'codex','personal','Plan',${person},'ready') returning id`);
  const agent = await id(db, sql`insert into agents(company_id,kind,name,model,subscription_id) values(${company},'worker','Developer','',${subscription}) returning id`);
  const task = await id(db, sql`insert into tasks(company_id,number,title) values(${company},1,'Legacy task') returning id`);
  const job = await id(db, sql`insert into jobs(company_id,subscription_id,agent_id,prompt,timeout_ms) values(${company},${subscription},${agent},'Run tests',60000) returning id`);
  const run = await id(db, sql`insert into test_runs(company_id,number,task_id,agent_id,job_id,command,timeout_ms,status) values(${company},1,${task},${agent},${job},'npm test',60000,'passed') returning id`);
  await db.execute(sql`insert into test_parts(company_id,run_id,part,status) values(${company},${run},1,'passed')`);
  return run;
}
async function columns(db: Db) {
  return (await db.execute<{ table_name: string; column_name: string; is_nullable: string }>(sql`select table_name,column_name,is_nullable from information_schema.columns where table_name in ('test_runs','test_parts') and column_name like 'environment_%' order by table_name,column_name`)).rows;
}
const expectedColumns = [
  { table_name: 'test_parts', column_name: 'environment_receipt', is_nullable: 'YES' },
  { table_name: 'test_parts', column_name: 'environment_selection', is_nullable: 'YES' },
  { table_name: 'test_runs', column_name: 'environment_hash', is_nullable: 'YES' },
  { table_name: 'test_runs', column_name: 'environment_request', is_nullable: 'YES' },
  { table_name: 'test_runs', column_name: 'environment_snapshot', is_nullable: 'YES' },
];

it('migrates existing runs of every company without certifying or changing their old evidence', async () => {
  const before = await migrationsBefore('test_environment_runs'), db = await open(); await migrate(db, { migrationsFolder: before });
  await legacyRun(db, 'Acme', true); await legacyRun(db, 'Other', false);
  const original = (await db.execute(sql`select id,command,status,parts,commit_sha from test_runs order by id`)).rows;
  await migrate(db, { migrationsFolder: MIGRATIONS });
  expect(await columns(db)).toEqual(expectedColumns);
  expect((await db.execute(sql`select id,command,status,parts,commit_sha from test_runs order by id`)).rows).toEqual(original);
  expect((await db.execute(sql`select environment_snapshot,environment_hash,environment_request from test_runs`)).rows).toEqual(Array.from({ length: 2 }, () => ({ environment_snapshot: null, environment_hash: null, environment_request: null })));
  expect((await db.execute(sql`select environment_receipt,environment_selection from test_parts`)).rows).toEqual(Array.from({ length: 2 }, () => ({ environment_receipt: null, environment_selection: null })));
  await db.execute(sql`insert into test_runs(company_id,number,task_id,agent_id,job_id,command,timeout_ms) select company_id,2,task_id,agent_id,job_id,command,timeout_ms from test_runs where number=1`);
  expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from test_runs`)).rows[0].n).toBe(4);
});

it('adds nullable environment evidence and request lookup on a fresh database', async () => {
  const db = await open(); await migrate(db, { migrationsFolder: MIGRATIONS });
  expect(await columns(db)).toEqual(expectedColumns);
  expect((await db.execute(sql`select indexname from pg_indexes where indexname='test_runs_environment_request'`)).rows).toEqual([{ indexname: 'test_runs_environment_request' }]);
});
