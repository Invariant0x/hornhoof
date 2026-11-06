import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agentRole, grantsFor, readerGrantsFor, readerRole } from '../src/db/agent-sql.js';
import { MIGRATIONS } from '../src/db/client.js';
import { createTestDb } from './helpers.js';

const PRIVATE = ['workspace_repositories', 'task_workspaces', 'author_workspace_slots', 'task_area_locks', 'task_workspace_operations', 'task_workspace_submissions', 'task_workspace_sessions', 'task_workspace_merge_receipts'].sort();

async function legacyRows(client: PGlite): Promise<void> {
  for (const [singleton, name] of [[true, 'First legacy company'], [false, 'Second legacy company']] as const) {
    const [company, person, subscription, agent, task, job] = Array.from({ length: 6 }, () => randomUUID());
    await client.query('INSERT INTO companies(id,name,singleton) VALUES($1,$2,$3)', [company, name, singleton]);
    await client.query("INSERT INTO people(id,company_id,name,email,status,scope_kind) VALUES($1,$2,'Legacy owner',$3,'active','company')", [person, company, `${person}@example.test`]);
    await client.query("INSERT INTO subscriptions(id,company_id,provider,kind,label,owner_person_id,status) VALUES($1,$2,'claude','personal','Legacy plan',$3,'ready')", [subscription, company, person]);
    await client.query("INSERT INTO agents(id,company_id,kind,name,model) VALUES($1,$2,'worker','Legacy worker','')", [agent, company]);
    await client.query("INSERT INTO tasks(id,company_id,number,title) VALUES($1,$2,1,'Legacy task')", [task, company]);
    await client.query("INSERT INTO jobs(id,company_id,subscription_id,agent_id,task_id,prompt,timeout_ms) VALUES($1,$2,$3,$4,$5,'Legacy pending job',1000)", [job, company, subscription, agent, task]);
  }
}

async function roles() {
  const { $client: client } = await createTestDb();
  const names = [agentRole('postgres'), readerRole('postgres')];
  await client.exec(`${grantsFor(names[0]!)};${readerGrantsFor(names[1]!)}`);
  const run = (name: string, statement: string) => client.transaction(async tx => {
    await tx.exec(`SET LOCAL ROLE "${name}"`);
    return tx.exec(statement);
  });
  return { client, names, run };
}

describe('private persisted task workspace schema', () => {
  it('creates all frozen private metadata families without populating workspaces', async () => {
    const { $client: client } = await createTestDb();
    const found = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name", [PRIVATE]);
    expect(found.rows.map(row => row.table_name)).toEqual(PRIVATE);
    for (const table of PRIVATE) expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
  });

  it('adds canonical epochs and nullable legacy job workspace identity', async () => {
    const { $client: client } = await createTestDb();
    const found = await client.query("SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('tasks','jobs') AND column_name IN ('assignment_epoch','workspace_id','workspace_spec_version') ORDER BY table_name,column_name");
    expect(found.rows).toEqual([
      { table_name: 'jobs', column_name: 'assignment_epoch', is_nullable: 'NO' },
      { table_name: 'jobs', column_name: 'workspace_id', is_nullable: 'YES' },
      { table_name: 'jobs', column_name: 'workspace_spec_version', is_nullable: 'YES' },
      { table_name: 'tasks', column_name: 'assignment_epoch', is_nullable: 'NO' },
    ]);
  });

  it.each(PRIVATE)('keeps %s behind the private API for both generic SQL roles', async table => {
    const c = await roles();
    const columns = await c.client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position LIMIT 1", [table]);
    expect(columns.rows[0], 'The private table must exist before testing its grants.').toBeDefined();
    const column = `"${columns.rows[0]!.column_name.replaceAll('"', '""')}"`;
    for (const role of c.names) {
      for (const statement of [`SELECT * FROM ${table}`, `INSERT INTO ${table} DEFAULT VALUES`, `UPDATE ${table} SET ${column}=${column} WHERE false`, `DELETE FROM ${table} WHERE false`]) {
        await expect(c.run(role, statement), `${role}: ${statement}`).rejects.toThrow(/permission denied/);
      }
    }
  });

  it('prevents generic SQL from reading or forging protected task and job bindings', async () => {
    const c = await roles();
    for (const [table, column] of [['tasks', 'assignment_epoch'], ['jobs', 'assignment_epoch'], ['jobs', 'workspace_id'], ['jobs', 'workspace_spec_version']]) {
      for (const role of c.names) {
        await expect(c.run(role, `SELECT ${column} FROM ${table}`)).rejects.toThrow(/permission denied/);
        await expect(c.run(role, `UPDATE ${table} SET ${column}=${column} WHERE false`)).rejects.toThrow(/permission denied/);
      }
    }
  });

  it('builds real two-company legacy task and pending-job rows', async () => {
    const { $client: client } = await createTestDb();
    await legacyRows(client);
    expect((await client.query('SELECT count(DISTINCT company_id)::int AS companies,count(*)::int AS jobs FROM jobs')).rows).toEqual([{ companies: 2, jobs: 2 }]);
  });

  it('upgrades only its journal prefix with legacy rows intact and no job replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hh-workspace-upgrade-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    await cp(MIGRATIONS, directory, { recursive: true });
    const journalPath = join(directory, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: { tag: string }[] };
    const at = journal.entries.findIndex(entry => entry.tag.endsWith('_task_workspaces'));
    expect(at, 'A generated task_workspaces migration is required, without reserving its number.').toBeGreaterThan(0);
    const client = new PGlite(); onTestFinished(() => client.close());
    const db = drizzle(client);
    await writeFile(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }));
    await migrate(db, { migrationsFolder: directory });
    await legacyRows(client);
    const beforeTasks = (await client.query('SELECT to_jsonb(t) AS row FROM tasks t ORDER BY id')).rows;
    const beforeJobs = (await client.query('SELECT to_jsonb(j) AS row FROM jobs j ORDER BY id')).rows;
    await writeFile(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, at + 1) }));
    await migrate(db, { migrationsFolder: directory });
    expect((await client.query("SELECT to_jsonb(t)-'assignment_epoch' AS row FROM tasks t ORDER BY id")).rows).toEqual(beforeTasks);
    expect((await client.query("SELECT to_jsonb(j)-ARRAY['assignment_epoch','workspace_id','workspace_spec_version'] AS row FROM jobs j ORDER BY id")).rows).toEqual(beforeJobs);
    expect((await client.query('SELECT assignment_epoch,workspace_id,workspace_spec_version,status FROM jobs ORDER BY id')).rows).toEqual(Array(2).fill({ assignment_epoch: 0, workspace_id: null, workspace_spec_version: null, status: 'queued' }));
    for (const table of PRIVATE) expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
    const migrations = (await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    await migrate(db, { migrationsFolder: directory });
    expect((await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(migrations);
  });
});
