import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agentRole, grantsFor, readerGrantsFor, readerRole } from '../src/db/agent-sql.js';
import { createTestDb } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

const PRIVATE = ['staging_plans', 'staging_batches', 'staging_trials', 'staging_operations'].sort();
const SHA = 'a'.repeat(40);

async function fixture() {
  const db = await createTestDb(), client = db.$client;
  const [company, other, repository, turn, plan, batch, trial] = Array.from({ length: 7 }, () => randomUUID());
  await client.query("INSERT INTO companies(id,name,singleton) VALUES($1,'Staging owner',true),($2,'Other owner',false)", [company, other]);
  await client.query("INSERT INTO workspace_repositories(id,company_id,canonical_url) VALUES($1,$2,'https://git.example/team/project')", [repository, company]);
  await client.query("INSERT INTO turns(id,company_id,number,goal) VALUES($1,$2,1,'A checked turn')", [turn, company]);
  const insertPlan = (id = plan, owner = company, generation = 1, current = true) => client.query(`INSERT INTO staging_plans
    (id,company_id,repository_id,turn_id,generation,base_ref,base_sha,required_integrations,is_current)
    VALUES($1,$2,$3,$4,$5,'turn-1',$6,'[{"kind":"turn","ref":"turn-1"}]',$7)`, [id, owner, repository, turn, generation, SHA, current]);
  const insertBatch = (id = batch, owner = company, generation = 1) => client.query(`INSERT INTO staging_batches
    (id,company_id,plan_id,plan_generation,base_sha,submission_ids,source_snapshot,idempotency_key)
    VALUES($1,$2,$3,$4,$5,$6,'[{"source":"sealed"}]',$7)`, [id, owner, plan, generation, SHA, [randomUUID()], `batch:${id}`]);
  const insertTrial = (id = trial, owner = company) => client.query(`INSERT INTO staging_trials
    (id,company_id,batch_id,ordinal,submission_ids) VALUES($1,$2,$3,1,$4)`, [id, owner, batch, [randomUUID()]]);
  return { db, client, company: company!, other: other!, repository: repository!, turn: turn!, plan: plan!, batch: batch!, trial: trial!, insertPlan, insertBatch, insertTrial };
}

