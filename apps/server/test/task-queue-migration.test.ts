import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { freshPglite } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

describe('migration 0165, the slots of a turn', () => {
  /* A department already at work keeps giving its work out at once: only a new development department starts with slots. */
  it('gives no existing department slots, the development department neither, and no old task waits in a queue', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsBefore('task_queue') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const department = async (template: string, parent: string | null) =>
      (await db.execute<{ id: string }>(sql`insert into departments (company_id, template_key, role_code, parent_id) values (${company}, ${template}, 'X', ${parent}) returning id`)).rows[0]!.id;
    const dev = await department('development', null);
    await department('marketing', null);
    await department('development', dev);
    await db.execute(sql`insert into tasks (company_id, number, title, department_id) values (${company}, 1, 'Old', ${dev})`);

    await migrate(db, { migrationsFolder: await migrationsThrough('task_queue') });

    const caps = (await db.execute<{ template_key: string; parent_id: string | null; slot_cap: number | null }>(sql`select template_key, parent_id, slot_cap from departments order by template_key, parent_id nulls first`)).rows;
    expect(caps).toEqual([
      { template_key: 'development', parent_id: null, slot_cap: null },
      { template_key: 'development', parent_id: dev, slot_cap: null },
      { template_key: 'marketing', parent_id: null, slot_cap: null },
    ]);
    expect((await db.execute(sql`select queued_at from tasks`)).rows).toEqual([{ queued_at: null }]);
    await expect(db.execute(sql`update departments set slot_cap = 0 where id = ${dev}`)).rejects.toThrow();
  });
});
