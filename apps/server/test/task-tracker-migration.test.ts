import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

const ACME = '00000000-0000-4000-8000-000000000a32';
const DEV = '00000000-0000-4000-8000-000000000d32';
const TASK = '00000000-0000-4000-8000-000000000e32';
const GOAL = '00000000-0000-4000-8000-000000000f32';
const IVAN = '00000000-0000-4000-8000-000000000b32';
const PIPE = '00000000-0000-4000-8000-000000000c32';

/* The tracker's migration: goals, pipelines and their stages are new, the tasks keep every row and gain empty fields, and a
   company that was there before it is marked for the one-time upgrade, which fills its open tasks by the server's own rule. */
describe('the task tracker migration', { timeout: 60_000 }, () => {
  it('keeps the tasks, adds the tracker tables and marks the company for its upgrade', async () => {
    const client = new PGlite();
    onTestFinished(() => client.close());
    await migrate(drizzle(client), { migrationsFolder: await migrationsBefore('task_tracker') });
    await client.exec(`
      INSERT INTO companies(id, name) VALUES ('${ACME}', 'Acme');
      INSERT INTO people(id, company_id, name, email, scope_kind, status, is_owner) VALUES ('${IVAN}', '${ACME}', 'Ivan', 'ivan@test', 'company', 'active', true);
      INSERT INTO departments(id, company_id, template_key, role_code, position) VALUES ('${DEV}', '${ACME}', 'development', 'DEV', 1);
      INSERT INTO tasks(id, company_id, number, department_id, title) VALUES ('${TASK}', '${ACME}', 1, '${DEV}', 'Checkout');
    `);
    await migrate(drizzle(client), { migrationsFolder: await migrationsThrough('task_tracker') });

    const task = await client.query('SELECT title, goal_id, responsible_person_id, why, due_at, pipeline_id, pipeline_stage_id, tracker_revision FROM tasks');
    expect(task.rows).toEqual([{ title: 'Checkout', goal_id: null, responsible_person_id: null, why: '', due_at: null, pipeline_id: null, pipeline_stage_id: null, tracker_revision: 0 }]);
    expect((await client.query('SELECT tracker_due FROM companies')).rows).toEqual([{ tracker_due: true }]);
    const fresh = await client.query<{ column_default: string }>("SELECT column_default FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'tracker_due'");
    expect(fresh.rows).toEqual([{ column_default: 'false' }]);

    await client.exec(`INSERT INTO goals(id, company_id, number, title, responsible_person_id) VALUES ('${GOAL}', '${ACME}', 1, '500 subscribers', '${IVAN}')`);
    await expect(client.exec(`UPDATE goals SET parent_goal_id = id WHERE id = '${GOAL}'`)).rejects.toThrow(/goals_not_own_parent/);
    await expect(client.exec(`UPDATE goals SET status = 'paused' WHERE id = '${GOAL}'`)).rejects.toThrow(/goals_status/);
    await client.exec(`INSERT INTO goal_events(company_id, goal_id, kind, person_id, text) VALUES ('${ACME}', '${GOAL}', 'created', '${IVAN}', '')`);

    await client.exec(`INSERT INTO pipelines(id, company_id, department_id, name) VALUES ('${PIPE}', '${ACME}', '${DEV}', 'Releases')`);
    await expect(client.exec(`INSERT INTO pipeline_stages(company_id, pipeline_id, name) VALUES ('${ACME}', '${PIPE}', 'Nobody')`)).rejects.toThrow(/pipeline_stages_one_owner/);
    await client.exec(`INSERT INTO pipeline_stages(company_id, pipeline_id, name, owner_role) VALUES ('${ACME}', '${PIPE}', 'Build', 'DEV-ENG')`);
    await client.exec(`UPDATE tasks SET goal_id = '${GOAL}', pipeline_id = '${PIPE}', pipeline_stage_id = (SELECT id FROM pipeline_stages) WHERE id = '${TASK}'`);
  });
});
