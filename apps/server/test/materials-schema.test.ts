import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers.js';

describe('private materials storage', () => {
  it('migrates a fresh database to nullable legacy-safe public metadata and private snapshots', async () => {
    const db = await createTestDb();
    const columns = await db.$client.query<{ table_name: string; column_name: string; is_nullable: string }>(`
      SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND column_name IN ('material_revision','material_digest','material_snapshot')
      ORDER BY table_name,column_name`);
    expect(columns.rows).toEqual([
      { table_name: 'proposals', column_name: 'material_digest', is_nullable: 'YES' },
      { table_name: 'proposals', column_name: 'material_revision', is_nullable: 'YES' },
      { table_name: 'proposals', column_name: 'material_snapshot', is_nullable: 'YES' },
      { table_name: 'request_internal', column_name: 'material_snapshot', is_nullable: 'YES' },
      { table_name: 'requests', column_name: 'material_digest', is_nullable: 'YES' },
      { table_name: 'requests', column_name: 'material_revision', is_nullable: 'YES' },
    ]);
  });
});
