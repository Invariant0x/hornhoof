import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { migrationsBefore } from './migrations-before.js';
import { freshPglite, openTestDb } from './helpers-db.js';

type Db = ReturnType<typeof drizzle>;
async function open(): Promise<Db> {
  const client = await freshPglite(); onTestFinished(() => client.close()); return drizzle(client);
}
const id = async (db: Db, query: ReturnType<typeof sql>) => (await db.execute<{ id: string }>(query)).rows[0]!.id;
async function legacyRun(db: Db) {
  const company = await id(db, sql`insert into companies(name,singleton) values('Acme',true) returning id`);
  const person = await id(db, sql`insert into people(company_id,name,email,status,scope_kind) values(${company},'Ann','ann@example.test','active','company') returning id`);
  const subscription = await id(db, sql`insert into subscriptions(company_id,provider,kind,label,owner_person_id,status) values(${company},'codex','personal','Plan',${person},'ready') returning id`);
  const agent = await id(db, sql`insert into agents(company_id,kind,name,model,subscription_id) values(${company},'worker','Developer','',${subscription}) returning id`);
  const task = await id(db, sql`insert into tasks(company_id,number,title) values(${company},1,'Task') returning id`);
  const job = await id(db, sql`insert into jobs(company_id,subscription_id,agent_id,prompt,timeout_ms) values(${company},${subscription},${agent},'Run tests',60000) returning id`);
  const department = await id(db, sql`insert into departments(company_id,template_key,role_code) values(${company},'development','DEV') returning id`);
  const run = await id(db, sql`insert into test_runs(company_id,number,task_id,agent_id,job_id,department_id,command,timeout_ms,status) values(${company},1,${task},${agent},${job},${department},'npm test',60000,'passed') returning id`);
  await db.execute(sql`insert into test_parts(company_id,run_id,part,status) values(${company},${run},1,'passed')`);
  return { company, department, run };
}
const greenRow = (found: { company: string; department: string; run: string }, fingerprint: string) =>
  sql`insert into test_file_results(company_id,repository_owner_id,repo_url_hash,fingerprint,suite_id,file,run_id,commit_sha) values(${found.company},${found.department},${'f'.repeat(64)},${fingerprint},'unit','a.test.ts',${found.run},${'a'.repeat(40)})`;

it('leaves the runs of a database at the previous release as they were', async () => {
  const before = await migrationsBefore('test_result_reuse'), db = await open();
  await migrate(db, { migrationsFolder: before });
  const found = await legacyRun(db);
  const was = (await db.execute(sql`select id,command,status,parts from test_runs`)).rows;
  await migrate(db, { migrationsFolder: MIGRATIONS });
  expect((await db.execute(sql`select id,command,status,parts from test_runs`)).rows).toEqual(was);
  expect((await db.execute(sql`select file_cache from test_runs`)).rows).toEqual([{ file_cache: null }]);
  expect((await db.execute(sql`select failed_files from test_parts`)).rows).toEqual([{ failed_files: null }]);
  await db.execute(greenRow(found, 'b'.repeat(64)));
  await expect(db.execute(greenRow(found, 'b'.repeat(64)))).rejects.toThrow();
  await db.execute(greenRow(found, 'c'.repeat(64)));
  expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from test_file_results`)).rows[0]!.n).toBe(2);
  expect((await db.execute(sql`select distinct main_line from test_file_results`)).rows).toEqual([{ main_line: false }]);
});

/* The run's own database is a fresh one with every migration applied, made once for the run, and every test's starts as
   a copy of it. */
it('creates what reuse needs on a fresh database, and a removed department takes its results along', async () => {
  const { client } = await openTestDb();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  const found = await legacyRun(db);
  await db.execute(greenRow(found, 'b'.repeat(64)));
  await db.execute(sql`insert into test_suite_memory(company_id,repository_owner_id,repo_url_hash,suite_id,files) values(${found.company},${found.department},${'f'.repeat(64)},'unit','[]')`);
  await db.execute(sql`update test_runs set department_id = null`);
  await db.execute(sql`delete from departments where id = ${found.department}`);
  expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from test_file_results`)).rows[0]!.n).toBe(0);
  expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from test_suite_memory`)).rows[0]!.n).toBe(0);
});
