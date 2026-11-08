import { getTableColumns, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tasks } from '../src/db/schema.js';
import { createTestDb } from './helpers.js';

describe('one route without the replaced task gate state', () => {
  it.each(['gates', 'panel', 'stage', 'merging', 'bounces'])('does not retain the obsolete %s field', field => {
    expect(Object.keys(getTableColumns(tasks))).not.toContain(field);
  });
  it('creates the route table and drops replaced columns through the normal fresh schema', async () => {
    const db = await createTestDb();
    const result = await db.execute(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('tasks', 'task_routes')`);
    const rows = result.rows as { table_name: string; column_name: string }[];
    const taskColumns = rows.filter(row => row.table_name === 'tasks').map(row => row.column_name);
    for (const field of ['gates', 'panel', 'stage', 'merging', 'bounces']) expect(taskColumns).not.toContain(field);
    expect(rows.filter(row => row.table_name === 'task_routes').map(row => row.column_name).sort()).toEqual(['company_id', 'paths', 'revision', 'state', 'task_id']);
  });
});
