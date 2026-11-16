import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { migrationsBefore } from './migrations-before.js';
import { freshPglite } from './helpers-db.js';

const SHA = 'a'.repeat(40);

const columnOf = async (db: ReturnType<typeof drizzle>) =>
  (await db.execute(sql`select data_type, is_nullable, column_default from information_schema.columns where table_name = 'test_runs' and column_name = 'commit_sha'`)).rows;

describe('the pinned commit of a test run', () => {
  it('is an optional column of test runs on a fresh database', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect(await columnOf(db)).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
  });

  it('comes to the previous schema with no pin on the runs already there, and every other value intact', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsBefore('test_run_commit') });
    expect(await columnOf(db)).toEqual([]);
    await db.execute(sql`insert into companies (name) values ('Acme')`);
    await db.execute(sql`insert into people (company_id, name, email, status, scope_kind) select id, 'Ivan', 'ivan@acme.com', 'active', 'company' from companies`);
    await db.execute(sql`insert into subscriptions (company_id, provider, kind, label, status, owner_person_id) select company_id, 'claude', 'personal', 'Claude', 'ready', id from people`);
    await db.execute(sql`insert into agents (company_id, kind, name, model) select id, 'worker', 'Bruno', '' from companies`);
    await db.execute(sql`insert into jobs (company_id, subscription_id, agent_id, kind, prompt, timeout_ms) select s.company_id, s.id, a.id, 'conversation', 'hi', 900000 from subscriptions s join agents a on a.company_id = s.company_id`);
    await db.execute(sql`insert into tasks (company_id, number, title) select id, 1, 'Checkout' from companies`);
    await db.execute(sql`insert into test_runs (company_id, number, task_id, agent_id, job_id, branch, command, timeout_ms, status) select j.company_id, 1, t.id, j.agent_id, j.id, 'task-1', 'npm test', 60000, 'passed' from jobs j join tasks t on t.company_id = j.company_id`);
    await db.execute(sql`insert into test_parts (company_id, run_id, part, status, commit, exit_code) select company_id, id, 1, 'passed', ${SHA}, 0 from test_runs`);
    const before = async () => ({
      runs: (await db.execute(sql`select number, branch, command, status, timeout_ms from test_runs`)).rows,
      parts: (await db.execute(sql`select part, status, commit, exit_code from test_parts`)).rows,
    });
    const held = await before();

    await migrate(db, { migrationsFolder: MIGRATIONS });
    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(await before()).toEqual(held);
    expect(held.parts).toEqual([{ part: 1, status: 'passed', commit: SHA, exit_code: 0 }]);
    expect((await db.execute(sql`select commit_sha from test_runs`)).rows).toEqual([{ commit_sha: null }]);
    await db.execute(sql`update test_runs set commit_sha = ${SHA}`);
    expect((await db.execute(sql`select commit_sha from test_runs`)).rows).toEqual([{ commit_sha: SHA }]);
  });
});
