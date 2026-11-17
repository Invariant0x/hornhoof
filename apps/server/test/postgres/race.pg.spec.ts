import { expect, it } from 'vitest';
import { startRun } from '../../src/modules/testruns/runs.js';
import { asc, eq } from 'drizzle-orm';
import { testParts, testRuns } from '../../src/db/schema.js';
import { backendPid, FIXTURE_COMMIT, privatePostgres, runFixture } from './helpers.js';

it('commits consecutive run numbers and every task and part across independent PostgreSQL connections', async () => {
  const pg = await privatePostgres();
  const fixture = await runFixture(pg, { barrier: true });
  const pids = await Promise.all(fixture.actors.map(actor => backendPid(actor.pool)));
  expect(new Set(pids).size).toBe(2);
  const started = Promise.all(fixture.actors.map((actor, index) => startRun(actor.ctx, actor.job, { task: actor.task.number, branch: `release-${actor.task.number}`, command: `task-${actor.task.number} --shard={part}/{parts}`, parts: index + 2 })));
  pg.cleanup(async () => { fixture.repository.release(); await started.catch(() => {}); });
  await Promise.race([fixture.repository.ready, started.then(() => { throw new Error('Runs completed before the repository barrier released'); })]);
  expect(fixture.repository.requests()).toBe(2);
  expect(await pg.db.select().from(testRuns)).toEqual([]);
  fixture.repository.release();
  const replies = await started;
  const runs = await pg.db.select().from(testRuns).orderBy(asc(testRuns.number));
  expect(runs.map(run => run.number)).toEqual([1, 2]);
  expect(new Set(runs.map(run => run.id)).size).toBe(2);
  for (const [index, actor] of fixture.actors.entries()) {
    const run = runs.find(row => row.taskId === actor.task.id)!;
    expect(run).toMatchObject({ companyId: fixture.companyId, agentId: actor.job.agentId, jobId: actor.job.id, departmentId: fixture.departmentId, command: `task-${actor.task.number} --shard={part}/{parts}`, parts: index + 2, branch: `release-${actor.task.number}`, commitSha: FIXTURE_COMMIT });
    expect(replies[index]).toContain(`Test run ${run.number} of #${actor.task.number}`);
    const parts = await pg.db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.part));
    expect(parts.map(part => ({ companyId: part.companyId, runId: part.runId, part: part.part, status: part.status }))).toEqual(Array.from({ length: index + 2 }, (_, part) => ({ companyId: fixture.companyId, runId: run.id, part: part + 1, status: 'queued' })));
  }
  expect(await pg.db.select().from(testParts)).toHaveLength(5);
});
