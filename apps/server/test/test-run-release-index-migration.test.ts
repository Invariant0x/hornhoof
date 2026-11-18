import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { readFile } from 'node:fs/promises';
import { expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { createTestDb, freshPglite, ownDatabases, timed } from './helpers-db.js';
import { migrationsThrough } from './migrations-before.js';

ownDatabases();
const before = await migrationsThrough('agent_change_actor');
const indexSql = await readFile(`${MIGRATIONS}/0150_test_runs_release.sql`, 'utf8');
/* Prepare the old schema once, outside the scenarios whose only change is applying this migration. */
const previous = await freshPglite();
let previousDump: Blob;
try {
  await migrate(drizzle(previous), { migrationsFolder: before });
  previousDump = await previous.dumpDataDir('none');
} finally {
  await previous.close();
}

it('indexes a release by company and repository without unpacking every run cache', async () => {
  const db = await createTestDb();
  const { rows } = await db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'test_runs_release'`);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.indexdef).toContain("(company_id, department_id, ((file_cache ->> 'release'::text)))");
});

it.each([false, true])('upgrades existing runs and adopts an index already installed by Operations=%s', async installed => {
  const client = await timed('setupMs', async () => {
    const copy = new PGlite({ loadDataDir: previousDump });
    await copy.waitReady;
    return copy;
  });
  onTestFinished(() => client.close());
  const db = drizzle(client);
  const id = async (query: ReturnType<typeof sql>) => (await db.execute<{ id: string }>(query)).rows[0]!.id;
  const company = await id(sql`insert into companies(name,singleton) values('Acme',true) returning id`);
  const person = await id(sql`insert into people(company_id,name,email,status,scope_kind) values(${company},'Ann','ann@example.test','active','company') returning id`);
  const agent = await id(sql`insert into agents(company_id,kind,name,model) values(${company},'orchestrator','Orchestrator','') returning id`);
  const task = await id(sql`insert into tasks(company_id,number,title) values(${company},1,'Task') returning id`);
  const subscription = await id(sql`insert into subscriptions(company_id,provider,kind,label,owner_person_id,status) values(${company},'codex','personal','Plan',${person},'ready') returning id`);
  const job = await id(sql`insert into jobs(company_id,subscription_id,agent_id,prompt,timeout_ms) values(${company},${subscription},${agent},'Run tests',60000) returning id`);
  const cache = JSON.stringify({ release: 'turn-32', padding: 'c'.repeat(103 * 1024) });
  const snapshot = JSON.stringify({ padding: 's'.repeat(64 * 1024) });
  await db.execute(sql`insert into test_runs(company_id,number,task_id,agent_id,job_id,command,timeout_ms,file_cache,environment_snapshot) values(${company},1,${task},${agent},${job},'',60000,${cache}::jsonb,${snapshot}::jsonb)`);
  const was = (await db.execute(sql`select id,file_cache,environment_snapshot from test_runs`)).rows;
  if (installed) await db.execute(sql.raw(indexSql));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  expect((await db.execute(sql`select id,file_cache,environment_snapshot from test_runs`)).rows).toEqual(was);
  expect((await db.execute(sql`select indexname from pg_indexes where schemaname = 'public' and indexname = 'test_runs_release'`)).rows).toEqual([{ indexname: 'test_runs_release' }]);
});
