import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, testParts, testRuns } from '../src/db/schema.js';
import { checkTestTimes } from '../src/modules/testruns/runs.js';
import { company, done, idle, nextOf } from './test-runs-company.js';

type Company = Awaited<ReturnType<typeof company>>;

/* Bruno starts a run of this many parts and ends his turn; each part goes to a machine of its own. */
async function started(c: Company, parts = 1) {
  const machines = [await c.machine(c.ceo, 'dev-mac')];
  if (parts > 1) machines.push(await c.machine(c.ann, 'ann-pc', idle({ load: 1 })));
  const t = await c.turn(c.bruno);
  expect((await t.call('run_tests', parts > 1 ? { command: 'make check -- {part}', parts } : { command: 'make check' })).error).toBe(false);
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, t.job.id));
  const given = [];
  for (const m of machines) given.push(await nextOf(m.node, 'tests.run'));
  return { machines, given };
}

/* What the end of a part writes first, and all the server kept of it when it stopped before the end of the run. */
const endedHere = (c: Company, partId: string, status: 'passed' | 'failed') =>
  c.db.update(testParts).set({ status, exitCode: status === 'passed' ? 0 : 1, commit: 'a'.repeat(40), finishedAt: new Date() }).where(eq(testParts.id, partId));

const runRow = async (c: Company) => (await c.db.select().from(testRuns))[0]!;

/* What Bruno was told on the task since he ended his turn. */
const toldBruno = async (c: Company) =>
  (await c.db.select({ prompt: jobs.prompt }).from(jobs).where(and(eq(jobs.agentId, c.bruno.id), eq(jobs.taskId, c.task.id), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt))).map(j => j.prompt);

describe('a run whose every part ended', () => {
  it('ends when the node says again that its last part ended, after the server stopped between the part and the run', async () => {
    const c = await company();
    const { machines: [ivan], given: [part] } = await started(c);
    await endedHere(c, part!.partId, 'passed');
    ivan!.node.send(done(part!));
    await nextOf(ivan!.node, 'tests.ack');
    const run = await runRow(c);
    expect(run.status).toBe('passed');
    expect(run.finishedAt).not.toBeNull();
    const told = await toldBruno(c);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/Test run 1 passed/);
  });

  it('ends as passed on the round after a restart, when all its parts passed, and its agent hears of it once', async () => {
    const c = await company();
    const { given: [part] } = await started(c);
    await endedHere(c, part!.partId, 'passed');
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 60_000));
    const run = await runRow(c);
    expect(run.status).toBe('passed');
    expect(run.finishedAt).not.toBeNull();
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 2 * 60_000));
    const told = await toldBruno(c);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/Test run 1 passed/);
  });

  it('ends as failed on the round when one of its parts failed', async () => {
    const c = await company();
    const { given: [first, second] } = await started(c, 2);
    await endedHere(c, first!.partId, 'passed');
    await endedHere(c, second!.partId, 'failed');
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 60_000));
    const run = await runRow(c);
    expect(run.status).toBe('failed');
    expect(run.finishedAt).not.toBeNull();
    expect(await toldBruno(c)).toEqual([expect.stringMatching(/Test run 1 failed/)]);
  });

  it('stays open on the round while one of its parts still runs', async () => {
    const c = await company();
    const { given: [first] } = await started(c, 2);
    await endedHere(c, first!.partId, 'passed');
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 60_000));
    expect(await runRow(c)).toMatchObject({ status: 'running', finishedAt: null });
    expect(await toldBruno(c)).toEqual([]);
  });
});
