import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { freshPglite } from './helpers-db.js';
import { migrationsBefore } from './migrations-before.js';

/* The files runs put on their tasks before a file named its run (#2036): each is found once by its task and name, as
   they were found until now, and also by the turn that started its run and its time, so a file an agent named like one
   names no run. */

const COMPANY = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-000000000005';
const OTHER_TASK = '00000000-0000-4000-8000-000000000015';
const RUN_JOB = '00000000-0000-4000-8000-000000000006';
const OTHER_JOB = '00000000-0000-4000-8000-000000000016';
const TESTS_5 = '00000000-0000-4000-8000-000000000007';
const WORK_7 = '00000000-0000-4000-8000-000000000017';

describe('the files runs made before their run was named on them', () => {
  it('name their run, and a file of another turn, from before the run or on another task names none', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    await migrate(drizzle(client), { migrationsFolder: await migrationsBefore('run_files') });
    await client.exec(`
      insert into companies (id, name) values ('${COMPANY}', 'Acme');
      insert into people (id, company_id, name, email, status, scope_kind)
        values ('00000000-0000-4000-8000-000000000002', '${COMPANY}', 'Ivan', 'ivan@example.com', 'active', 'company');
      insert into subscriptions (id, company_id, provider, kind, label, owner_person_id, status)
        values ('00000000-0000-4000-8000-000000000003', '${COMPANY}', 'codex', 'personal', 'Plan', '00000000-0000-4000-8000-000000000002', 'ready');
      insert into agents (id, company_id, kind, name, model, subscription_id)
        values ('00000000-0000-4000-8000-000000000004', '${COMPANY}', 'worker', 'Developer', '', '00000000-0000-4000-8000-000000000003');
      insert into tasks (id, company_id, number, title) values ('${TASK}', '${COMPANY}', 1, 'A task'), ('${OTHER_TASK}', '${COMPANY}', 2, 'Another task');
      insert into jobs (id, company_id, subscription_id, agent_id, task_id, prompt, timeout_ms)
        values ('${RUN_JOB}', '${COMPANY}', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', '${TASK}', 'go', 60000),
               ('${OTHER_JOB}', '${COMPANY}', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', '${TASK}', 'again', 60000);
      insert into test_runs (id, company_id, number, task_id, agent_id, job_id, kind, command, timeout_ms, created_at)
        values ('${TESTS_5}', '${COMPANY}', 5, '${TASK}', '00000000-0000-4000-8000-000000000004', '${RUN_JOB}', 'tests', 'npm test', 60000, '2026-11-01T10:00:00Z'),
               ('${WORK_7}', '${COMPANY}', 7, '${TASK}', '00000000-0000-4000-8000-000000000004', '${RUN_JOB}', 'work', 'make', 60000, '2026-11-01T10:00:00Z');
    `);
    const file = (name: string, job: string, task: string, at: string) =>
      client.query('insert into attachments (company_id, job_id, agent_id, task_id, name, media_type, size, created_at) values ($1, $2, $3, $4, $5, $6, 1, $7)', [
        COMPANY, job, '00000000-0000-4000-8000-000000000004', task, name, 'application/octet-stream', at,
      ]);
    const later = '2026-11-01T10:05:00Z';
    await file('tests-5-1.log', RUN_JOB, TASK, later);
    await file('test-5-1-shot.png', RUN_JOB, TASK, later);
    await file('work-7-1.log', RUN_JOB, TASK, later);
    await file('work-7-2-out.txt', RUN_JOB, TASK, later);
    await file('test-5-plan.md', OTHER_JOB, TASK, later);
    await file('tests-5-3.log', RUN_JOB, TASK, '2026-11-01T09:00:00Z');
    await file('tests-5-1.log', RUN_JOB, OTHER_TASK, later);
    await file('notes.md', RUN_JOB, TASK, later);

    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
    const named = (await client.query<{ name: string; task_id: string; test_run_id: string | null }>('select name, task_id, test_run_id from attachments order by name, task_id')).rows;
    expect(named).toEqual([
      { name: 'notes.md', task_id: TASK, test_run_id: null },
      { name: 'test-5-1-shot.png', task_id: TASK, test_run_id: TESTS_5 },
      { name: 'test-5-plan.md', task_id: TASK, test_run_id: null },
      { name: 'tests-5-1.log', task_id: TASK, test_run_id: TESTS_5 },
      { name: 'tests-5-1.log', task_id: OTHER_TASK, test_run_id: null },
      { name: 'tests-5-3.log', task_id: TASK, test_run_id: null },
      { name: 'work-7-1.log', task_id: TASK, test_run_id: WORK_7 },
      { name: 'work-7-2-out.txt', task_id: TASK, test_run_id: WORK_7 },
    ]);
  });
});
