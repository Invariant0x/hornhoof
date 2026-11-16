import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { freshPglite } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

const columnOf = async (db: ReturnType<typeof drizzle>) =>
  (await db.execute(sql`select data_type, is_nullable, column_default from information_schema.columns where table_name = 'departments' and column_name = 'repo_full_test_command'`)).rows;

describe("the repository's full test command", () => {
  it('is an optional column of departments on a fresh database', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect(await columnOf(db)).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
  });

  /* No repository is taken to have declared anything, so no run marks a commit until a person says which command is full. */
  it('comes to the previous schema with none declared on the repositories already there, and every other value intact', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsBefore('repo_full_test_command') });
    expect(await columnOf(db)).toEqual([]);
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    await db.execute(sql`insert into departments (company_id, template_key, role_code, repo_url, repo_branch, repo_test_memory_gb) values (${company}, 'development', 'DEV', 'https://github.com/acme/shop.git', 'main', 8)`);
    const rows = async () => (await db.execute(sql`select to_jsonb(d) - 'repo_full_test_command' as data from departments d`)).rows;
    const before = await rows();

    await migrate(db, { migrationsFolder: await migrationsThrough('repo_full_test_command') });

    expect(await rows()).toEqual(before);
    expect((await db.execute(sql`select repo_full_test_command from departments`)).rows).toEqual([{ repo_full_test_command: null }]);
  });
});
