import { and, asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { agentEvents, jobs, pendingWakes, taskEvents, tasks, testRuns } from '../src/db/schema.js';
import { checkExternalWaits } from '../src/modules/tasks/external-wait.js';
import { checkTestTimes } from '../src/modules/testruns/runs.js';
import { until } from './helpers.js';
import { company, done, idle, nextOf } from './test-runs-company.js';

const anHour = () => new Date(Date.now() + 3_600_000).toISOString();
const RUN_TOOLS = [
  { tool: 'run_tests', state: 'test_run', stop: 'stop_tests', args: {}, name: 'Test run', why: 'tests' },
  { tool: 'run_work', state: 'work_run', stop: 'stop_work', args: { branch: 'main' }, name: 'Work run', why: 'work' },
] as const;

/* The turns the agent was given on the task since it went to wait, and how often it was told of a run's end. */
async function toldOf(c: Awaited<ReturnType<typeof company>>, agentId: string, taskId: string) {
  const turns = await c.db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued')));
  const events = await c.db.select({ data: agentEvents.data }).from(agentEvents).where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.kind, 'message')));
  const news = events.filter(e => ['tests', 'work'].includes((e.data as { taskWake?: { why?: string } }).taskWake?.why ?? ''));
  return { turns, prompts: turns.map(t => t.prompt), news: news.length };
}

/* Bruno starts a run on the task, waits an hour for it and ends the turn, as an agent does: only a new turn can tell the
   agent anything from then on. */
async function waitingOn(c: Awaited<ReturnType<typeof company>>, run: (typeof RUN_TOOLS)[number], args: object = {}) {
  const t = await c.turn(c.bruno);
  expect((await t.call(run.tool, { command: 'make check', ...run.args, ...args })).error).toBe(false);
  expect((await t.call('wait_for', { task: c.task.number, reason: 'The run', until: anHour() })).error).toBe(false);
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, t.job.id));
  return t;
}

const taskRow = async (c: Awaited<ReturnType<typeof company>>) => (await c.db.select().from(tasks).where(eq(tasks.id, c.task.id)))[0]!;

/* The wait is gone, and the one who started the run has exactly one turn with its result. */
async function endedOnce(c: Awaited<ReturnType<typeof company>>, line: RegExp) {
  await until(async () => (await taskRow(c)).externalWait === null);
  await until(async () => (await toldOf(c, c.bruno.id, c.task.id)).turns.length > 0);
  const told = await toldOf(c, c.bruno.id, c.task.id);
  expect(told.prompts).toHaveLength(1);
  expect(told.prompts[0]).toMatch(line);
  expect(told.news).toBe(1);
  await until(async () => (await c.db.select().from(pendingWakes).where(and(eq(pendingWakes.agentId, c.bruno.id), inArray(pendingWakes.why, ['tests', 'work'])))).length === 0);
  /* The wait is over, so its deadline wakes nobody any more. */
  expect(await checkExternalWaits(c.app.ctx, new Date(Date.now() + 2 * 3_600_000))).toBe(0);
  expect((await toldOf(c, c.bruno.id, c.task.id)).prompts).toHaveLength(1);
  return told.prompts[0]!;
}

