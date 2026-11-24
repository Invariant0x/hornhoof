import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { MIGRATIONS } from '../src/db/client.js';
import { freshPglite } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

const ACME = '00000000-0000-4000-8000-000000000a01';
const DEV = '00000000-0000-4000-8000-000000000b01';
const TURN = '00000000-0000-4000-8000-000000000c24';
const AGENT = '00000000-0000-4000-8000-000000000e01';
const RUN = '00000000-0000-4000-8000-000000000f01';
const COMMIT = 'c'.repeat(40);
const BASE = 'a'.repeat(40);
const OTHER = 'd'.repeat(40);
const GITHUB_RUN_ID = 45_292_644_380;

const rows = async <T,>(client: PGlite, query: string) => (await client.query<T>(query)).rows;

async function upgradedClient(): Promise<PGlite> {
  const client = await freshPglite();
  onTestFinished(() => client.close());
  await migrate(drizzle(client), { migrationsFolder: await migrationsBefore('turn_release_github_runs') });
  await client.exec(`
    INSERT INTO companies(id, name, turn_numbers_used) VALUES ('${ACME}', 'Acme', 24);
    INSERT INTO departments(id, company_id, template_key, role_code, position, repo_url) VALUES
      ('${DEV}', '${ACME}', 'development', 'DEV', 1, 'https://github.com/invariant0x/hornhoof.git');
    INSERT INTO agents(id, company_id, kind, name, model, department_id) VALUES
      ('${AGENT}', '${ACME}', 'head', 'Head of development', '', '${DEV}');
    INSERT INTO turns(id, company_id, department_id, number, goal, status, opened_at) VALUES
      ('${TURN}', '${ACME}', '${DEV}', 24, 'Release 0.43.0', 'open', now());
    INSERT INTO test_runs(id, company_id, number, agent_id, department_id, branch, commit_sha, command, parts, timeout_ms, status) VALUES
      ('${RUN}', '${ACME}', 42, '${AGENT}', '${DEV}', 'turn-24', '${COMMIT}', '', 2, 600000, 'passed');
    INSERT INTO autonomous_releases(company_id, department_id, task_number, agent_name, commit_sha, base_commit_sha, test_run_id, test_run_number, reviewer_name, verdict_stage) VALUES
      ('${ACME}', '${DEV}', 10, 'Head', '${COMMIT}', '${BASE}', '${RUN}', 42, 'Reviewer', 'review');
    INSERT INTO turn_releases(company_id, turn_id, commit, base_commit_sha, run_id, covered) VALUES
      ('${ACME}', '${TURN}', '${COMMIT}', '${BASE}', '${RUN}', true);
  `);
  await migrate(drizzle(client), { migrationsFolder: await migrationsThrough('turn_release_github_runs') });
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
  return client;
}

describe('turn_release_github_runs migration', () => {
  it('upgrades existing turn_releases and autonomous_releases rows and stores 64-bit GitHub run proofs with strict constraints', async () => {
    const client = await upgradedClient();

    const prior = await rows<{ run_id: string | null; github_run_id: string | null; github_run_attempt: number | null; github_run_commit: string | null }>(
      client,
      `SELECT run_id, github_run_id, github_run_attempt, github_run_commit FROM turn_releases`,
    );
    expect(prior).toEqual([{ run_id: RUN, github_run_id: null, github_run_attempt: null, github_run_commit: null }]);

    await client.query(`
      INSERT INTO turn_releases(company_id, turn_id, commit, base_commit_sha, github_run_id, github_run_attempt, github_run_commit, covered)
      VALUES ('${ACME}', '${TURN}', '${COMMIT}', '${BASE}', ${GITHUB_RUN_ID}, 2, '${COMMIT}', true)
    `);
    await client.query(`
      INSERT INTO autonomous_releases(company_id, department_id, task_number, agent_name, commit_sha, base_commit_sha, test_run_id, test_run_number, reviewer_name, verdict_stage)
      VALUES ('${ACME}', '${DEV}', 11, 'Head', '${COMMIT}', '${BASE}', null, ${GITHUB_RUN_ID}, 'Reviewer', 'review')
    `);

    const numbers = await rows<{ test_run_number: string | number }>(client, `SELECT test_run_number FROM autonomous_releases ORDER BY task_number`);
    expect(numbers.map(r => Number(r.test_run_number))).toEqual([42, GITHUB_RUN_ID]);

    const bad = (runId: string, ghId: string, attempt: string, ghCommit: string) => client.query(`
      INSERT INTO turn_releases(company_id, turn_id, commit, base_commit_sha, run_id, github_run_id, github_run_attempt, github_run_commit, covered)
      VALUES ('${ACME}', '${TURN}', '${COMMIT}', '${BASE}', ${runId}, ${ghId}, ${attempt}, ${ghCommit}, true)
    `);
    await expect(bad(`'${RUN}'`, String(GITHUB_RUN_ID), '2', `'${COMMIT}'`)).rejects.toThrow(/turn_releases_github_run/);
    await expect(bad('null', String(GITHUB_RUN_ID), 'null', `'${COMMIT}'`)).rejects.toThrow(/turn_releases_github_run/);
    await expect(bad('null', String(GITHUB_RUN_ID), '2', 'null')).rejects.toThrow(/turn_releases_github_run/);
    await expect(bad('null', 'null', '2', `'${COMMIT}'`)).rejects.toThrow(/turn_releases_github_run/);
    await expect(bad('null', '0', '2', `'${COMMIT}'`)).rejects.toThrow(/turn_releases_github_run/);
    await expect(bad('null', String(GITHUB_RUN_ID), '0', `'${COMMIT}'`)).rejects.toThrow(/turn_releases_github_run/);
    await expect(bad('null', String(GITHUB_RUN_ID), '2', `'${OTHER}'`)).rejects.toThrow(/turn_releases_github_run/);
  });
});