describe('private persisted staging state', () => {
  it('creates only empty private metadata, without enabling a publisher or inventing a plan', async () => {
    const db = await createTestDb();
    const found = await db.$client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name", [PRIVATE]);
    expect(found.rows.map(row => row.table_name)).toEqual(PRIVATE);
    for (const table of PRIVATE) expect((await db.$client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
  });

  it.each(PRIVATE)('keeps %s unreadable and unforgeable by both generic SQL roles', async table => {
    const db = await createTestDb(), client = db.$client;
    const found = await client.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1", [table]);
    expect(found.rows).toHaveLength(1);
    const roles = [agentRole('postgres'), readerRole('postgres')];
    await client.exec(`${grantsFor(roles[0]!)};${readerGrantsFor(roles[1]!)}`);
    for (const role of roles) for (const statement of [`SELECT * FROM ${table}`, `INSERT INTO ${table} DEFAULT VALUES`, `UPDATE ${table} SET id=id WHERE false`, `DELETE FROM ${table} WHERE false`]) {
      await expect(client.transaction(async tx => { await tx.exec(`SET LOCAL ROLE "${role}"`); return tx.exec(statement); })).rejects.toThrow(/permission denied/);
    }
  });

  it('stores an exact root generation with a disabled and explicitly tunable bootstrap policy', async () => {
    const f = await fixture(); await f.insertPlan();
    expect((await f.client.query('SELECT generation,base_ref,base_sha,enabled,max_batch_size,max_wait_ms,health_run_id FROM staging_plans')).rows).toEqual([
      { generation: 1, base_ref: 'turn-1', base_sha: SHA, enabled: false, max_batch_size: 4, max_wait_ms: 0, health_run_id: null },
    ]);
    await f.client.exec('UPDATE staging_plans SET max_batch_size=2,max_wait_ms=500,enabled=true');
    expect((await f.client.query('SELECT enabled,max_batch_size,max_wait_ms FROM staging_plans')).rows).toEqual([{ enabled: true, max_batch_size: 2, max_wait_ms: 500 }]);
  });

  it('keeps retained generations but only one current plan for a company repository and turn', async () => {
    const f = await fixture(); await f.insertPlan();
    await expect(f.insertPlan(randomUUID(), f.company, 2)).rejects.toThrow(/unique constraint/);
    await f.client.exec('UPDATE staging_plans SET is_current=false');
    await f.insertPlan(randomUUID(), f.company, 2);
    expect((await f.client.query('SELECT generation,is_current FROM staging_plans ORDER BY generation')).rows).toEqual([{ generation: 1, is_current: false }, { generation: 2, is_current: true }]);
  });

  it('rejects cross-company repository and turn roots', async () => {
    const f = await fixture();
    await expect(f.insertPlan(f.plan, f.other)).rejects.toThrow(/foreign key constraint/);
    await f.insertPlan();
    const otherTurn = randomUUID();
    await f.client.query("INSERT INTO turns(id,company_id,number,goal) VALUES($1,$2,1,'Other turn')", [otherTurn, f.other]);
    await expect(f.client.query('UPDATE staging_plans SET turn_id=$1', [otherTurn])).rejects.toThrow(/foreign key constraint/);
  });

  it('rejects mutable names used as pins, empty targets and unsafe tuning', async () => {
    const f = await fixture(); await f.insertPlan();
    for (const assignment of ["base_sha='main'", "required_integrations='[]'", 'generation=0', 'max_batch_size=0', 'max_wait_ms=-1', 'max_wait_ms=9007199254740992']) {
      await expect(f.client.exec(`UPDATE staging_plans SET ${assignment}`), assignment).rejects.toThrow(/check constraint/);
    }
  });

  it('binds a durable batch to the exact private plan generation and company', async () => {
    const f = await fixture(); await f.insertPlan();
    await expect(f.insertBatch(f.batch, f.company, 2)).rejects.toThrow(/foreign key constraint/);
    await expect(f.insertBatch(f.batch, f.other)).rejects.toThrow(/foreign key constraint/);
    await f.insertBatch();
    expect((await f.client.query('SELECT phase,version FROM staging_batches')).rows).toEqual([{ phase: 'preparing', version: 0 }]);
    await expect(f.client.query('INSERT INTO staging_batches SELECT * FROM staging_batches')).rejects.toThrow(/unique constraint/);
    for (const assignment of ["submission_ids='{}'", "source_snapshot='[]'", "phase='caller_green'", 'version=-1', "base_sha='turn-1'"]) {
      await expect(f.client.exec(`UPDATE staging_batches SET ${assignment}`), assignment).rejects.toThrow(/check constraint/);
    }
  });

  it('retains trial identity and refuses cross-batch or unpinned completed work', async () => {
    const f = await fixture(); await f.insertPlan(); await f.insertBatch();
    await expect(f.insertTrial(f.trial, f.other)).rejects.toThrow(/foreign key constraint/);
    await f.insertTrial();
    for (const assignment of ['ordinal=0', "submission_ids='{}'", "candidate_sha='moving-ref'", "phase='passed'", "phase='failed'", 'version=-1']) {
      await expect(f.client.exec(`UPDATE staging_trials SET ${assignment}`), assignment).rejects.toThrow(/check constraint/);
    }
    await expect(f.insertTrial(randomUUID())).rejects.toThrow(/unique constraint/);
  });

  it('stores an idempotent existing-transport intent without treating it as a published receipt', async () => {
    const f = await fixture(); await f.insertPlan(); await f.insertBatch(); await f.insertTrial();
    const insert = (id: string, batch = f.batch) => f.client.query(`INSERT INTO staging_operations
      (id,company_id,batch_id,trial_id,kind,idempotency_key,payload) VALUES($1,$2,$3,$4,'prepare','prepare:trial','{"request":"pinned"}')`, [id, f.company, batch, f.trial]);
    await insert(randomUUID());
    await expect(insert(randomUUID())).rejects.toThrow(/unique constraint/);
    const otherBatch = randomUUID(); await f.insertBatch(otherBatch);
    await expect(insert(randomUUID(), otherBatch)).rejects.toThrow(/foreign key constraint/);
    expect((await f.client.query('SELECT phase,version,result,settled_at FROM staging_operations')).rows).toEqual([{ phase: 'queued', version: 0, result: null, settled_at: null }]);
    for (const assignment of ["phase='confirmed'", "kind='shell'", "payload='[]'", 'version=-1']) {
      await expect(f.client.exec(`UPDATE staging_operations SET ${assignment}`), assignment).rejects.toThrow(/check constraint/);
    }
  });

  it('upgrades legacy rows forward without creating roots or replaying old work, and is idempotent', async () => {
    const before = await migrationsBefore('staging_state'), through = await migrationsThrough('staging_state');
    const client = new PGlite(); onTestFinished(() => client.close()); const db = drizzle(client);
    await migrate(db, { migrationsFolder: before });
    const company = randomUUID(), task = randomUUID();
    await client.query("INSERT INTO companies(id,name,singleton) VALUES($1,'Legacy company',true)", [company]);
    await client.query("INSERT INTO tasks(id,company_id,number,title) VALUES($1,$2,1,'Legacy task')", [task, company]);
    const rows = (await client.query('SELECT to_jsonb(t) AS row FROM tasks t')).rows;
    await migrate(db, { migrationsFolder: through });
    expect((await client.query('SELECT to_jsonb(t) AS row FROM tasks t')).rows).toEqual(rows);
    for (const table of PRIVATE) expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
    const journal = (await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
    await migrate(db, { migrationsFolder: through });
    expect((await client.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(journal);
  });
});