describe('a run that ends while the one who started it waits', () => {
  describe.each(RUN_TOOLS)('$tool', run => {
    it('ends the wait and wakes the agent once with the result and where to read it, when it passes', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'ivan-mac');
      await waitingOn(c, run);
      await c.db.update(tasks).set({ silent: 2 }).where(eq(tasks.id, c.task.id));
      const before = await taskRow(c);
      const seen = vi.spyOn(c.app.ctx.bus, 'publish');
      ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));
      const prompt = await endedOnce(c, new RegExp(`${run.name} 1 (passed|is done)`));
      expect(seen).toHaveBeenCalledWith(before.companyId, expect.objectContaining({ type: 'task', id: c.task.id }));
      expect(prompt).toContain(`${run.state} 1`);
      const after = await taskRow(c);
      expect(after).toMatchObject({ externalWait: null, silent: 0, version: before.version + 1 });
      const [noted] = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'updated'))).orderBy(asc(taskEvents.createdAt)).then(rows => rows.slice(-1));
      expect(noted).toMatchObject({ agentId: c.bruno.id, data: { externalWait: null, reason: 'The run' } });
      expect(noted!.text).toContain(`${run.name} 1`);
    });

    it('ends the wait and wakes the agent once when its tests or command fail', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'ivan-mac');
      await waitingOn(c, run);
      ivan.node.send(done(await nextOf(ivan.node, 'tests.run'), { ok: false, exitCode: 1, error: 'failed', log: 'FAIL cart.test.ts\n' }));
      const prompt = await endedOnce(c, new RegExp(`${run.name} 1 failed`));
      expect(prompt).toContain('FAIL cart.test.ts');
    });

    it('ends the wait and wakes the agent once when it runs out of time', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'ivan-mac');
      await waitingOn(c, run, { minutes: 5 });
      await nextOf(ivan.node, 'tests.run');
      await checkTestTimes(c.app.ctx, new Date(Date.now() + 15 * 60_000));
      await endedOnce(c, new RegExp(`${run.name} 1 failed[\\s\\S]*did not end within 5 min`));
    });

    it('ends the wait and wakes the agent once when someone else stops it', async () => {
      const c = await company();
      await c.machine(c.ceo, 'ivan-mac');
      await waitingOn(c, run);
      expect((await (await c.turn(c.head, null)).call(run.stop, { run: 1 })).error).toBe(false);
      const prompt = await endedOnce(c, new RegExp(`${run.name} 1 was stopped by Hana`));
      expect(prompt).toContain(`${run.state} 1`);
    });

    it('ends the wait and wakes the agent once when the agent stops it from another turn', async () => {
      const c = await company();
      await c.machine(c.ceo, 'ivan-mac');
      await waitingOn(c, run);
      expect((await (await c.turn(c.bruno, null)).call(run.stop, { run: 1 })).error).toBe(false);
      await endedOnce(c, new RegExp(`${run.name} 1 was stopped by you`));
    });

    it('wakes the agent once, after the last part, when it has several', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'ivan-mac');
      const ann = await c.machine(c.ann, 'ann-pc', idle({ load: 1 }));
      await waitingOn(c, run, { command: 'make check -- {part}', parts: 2 });
      const first = await nextOf(ivan.node, 'tests.run');
      const second = await nextOf(ann.node, 'tests.run');
      ivan.node.send(done(first));
      await nextOf(ivan.node, 'tests.ack');
      expect((await taskRow(c)).externalWait).toMatchObject({ reason: 'The run' });
      expect((await toldOf(c, c.bruno.id, c.task.id)).turns).toEqual([]);
      ann.node.send(done(second));
      await nextOf(ann.node, 'tests.ack');
      await endedOnce(c, new RegExp(`${run.name} 1 (passed|is done)`));
    });

    it('wakes the agent once as before when it does not wait', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'ivan-mac');
      const t = await c.turn(c.bruno);
      await t.call(run.tool, { command: 'make check', ...run.args });
      await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, t.job.id));
      const before = await taskRow(c);
      ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));
      await nextOf(ivan.node, 'tests.ack');
      await endedOnce(c, new RegExp(`${run.name} 1 (passed|is done)`));
      /* With no wait to end, the task itself did not move. */
      expect((await taskRow(c)).version).toBe(before.version);
    });

    it('wakes nobody on a task cancelled meanwhile', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'ivan-mac');
      await waitingOn(c, run);
      const part = await nextOf(ivan.node, 'tests.run');
      expect((await (await c.turn(c.head, null)).call('cancel_task', { task: c.task.number, why: 'Not needed.' })).error).toBe(false);
      ivan.node.send(done(part));
      await nextOf(ivan.node, 'tests.ack');
      await until(async () => (await c.db.select().from(testRuns))[0]!.status !== 'running');
      expect(await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'wake_skipped')))).toEqual([]);
      expect((await toldOf(c, c.bruno.id, c.task.id)).turns).toEqual([]);
      expect(await c.db.select().from(pendingWakes).where(and(eq(pendingWakes.agentId, c.bruno.id), inArray(pendingWakes.why, ['tests', 'work'])))).toEqual([]);
    });
  });

  it('wakes the agent when the machine is gone for good', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    await waitingOn(c, RUN_TOOLS[1]);
    await nextOf(ivan.node, 'tests.run');
    ivan.node.close();
    await until(() => !c.app.ctx.hub.isOnline({ kind: 'node', nodeId: ivan.nodeId }));
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 4 * 60_000));
    await endedOnce(c, /Work run 1 failed[\s\S]*its machine went offline/);
  });

  it('wakes the agent when a test run was lost as often as it may be', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    await waitingOn(c, RUN_TOOLS[0]);
    for (const left of [2, 1, 0]) {
      await nextOf(ivan.node, 'tests.run');
      if (left) expect((await taskRow(c)).externalWait).toMatchObject({ reason: 'The run' });
      ivan.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    }
    await endedOnce(c, /Test run 1 failed[\s\S]*restarted and lost it/);
  });

  it('tells the agent of each run that ends, also of one that ended after it waited again', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const t = await c.turn(c.bruno);
    await t.call('run_tests', { command: 'make one' });
    await t.call('run_work', { command: 'make two', branch: 'main' });
    await t.call('wait_for', { task: c.task.number, reason: 'Both', until: anHour() });
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, t.job.id));
    const one = await nextOf(ann.node, 'tests.run');
    const two = await nextOf(ivan.node, 'tests.run');

    ann.node.send(done(one));
    await until(async () => (await toldOf(c, c.bruno.id, c.task.id)).turns.length === 1);
    expect((await taskRow(c)).externalWait).toBeNull();
    /* The turn for the first one ran, and the agent waits for the other one again. */
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(and(eq(jobs.agentId, c.bruno.id), eq(jobs.status, 'queued')));
    const again = await c.turn(c.bruno);
    expect((await again.call('wait_for', { task: c.task.number, reason: 'The other one', until: anHour() })).error).toBe(false);
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, again.job.id));

    ivan.node.send(done(two));
    await until(async () => (await toldOf(c, c.bruno.id, c.task.id)).turns.length === 1);
    expect((await taskRow(c)).externalWait).toBeNull();
    const told = await toldOf(c, c.bruno.id, c.task.id);
    expect(told.prompts[0]).toMatch(/Work run 2 is done/);
    expect(told.news).toBe(2);
  });

  it('keeps both results in the one turn that waits when two runs end before it starts', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const t = await c.turn(c.bruno);
    await t.call('run_tests', { command: 'make one' });
    await t.call('run_tests', { command: 'make two' });
    await t.call('wait_for', { task: c.task.number, reason: 'Both', until: anHour() });
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, t.job.id));
    const one = await nextOf(ann.node, 'tests.run');
    const two = await nextOf(ivan.node, 'tests.run');
    ann.node.send(done(one));
    await nextOf(ann.node, 'tests.ack');
    ivan.node.send(done(two));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await toldOf(c, c.bruno.id, c.task.id)).news === 2);
    const told = await toldOf(c, c.bruno.id, c.task.id);
    expect(told.prompts).toHaveLength(1);
    expect(told.prompts[0]).toMatch(/Test run 1 passed[\s\S]*Test run 2 passed/);
  });

  it("leaves the wait of someone else alone and still tells the one who started the run", async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const head = await c.turn(c.head, c.task.id);
    expect((await head.call('run_tests', { command: 'make check' })).error).toBe(false);
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, head.job.id));
    const bruno = await c.turn(c.bruno);
    expect((await bruno.call('wait_for', { task: c.task.number, reason: 'A deployment', until: anHour() })).error).toBe(false);
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, bruno.job.id));

    ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));
    await until(async () => (await toldOf(c, c.head.id, c.task.id)).turns.length > 0);

    expect((await toldOf(c, c.head.id, c.task.id)).prompts).toEqual([expect.stringContaining('Test run 1 passed')]);
    expect((await taskRow(c)).externalWait).toMatchObject({ reason: 'A deployment' });
    expect((await toldOf(c, c.bruno.id, c.task.id)).turns).toEqual([]);
  });

  it.each(RUN_TOOLS)('refuses a wait while the result of $tool waits for the agent in a turn', async run => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const t = await c.turn(c.bruno);
    await t.call(run.tool, { command: 'make check', ...run.args });
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, t.job.id));
    ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));
    await until(async () => (await toldOf(c, c.bruno.id, c.task.id)).turns.length === 1);

    const refused = await (await c.turn(c.bruno, null)).call('wait_for', { task: c.task.number, reason: 'Something else', until: anHour() });

    expect(refused.error).toBe(true);
    expect(refused.text).toContain(`#${c.task.number}`);
    expect((await taskRow(c)).externalWait).toBeNull();
    expect((await toldOf(c, c.bruno.id, c.task.id)).prompts).toEqual([expect.stringMatching(new RegExp(`${run.name} 1 (passed|is done)`))]);
  });

  it.each(RUN_TOOLS)('refuses a wait while the result of $tool is still on its way to a turn', async run => {
    const c = await company();
    const companyId = (await taskRow(c)).companyId;
    await c.db.insert(pendingWakes).values({ companyId, agentId: c.bruno.id, taskId: c.task.id, why: run.why, text: `${run.name} 1 failed.` });
    const refused = await (await c.turn(c.bruno, null)).call('wait_for', { task: c.task.number, reason: 'Something else', until: anHour() });
    expect(refused.error).toBe(true);
    expect((await taskRow(c)).externalWait).toBeNull();
  });
});
