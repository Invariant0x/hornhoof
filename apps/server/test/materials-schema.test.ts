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

it('stores private history only beside its real request and rejects dangling identities', async () => {
  const db = await createTestDb();
  await expect(db.$client.exec(`INSERT INTO request_internal(request_id,company_id) VALUES
    ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002')`)).rejects.toThrow(/foreign key/);
});


const LEGACY_ROWS = `
  INSERT INTO companies (id,name) VALUES ('00000000-0000-4000-8000-000000000001','Retained company');
  INSERT INTO agents (id,company_id,kind,name,model) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','worker','Retained agent','');
  INSERT INTO tasks (id,company_id,number,title) VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',1,'Retained task');
  INSERT INTO requests (id,company_id,task_id,agent_id,kind,text) VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','question','Retained question');
  INSERT INTO proposals (id,company_id,agent_id,brief,items) VALUES ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Retained proposal','[]');
`;

it('bounds private JSON and keeps public revision and digest an atomic pair', async () => {
  const db = await createTestDb();
  await db.$client.exec(LEGACY_ROWS);
  for (const table of ['requests', 'proposals']) {
    for (const fields of ["material_revision = 1", "material_digest = '" + 'a'.repeat(64) + "'", "material_revision = -1, material_digest = 'bad'"]) {
      await expect(db.$client.exec(`UPDATE ${table} SET ${fields}`)).rejects.toThrow(/check constraint/);
    }
    await db.$client.exec(`UPDATE ${table} SET material_revision = 1, material_digest = '${'a'.repeat(64)}'`);
  }
  await db.$client.exec(`INSERT INTO request_internal(request_id,company_id,material_snapshot) VALUES
    ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','{}')`);
  for (const table of ['request_internal', 'proposals']) {
    await expect(db.$client.exec(`UPDATE ${table} SET material_snapshot = '[]'`)).rejects.toThrow(/check constraint/);
    await expect(db.$client.exec(`UPDATE ${table} SET material_snapshot = jsonb_build_object('oversized',repeat('x',1048576))`)).rejects.toThrow(/check constraint/);
    await db.$client.exec(`UPDATE ${table} SET material_snapshot = '{"schemaVersion":1,"versions":[]}'`);
  }
});
