import { expect, it } from 'vitest';
import { startRun } from '../../src/modules/testruns/runs.js';
import { eq } from 'drizzle-orm';
import { testParts, testRuns } from '../../src/db/schema.js';
import { until } from '../helpers-basic.js';
import { backendPid, FIXTURE_COMMIT, privatePostgres, runFixture } from './helpers.js';

it('observes startRun blocked by the company row owner and commits exactly once after release', async () => {
  const pg = await privatePostgres();
  const fixture = await runFixture(pg);
  const actor = fixture.actors[0];
  const locker = await pg.pool('locker').connect();
  let pending: Promise<string> | undefined;
  let completions = 0;
  try {
    const owner = (await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const waiter = await backendPid(actor.pool);
    expect(owner).not.toBe(waiter);
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [fixture.companyId]);
    pending = startRun(actor.ctx, actor.job, { task: actor.task.number, branch: `release-${actor.task.number}`, command: 'lock-fixture', parts: 1 }).then(reply => { completions++; return reply; });
    void pending.catch(() => {});
    const waiting = async () => (await pg.admin.query<{ blocked: boolean; query: string }>('SELECT $1::int = ANY(pg_blocking_pids(pid)) AS blocked, query FROM pg_stat_activity WHERE pid = $2', [owner, waiter])).rows[0];
    await until(async () => (await waiting())?.blocked === true);
    expect(await waiting()).toMatchObject({ blocked: true, query: expect.stringMatching(/companies.*for update/i) });
    expect(completions).toBe(0);
    expect(await pg.db.select().from(testRuns)).toEqual([]);
    await locker.query('COMMIT');
    expect(await pending).toContain('Test run 1 of #1');
    expect(completions).toBe(1);
    const [run] = await pg.db.select().from(testRuns);
    expect(run).toMatchObject({ number: 1, companyId: fixture.companyId, taskId: actor.task.id, agentId: actor.job.agentId, jobId: actor.job.id, command: 'lock-fixture', commitSha: FIXTURE_COMMIT });
    expect(await pg.db.select().from(testRuns)).toHaveLength(1);
    const parts = await pg.db.select().from(testParts).where(eq(testParts.runId, run!.id));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ companyId: fixture.companyId, part: 1, status: 'queued' });
    expect((await pg.admin.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers', [waiter])).rows[0]!.blockers).toEqual([]);
    expect(completions).toBe(1);
  } finally {
    try { await locker.query('ROLLBACK'); } finally {
      locker.release(true);
      await pending?.catch(() => {});
    }
  }
});
