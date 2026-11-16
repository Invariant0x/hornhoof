import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { freshPglite } from './helpers-db.js';
import { migrationsBefore } from './migrations-before.js';

const tables = async (db: ReturnType<typeof drizzle>) =>
  (await db.execute(sql`select table_name from information_schema.tables where table_name like 'harness_%' order by table_name`)).rows.map(row => row.table_name);

describe('the tables of test harnesses', () => {
  it('stand on a fresh database', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect(await tables(db)).toEqual(['harness_builds', 'harness_products']);
  });

  it('come to the previous schema with its data intact, and go with the department they are of', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsBefore('harness') });
    expect(await tables(db)).toEqual([]);
    await db.execute(sql`insert into companies (name) values ('Acme')`);
    await db.execute(sql`insert into departments (company_id, role_code, repo_url) select id, 'DEV', 'https://github.com/acme/shop.git' from companies`);
    const before = (await db.execute(sql`select name, role_code, repo_url from departments`)).rows;
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect((await db.execute(sql`select name, role_code, repo_url from departments`)).rows).toEqual(before);
    await db.execute(sql`insert into harness_products (department_id, company_id) select id, company_id from departments`);
    await db.execute(sql`insert into harness_builds (company_id, department_id, key, version, unit, platform, commit_sha) select company_id, id, 'k', 'v', 'dependencies', 'linux-arm64', 'c' from departments`);
    expect((await db.execute(sql`select status, failures, copies from harness_builds`)).rows).toEqual([{ status: 'building', failures: 0, copies: [] }]);
    /* The migrations gave the department its open turn; removing a department closes its turns first. */
    await db.execute(sql`delete from turns`);
    await db.execute(sql`delete from departments`);
    expect((await db.execute(sql`select count(*)::int as n from harness_builds`)).rows).toEqual([{ n: 0 }]);
    expect((await db.execute(sql`select count(*)::int as n from harness_products`)).rows).toEqual([{ n: 0 }]);
  });
});
