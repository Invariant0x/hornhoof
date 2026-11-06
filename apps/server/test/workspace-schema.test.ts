import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agentRole, grantsFor, readerGrantsFor, readerRole } from '../src/db/agent-sql.js';
import { createTestDb } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

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

async function privateRows() {
  const { $client: client } = await createTestDb(); await legacyRows(client);
  const { rows: [job] } = await client.query<{ id: string; company_id: string; agent_id: string; task_id: string }>('SELECT id,company_id,agent_id,task_id FROM jobs ORDER BY id LIMIT 1');
  const repository = randomUUID(), workspace = randomUUID();
  await client.query("INSERT INTO workspace_repositories(id,company_id,canonical_url) VALUES($1,$2,'https://git.example/team/project')", [repository, job!.company_id]);
  const insert = (id: string, current: boolean, repo = repository) => client.query(`INSERT INTO task_workspaces(id,company_id,repository_id,task_id,agent_id,builtin,assignment_epoch,binding_version,task_branch,base_sha,base_ref,areas,required_integrations,phase,is_current)
    VALUES($1,$2,$3,$4,$5,true,0,1,$6,$7,'turn-8','["apps"]','[{"kind":"turn","ref":"turn-8"}]','reserved',$8)`, [id, job!.company_id, repo, job!.task_id, job!.agent_id, `task-${job!.task_id}`, 'a'.repeat(40), current]);
  await insert(workspace, true);
  return { client, job: job!, repository, workspace, insert };
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
        await expect(c.run(role, `INSERT INTO ${table}(${column}) VALUES(${column.endsWith('_id') ? "'00000000-0000-4000-8000-000000000001'" : '1'})`)).rejects.toThrow(/permission denied/);
      }
    }
  });

  it('keeps complete pinned policy and node identity on every physical workspace', async () => {
    const c = await privateRows();
    for (const assignment of ["areas='[]'", "required_integrations='[]'", "base_sha='main'", "binding_version=0", "assignment_epoch=-1", 'builtin=false', "phase='ready_by_caller'"]) {
      await expect(c.client.exec(`UPDATE task_workspaces SET ${assignment}`), assignment).rejects.toThrow(/check constraint/);
    }
  });

  it('permits retained history but only one current physical binding for an assignment', async () => {
    const c = await privateRows(), next = randomUUID();
    await expect(c.insert(next, true)).rejects.toThrow(/unique constraint/);
    await c.insert(next, false);
    expect((await c.client.query('SELECT count(*)::int AS n FROM task_workspaces')).rows).toEqual([{ n: 2 }]);
  });

  it('cannot bind a company workspace to another company repository', async () => {
    const c = await privateRows(), foreign = randomUUID();
    const { rows: [company] } = await c.client.query<{ id: string }>('SELECT id FROM companies WHERE id<>$1', [c.job.company_id]);
    await c.client.query("INSERT INTO workspace_repositories(id,company_id,canonical_url) VALUES($1,$2,'https://git.example/foreign/project')", [foreign, company!.id]);
    await expect(c.insert(randomUUID(), false, foreign)).rejects.toThrow(/foreign key constraint/);
  });

  it('holds at most two distinct tasks and cannot execute a task outside the held set', async () => {
    const c = await privateRows(), tasks = [c.job.task_id, randomUUID(), randomUUID()];
    const insert = (held: string[], execution: string | null = null) => c.client.query('INSERT INTO author_workspace_slots(company_id,agent_id,held_task_ids,execution_task_id) VALUES($1,$2,$3,$4)', [c.job.company_id, c.job.agent_id, held, execution]);
    await expect(insert(tasks)).rejects.toThrow(/check constraint/);
    await expect(insert([tasks[0]!, tasks[0]!])).rejects.toThrow(/check constraint/);
    await expect(insert([], c.job.task_id)).rejects.toThrow(/check constraint/);
    await insert([c.job.task_id], c.job.task_id);
  });

  it('keeps a legacy job unbound and requires a complete positive workspace/spec pair for managed jobs', async () => {
    const c = await privateRows();
    await expect(c.client.query('UPDATE jobs SET workspace_id=$1 WHERE id=$2', [c.workspace, c.job.id])).rejects.toThrow(/check constraint/);
    await expect(c.client.query('UPDATE jobs SET workspace_spec_version=1 WHERE id=$1', [c.job.id])).rejects.toThrow(/check constraint/);
    await c.client.query('UPDATE jobs SET workspace_id=$1,workspace_spec_version=1 WHERE id=$2', [c.workspace, c.job.id]);
    await expect(c.client.query('UPDATE jobs SET workspace_spec_version=0 WHERE id=$1', [c.job.id])).rejects.toThrow(/check constraint/);
  });

  it('builds real two-company legacy task and pending-job rows', async () => {
    const { $client: client } = await createTestDb();
    await legacyRows(client);
    expect((await client.query('SELECT count(DISTINCT company_id)::int AS companies,count(*)::int AS jobs FROM jobs')).rows).toEqual([{ companies: 2, jobs: 2 }]);
  });

  it('upgrades only its journal prefix with legacy rows intact and no job replay', async () => {
    const before = await migrationsBefore('task_workspaces');
    const through = await migrationsThrough('task_workspaces');
    const client = new PGlite(); onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: before });
    await legacyRows(client);
    const beforeTasks = (await client.query('SELECT to_jsonb(t) AS row FROM tasks t ORDER BY id')).rows;
    const beforeJobs = (await client.query('SELECT to_jsonb(j) AS row FROM jobs j ORDER BY id')).rows;
    await migrate(db, { migrationsFolder: through });
    expect((await client.query("SELECT to_jsonb(t)-'assignment_epoch' AS row FROM tasks t ORDER BY id")).rows).toEqual(beforeTasks);
    expect((await client.query("SELECT to_jsonb(j)-ARRAY['assignment_epoch','workspace_id','workspace_spec_version'] AS row FROM jobs j ORDER BY id")).rows).toEqual(beforeJobs);
    expect((await client.query('SELECT assignment_epoch,workspace_id,workspace_spec_version,status FROM jobs ORDER BY id')).rows).toEqual(Array(2).fill({ assignment_epoch: 0, workspace_id: null, workspace_spec_version: null, status: 'queued' }));
    for (const table of PRIVATE) expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
    const migrations = (await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    await migrate(db, { migrationsFolder: through });
    expect((await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(migrations);
  });
});
