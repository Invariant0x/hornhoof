import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';
import { freshPglite } from './helpers-db.js';

const ACME = '00000000-0000-4000-8000-000000000a11';
const DEV = '00000000-0000-4000-8000-000000000b11';
const TASK = '00000000-0000-4000-8000-000000000c11';

describe('the autonomous release migration', { timeout: 60_000 }, () => {
  it('migrates an existing company with autonomous_release = false and creates the autonomous_releases journal table', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    await migrate(drizzle(client), { migrationsFolder: await migrationsBefore('autonomous_release') });
    await client.exec(`
      INSERT INTO companies(id, name) VALUES ('${ACME}', 'Acme');
      INSERT INTO departments(id, company_id, template_key, role_code, position) VALUES ('${DEV}', '${ACME}', 'development', 'DEV', 1);
      INSERT INTO tasks(id, company_id, number, title, department_id, status) VALUES ('${TASK}', '${ACME}', 7, 'Ship', '${DEV}', 'working');
    `);
    await migrate(drizzle(client), { migrationsFolder: await migrationsThrough('autonomous_release') });

    const { rows: companies } = await client.query<{ id: string; autonomous_release: boolean }>(
      'SELECT id, autonomous_release FROM companies',
    );
    expect(companies).toEqual([{ id: ACME, autonomous_release: false }]);

    const sha = 'a'.repeat(40);
    const baseSha = '1'.repeat(40);
    await client.exec(`
      INSERT INTO autonomous_releases(
        company_id, department_id, task_id, task_number, agent_name, commit_sha, base_commit_sha, test_run_number, reviewer_name, verdict_stage
      ) VALUES ('${ACME}', '${DEV}', '${TASK}', 7, 'Hana', '${sha}', '${baseSha}', 42, 'Rita', 'review');
    `);
    const { rows: entries } = await client.query<{ commit_sha: string; base_commit_sha: string; test_run_number: number; reviewer_name: string }>(
      'SELECT commit_sha, base_commit_sha, test_run_number, reviewer_name FROM autonomous_releases',
    );
    expect(entries).toEqual([{ commit_sha: sha, base_commit_sha: baseSha, test_run_number: 42, reviewer_name: 'Rita' }]);

    await expect(
      client.exec(`
        INSERT INTO autonomous_releases(
          company_id, task_number, agent_name, commit_sha, base_commit_sha, test_run_number, reviewer_name, verdict_stage
        ) VALUES ('${ACME}', 7, 'Hana', 'not-a-sha', '${baseSha}', 42, 'Rita', 'review');
      `),
    ).rejects.toThrow();

    await expect(
      client.exec(`
        INSERT INTO autonomous_releases(
          company_id, task_number, agent_name, commit_sha, base_commit_sha, test_run_number, reviewer_name, verdict_stage
        ) VALUES ('${ACME}', 7, 'Hana', '${sha}', 'not-a-base-sha', 42, 'Rita', 'review');
      `),
    ).rejects.toThrow();
  });
});
