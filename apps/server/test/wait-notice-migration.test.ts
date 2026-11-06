import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

describe('durable wait notices migration', () => {
  it('creates an empty outbox with durable deduplication and a pending index on a fresh database', async () => {
    const client = new PGlite();
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
    const client = new PGlite();
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
});
