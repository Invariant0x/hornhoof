import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
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


it('upgrades the previous schema with original question/proposal evidence intact and is repeatable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hh-materials-upgrade-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await cp(MIGRATIONS, directory, { recursive: true });
  const file = join(directory, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(file, 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter(entry => entry.tag < '0067_request_materials');
  await writeFile(file, JSON.stringify(journal));
  const client = new PGlite();
  onTestFinished(() => client.close());
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: directory });
  await client.exec(LEGACY_ROWS);
  const beforeRequest = await client.query('SELECT to_jsonb(r) AS row FROM requests r');
  const beforeProposal = await client.query('SELECT to_jsonb(p) AS row FROM proposals p');
  await migrate(db, { migrationsFolder: MIGRATIONS });
  expect((await client.query("SELECT to_jsonb(r) - ARRAY['material_revision','material_digest'] AS row FROM requests r")).rows).toEqual(beforeRequest.rows);
  expect((await client.query("SELECT to_jsonb(p) - ARRAY['material_revision','material_digest','material_snapshot'] AS row FROM proposals p")).rows).toEqual(beforeProposal.rows);
  expect((await client.query('SELECT material_revision,material_digest FROM requests')).rows).toEqual([{ material_revision: null, material_digest: null }]);
  const history = await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id');
  await migrate(db, { migrationsFolder: MIGRATIONS });
  expect((await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(history.rows);
});
