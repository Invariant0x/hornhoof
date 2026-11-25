import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { freshPglite } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

describe('migration 0168, how a department starts its turns', () => {
  it('makes every top-level development department start its turns on confirmation and any other by itself, and no open turn waits or is cut', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsBefore('turn_start') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const department = async (template: string, parent: string | null) =>
      (await db.execute<{ id: string }>(sql`insert into departments (company_id, template_key, role_code, parent_id) values (${company}, ${template}, 'X', ${parent}) returning id`)).rows[0]!.id;
    const dev = await department('development', null);
    await department('marketing', null);
    await department('development', dev);
    await db.execute(sql`insert into turns (company_id, department_id, number, goal, status) values (${company}, ${dev}, 1, 'Open', 'open')`);

    await migrate(db, { migrationsFolder: await migrationsThrough('turn_start') });

    const modes = (await db.execute<{ template_key: string; parent_id: string | null; turn_start: string }>(sql`select template_key, parent_id, turn_start from departments order by template_key, parent_id nulls first`)).rows;
    expect(modes).toEqual([
      { template_key: 'development', parent_id: null, turn_start: 'manual' },
      { template_key: 'development', parent_id: dev, turn_start: 'automatic' },
      { template_key: 'marketing', parent_id: null, turn_start: 'automatic' },
    ]);
    const turn = (await db.execute<{ confirmed_at: Date | null; cut_at: Date | null; cut_branch: string | null }>(sql`select confirmed_at, cut_at, cut_branch from turns`)).rows[0]!;
    expect(turn.confirmed_at).not.toBeNull();
    expect(turn.cut_at).toBeNull();
    expect(turn.cut_branch).toBeNull();
    await expect(db.execute(sql`update departments set turn_start = 'sometimes' where id = ${dev}`)).rejects.toThrow();
  });
});
