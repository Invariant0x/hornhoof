import { deferred as waitRaceBarrier } from '../../../test-support/deferred.mjs';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { idOnly, only } from '../src/db/selections.js';
import { ApiError } from '../src/errors.js';
import * as waitNotices from '../src/modules/tasks/wait-notices.js';
import { agentEvents, agents, jobs, pendingWakes, people, taskEvents, tasks, taskWaits, testParts, testRuns, waitPolicies } from '../src/db/schema.js';
import { checkExternalWaits, waitFor } from '../src/modules/tasks/external-wait.js';
import { checkTestTimes, pumpTests } from '../src/modules/testruns/runs.js';
import { until } from './helpers.js';
import { company, done, GIB, idle, nextOf, reportHost } from './test-runs-company.js';

const anHour = () => new Date(Date.now() + 3_600_000).toISOString();

const RUN_TOOLS = [
  { tool: 'run_tests', state: 'test_run', stop: 'stop_tests', args: { branch: 'main' }, name: 'Test run', why: 'tests' },
  { tool: 'run_work', state: 'work_run', stop: 'stop_work', args: { branch: 'main' }, name: 'Work run', why: 'work' },
] as const;

/* The turns the agent was given on the task since it went to wait, and how often it was told of a run's end. */
async function toldOf(c: Awaited<ReturnType<typeof company>>, agentId: string, taskId: string) {
  const turns = await c.db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued')));
  const events = await c.db.select(only(agentEvents, 'data')).from(agentEvents).where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.kind, 'message')));
  const news = events.filter(e => ['tests', 'work'].includes((e.data as { taskWake?: { why?: string } }).taskWake?.why ?? ''));
  return { turns, prompts: turns.map(t => t.prompt), news: news.length };
}

/* Bruno starts a run on the task, waits an hour for it and ends the turn, as an agent does: only a new turn can tell the
   agent anything from then on. */
async function waitingOn(c: Awaited<ReturnType<typeof company>>, run: (typeof RUN_TOOLS)[number], args: object = {}) {
  const t = await c.turn(c.bruno);
  const started = await t.call(run.tool, { command: 'make check', ...run.args, ...args });
  expect(started.error).toBe(false);
  expect((await t.call('wait_for', { task: c.task.number, reason: 'The run', until: anHour(), run: Number(/run (\d+)/.exec(started.text)![1]) })).error).toBe(false);
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
      const ivan = await c.machine(c.ceo, 'dev-mac');
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
      const ivan = await c.machine(c.ceo, 'dev-mac');
      await waitingOn(c, run);
      ivan.node.send(done(await nextOf(ivan.node, 'tests.run'), { ok: false, exitCode: 1, error: 'failed', log: 'FAIL cart.test.ts\n' }));
      const prompt = await endedOnce(c, new RegExp(`${run.name} 1 failed`));
      expect(prompt).toContain('FAIL cart.test.ts');
    });

    it('ends the wait and wakes the agent once when it runs out of time', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac');
      await waitingOn(c, run, { minutes: 5 });
      await nextOf(ivan.node, 'tests.run');
      await checkTestTimes(c.app.ctx, new Date(Date.now() + 15 * 60_000));
      const cause = run.tool === 'run_tests' ? 'reached the upper time limit of 5 min' : 'did not end within 5 min';
      await endedOnce(c, new RegExp(`${run.name} 1 failed[\\s\\S]*${cause}`));
    });

    it('ends the wait and wakes the agent once when someone else stops it', async () => {
      const c = await company();
      await c.machine(c.ceo, 'dev-mac');
      await waitingOn(c, run);
      expect((await (await c.turn(c.head, null)).call(run.stop, { run: 1 })).error).toBe(false);
      const prompt = await endedOnce(c, new RegExp(`${run.name} 1 was stopped by Hana`));
      expect(prompt).toContain(`${run.state} 1`);
    });

    it('ends the wait and wakes the agent once when the agent stops it from another turn', async () => {
      const c = await company();
      await c.machine(c.ceo, 'dev-mac');
      await waitingOn(c, run);
      expect((await (await c.turn(c.bruno, null)).call(run.stop, { run: 1 })).error).toBe(false);
      await endedOnce(c, new RegExp(`${run.name} 1 was stopped by you`));
    });

    it('wakes the agent once, after the last part, when it has several', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac');
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
      const ivan = await c.machine(c.ceo, 'dev-mac');
      const t = await c.turn(c.bruno);
      await t.call(run.tool, { command: 'make check', ...run.args });
      await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, t.job.id));
      const before = await taskRow(c);
      ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));
      await nextOf(ivan.node, 'tests.ack');
      await endedOnce(c, new RegExp(`${run.name} 1 (passed|is done)`));
      /* A new result invalidates a concurrent wait built from the old task revision. */
      expect((await taskRow(c)).version).toBe(before.version + 1);
    });

    it('wakes nobody on a task cancelled meanwhile', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac');
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
    const ivan = await c.machine(c.ceo, 'dev-mac');
    await waitingOn(c, RUN_TOOLS[1]);
    await nextOf(ivan.node, 'tests.run');
    ivan.node.close();
    await until(() => !c.app.ctx.hub.isOnline({ kind: 'node', nodeId: ivan.nodeId }));
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 4 * 60_000));
    await endedOnce(c, /Work run 1 failed[\s\S]*its machine went offline/);
  });

  it('wakes the agent when a test run was lost as often as it may be', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
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
    const ivan = await c.machine(c.ceo, 'dev-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const t = await c.turn(c.bruno);
    await t.call('run_tests', { branch: 'main', command: 'make one' });
    await t.call('run_work', { command: 'make two', branch: 'main' });
    await t.call('wait_for', { task: c.task.number, reason: 'The first', until: anHour(), run: 1 });
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, t.job.id));
    const one = await nextOf(ann.node, 'tests.run');
    const two = await nextOf(ivan.node, 'tests.run');

    ann.node.send(done(one));
    await until(async () => (await toldOf(c, c.bruno.id, c.task.id)).turns.length === 1);
    expect((await taskRow(c)).externalWait).toBeNull();
    /* The turn for the first one ran, and the agent waits for the other one again. */
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(and(eq(jobs.agentId, c.bruno.id), eq(jobs.status, 'queued')));
    const again = await c.turn(c.bruno);
    expect((await again.call('wait_for', { task: c.task.number, reason: 'The other one', until: anHour(), run: 2 })).error).toBe(false);
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
    const ivan = await c.machine(c.ceo, 'dev-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const t = await c.turn(c.bruno);
    await t.call('run_tests', { branch: 'main', command: 'make one' });
    await t.call('run_tests', { branch: 'main', command: 'make two' });
    await t.call('wait_for', { task: c.task.number, reason: 'The second', until: anHour(), run: 2 });
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

  describe('and its wait names which run it is for', () => {
    const openWait = async (c: Awaited<ReturnType<typeof company>>, sourceKey: string) => (await c.db.select().from(taskWaits).where(and(eq(taskWaits.taskId, c.task.id), eq(taskWaits.sourceKey, sourceKey))))[0]!;
    const runOf = async (c: Awaited<ReturnType<typeof company>>, number: number) => (await c.db.select().from(testRuns).where(eq(testRuns.number, number)))[0]!;
    const finish = (c: Awaited<ReturnType<typeof company>>, job: string) => c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, job));

    it.each(RUN_TOOLS)('leaves a wait of its starter alone when it names no run, and tells it of $tool all the same', async run => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac');
      const t = await c.turn(c.bruno);
      await t.call(run.tool, { command: 'make check', ...run.args });
      expect((await t.call('wait_for', { task: c.task.number, reason: 'A deployment', until: anHour() })).error).toBe(false);
      await finish(c, t.job.id);
      const before = await taskRow(c);
      ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));
      await until(async () => (await toldOf(c, c.bruno.id, c.task.id)).news === 1);
      expect(await taskRow(c)).toMatchObject({ externalWait: { reason: 'A deployment' }, version: before.version + 1 });
      expect(await openWait(c, `wait_for:${before.externalWait!.operation!}`)).toMatchObject({ state: 'legacy_needs_plan' });
      const told = await toldOf(c, c.bruno.id, c.task.id);
      expect(told.prompts).toEqual([expect.stringMatching(new RegExp(`${run.name} 1 (passed|is done)`))]);
      expect(told.prompts[0]).toContain('end_wait');
    });

    it('lets the agent end the wait it no longer needs as it reads the result, with no wake at its deadline', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac');
      const t = await c.turn(c.bruno);
      await t.call('run_tests', { branch: 'main', command: 'make check' });
      await t.call('wait_for', { task: c.task.number, reason: 'The run, I forgot to name it', until: anHour() });
      await finish(c, t.job.id);
      const { until: deadline, operation } = (await taskRow(c)).externalWait!;
      ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));
      await until(async () => (await toldOf(c, c.bruno.id, c.task.id)).news === 1);
      await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(and(eq(jobs.agentId, c.bruno.id), eq(jobs.status, 'queued')));
      const reading = await c.turn(c.bruno);
      const ended = await reading.call('end_wait', { task: c.task.number });
      expect(ended.error).toBe(false);
      expect(ended.text).toContain('The run, I forgot to name it');
      expect(await taskRow(c)).toMatchObject({ externalWait: null, silent: 0 });
      expect(await openWait(c, `wait_for:${operation!}`)).toMatchObject({ state: 'cancelled', proofRef: 'end_wait' });
      await finish(c, reading.job.id);
      expect(await checkExternalWaits(c.app.ctx, new Date(Date.parse(deadline) + 1))).toBe(0);
      expect((await toldOf(c, c.bruno.id, c.task.id)).turns).toEqual([]);
    });

    it('refuses end_wait with no wait, and on the wait of another holder', async () => {
      const c = await company();
      const t = await c.turn(c.bruno);
      expect((await t.call('end_wait', { task: c.task.number })).error).toBe(true);
      await t.call('wait_for', { task: c.task.number, reason: 'A deployment', until: anHour() });
      expect((await (await c.turn(c.head, c.task.id)).call('end_wait', { task: c.task.number })).error).toBe(true);
      expect((await taskRow(c)).externalWait).toMatchObject({ reason: 'A deployment' });
    });

    it('leaves a wait for another run alone, and ends with the run it names', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac', idle({ load: 6 }));
      const ann = await c.machine(c.ann, 'ann-pc');
      const t = await c.turn(c.bruno);
      await t.call('run_tests', { branch: 'main', command: 'make one' });
      await t.call('run_tests', { branch: 'main', command: 'make two' });
      await t.call('wait_for', { task: c.task.number, reason: 'The second', until: anHour(), run: 2 });
      await finish(c, t.job.id);
      const operation = (await taskRow(c)).externalWait!.operation!;
      ann.node.send(done(await nextOf(ann.node, 'tests.run')));
      await until(async () => (await toldOf(c, c.bruno.id, c.task.id)).news === 1);
      expect((await taskRow(c)).externalWait).toMatchObject({ reason: 'The second' });
      expect(await openWait(c, `wait_for:${operation}`)).toMatchObject({ state: 'legacy_needs_plan' });
      ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));
      await until(async () => (await toldOf(c, c.bruno.id, c.task.id)).news === 2);
      expect((await taskRow(c)).externalWait).toBeNull();
      expect(await openWait(c, `wait_for:${operation}`)).toMatchObject({ state: 'resolved', proofRef: `run:${(await runOf(c, 2)).id}:passed` });
    });

    it.each(RUN_TOOLS)('gives no second wake at the deadline of a wait $tool ended', async run => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac');
      await waitingOn(c, run);
      const { until: deadline } = (await taskRow(c)).externalWait!;
      ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));
      await endedOnce(c, new RegExp(`${run.name} 1 (passed|is done)`));
      expect(await checkExternalWaits(c.app.ctx, new Date(Date.parse(deadline) + 1))).toBe(0);
      expect((await toldOf(c, c.bruno.id, c.task.id)).turns).toHaveLength(1);
    });

    it('ends a wait that came back at its deadline when its run ends later, with no new wake for the wait', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac');
      await waitingOn(c, RUN_TOOLS[0]);
      const { until: deadline, operation } = (await taskRow(c)).externalWait!;
      expect(await checkExternalWaits(c.app.ctx, new Date(Date.parse(deadline) + 1))).toBe(1);
      expect(await openWait(c, `wait_for:${operation!}`)).toMatchObject({ state: 'legacy_needs_plan', sourceState: { stage: 'check_back' } });
      ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));
      await nextOf(ivan.node, 'tests.ack');
      await until(async () => (await openWait(c, `wait_for:${operation!}`)).state === 'resolved');
      expect((await taskRow(c)).externalWait).toBeNull();
    });

    it('refuses a wait for a run that ended, one of another task or one that never was', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac');
      const t = await c.turn(c.bruno);
      await t.call('run_tests', { branch: 'main', command: 'make check' });
      ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));
      await nextOf(ivan.node, 'tests.ack');
      await finish(c, t.job.id);
      await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(and(eq(jobs.agentId, c.bruno.id), eq(jobs.status, 'queued')));
      await c.db.delete(pendingWakes).where(eq(pendingWakes.agentId, c.bruno.id));
      await c.db.delete(agentEvents).where(eq(agentEvents.agentId, c.bruno.id));
      const again = await c.turn(c.bruno);
      for (const number of [1, 99]) {
        const refused = await again.call('wait_for', { task: c.task.number, reason: 'The run', until: anHour(), run: number });
        expect(refused.error, `run ${number}`).toBe(true);
      }
      expect((await taskRow(c)).externalWait).toBeNull();
    });

    it('takes no wait for the run of someone else', async () => {
      const c = await company();
      await c.machine(c.ceo, 'dev-mac');
      const head = await c.turn(c.head, c.task.id);
      await head.call('run_tests', { branch: 'main', command: 'make check' });
      const refused = await (await c.turn(c.bruno)).call('wait_for', { task: c.task.number, reason: 'The run', until: anHour(), run: 1 });
      expect(refused.error).toBe(true);
    });
  });

  describe('its own wait', () => {
    const runWait = async (c: Awaited<ReturnType<typeof company>>) => {
      const [run] = await c.db.select().from(testRuns);
      return (await c.db.select().from(taskWaits).where(eq(taskWaits.sourceKey, `run:${run!.id}`)))[0]!;
    };
    const policy = async (c: Awaited<ReturnType<typeof company>>, stage: string, ownerMs: number) => {
      const [ceo] = await c.db.select(idOnly(people)).from(people).where(eq(people.isOwner, true));
      await c.db.insert(waitPolicies).values({
        companyId: c.task.companyId, departmentId: c.dev.id, kind: 'run', stage, version: 1, ownerMs, headMs: 2 * ownerMs, decisionMs: 3 * ownerMs, reviewIntervalMs: 4 * ownerMs, createdByPersonId: ceo!.id,
      });
    };

    it.each(RUN_TOOLS)('$tool keeps who started it and makes up no date with no policy, not even from its limit', async run => {
      const c = await company();
      await c.machine(c.ceo, 'dev-mac');
      const t = await c.turn(c.bruno);
      await t.call(run.tool, { command: 'make check', ...run.args, minutes: 5 });
      await until(async () => (await runWait(c)).sourceState.stage === 'execution');
      expect(await runWait(c)).toMatchObject({ kind: 'run', state: 'legacy_needs_plan', ownerAgentId: c.bruno.id, plan: null, ownerDueAt: null, nextActionAt: null, level: 0 });
    });

    it('gives each stage its own clock from its policy, with the time counted from that stage', async () => {
      const c = await company();
      await policy(c, 'queue', 3_600_000);
      await policy(c, 'execution', 7_200_000);
      const t = await c.turn(c.bruno);
      const startedAt = Date.now();
      await t.call('run_tests', { branch: 'main', command: 'make check', minutes: 5 });
      const queued = await runWait(c);
      expect(queued).toMatchObject({ state: 'active', generation: 1, ownerAgentId: c.bruno.id, sourceState: { stage: 'queue' } });
      expect(queued.ownerDueAt!.getTime()).toBeGreaterThanOrEqual(startedAt + 3_600_000);
      expect(queued.plan!.provenance).toMatchObject({ kind: 'department_policy', origin: 'run:queue', revision: 1 });
      await c.machine(c.ceo, 'dev-mac');
      await pumpTests(c.app.ctx);
      await until(async () => (await runWait(c)).sourceState.stage === 'execution');
      const running = await runWait(c);
      expect(running).toMatchObject({ id: queued.id, generation: 2, sourceRevision: 1 });
      expect(running.ownerDueAt!.getTime()).toBeGreaterThanOrEqual(startedAt + 7_200_000);
      expect(running.plan!.provenance.origin).toBe('run:execution');
      expect(running.createdAt).toEqual(queued.createdAt);
    });

    it('goes to its retry clock when a machine loses a part, and back to executing', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac');
      await policy(c, 'queue', 3_600_000);
      await policy(c, 'retry', 60_000);
      const t = await c.turn(c.bruno);
      await t.call('run_tests', { branch: 'main', command: 'make check' });
      await nextOf(ivan.node, 'tests.run');
      await until(async () => (await runWait(c)).sourceState.stage === 'execution');
      expect(await runWait(c)).toMatchObject({ state: 'active', generation: 1 });
      expect((await runWait(c)).plan?.provenance.origin).toBe('run:queue');
      ivan.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
      await nextOf(ivan.node, 'tests.run');
      await until(async () => (await runWait(c)).sourceState.stage === 'execution');
      expect((await runWait(c)).plan?.provenance.origin).toBe('run:retry');
      expect(await runWait(c)).toMatchObject({ state: 'active', generation: 2 });
    });

    it('stands at the host slot while a machine that can take it has no room, on a clock of its own', async () => {
      const c = await company();
      await policy(c, 'queue', 3_600_000);
      await policy(c, 'host_slot', 60_000);
      const one = await c.planless(c.ceo, 'container-one');
      const other = await c.planless(c.ceo, 'container-two');
      reportHost(c, one.nodeId, 'linux', { hostMemFree: 4 * GIB });
      reportHost(c, other.nodeId, 'linux', { hostMemFree: 4 * GIB });
      const { call } = await c.turn(c.bruno);
      await call('run_tests', { branch: 'main', command: 'make one' });
      await nextOf(one.node, 'tests.run');
      expect((await call('run_tests', { branch: 'main', command: 'make two' })).text).toMatch(/Test run 2.*waits for a free machine/);
      const [two] = await c.db.select().from(testRuns).where(eq(testRuns.number, 2));
      const [wait] = await c.db.select().from(taskWaits).where(eq(taskWaits.sourceKey, `run:${two!.id}`));
      expect(wait).toMatchObject({ state: 'active', sourceState: { stage: 'host_slot' } });
      expect(wait!.plan!.provenance.origin).toBe('run:host_slot');
    });

    it.each([
      ['it passes', 'resolved', 'passed', {}],
      ['it fails', 'resolved', 'failed', { ok: false, exitCode: 1, error: 'failed', log: 'FAIL\n' }],
    ] as const)('ends once with its result when %s', async (_name, state, status, over) => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac');
      await (await c.turn(c.bruno)).call('run_tests', { branch: 'main', command: 'make check' });
      ivan.node.send(done(await nextOf(ivan.node, 'tests.run'), over));
      await nextOf(ivan.node, 'tests.ack');
      await until(async () => (await runWait(c)).endedAt !== null);
      const [run] = await c.db.select().from(testRuns);
      expect(await runWait(c)).toMatchObject({ state, proofRef: `run:${run!.id}:${status}` });
    });

    it('is cancelled when the run is stopped', async () => {
      const c = await company();
      await c.machine(c.ceo, 'dev-mac');
      const t = await c.turn(c.bruno);
      await t.call('run_tests', { branch: 'main', command: 'make check' });
      await t.call('stop_tests', { run: 1 });
      const [run] = await c.db.select().from(testRuns);
      expect(await runWait(c)).toMatchObject({ state: 'cancelled', proofRef: `run:${run!.id}:stopped` });
    });

    it('ends with its task closed meanwhile, and the run ending later changes nothing', async () => {
      const c = await company();
      const ivan = await c.machine(c.ceo, 'dev-mac');
      await (await c.turn(c.bruno)).call('run_tests', { branch: 'main', command: 'make check' });
      const part = await nextOf(ivan.node, 'tests.run');
      expect((await (await c.turn(c.head, null)).call('cancel_task', { task: c.task.number, why: 'Not needed.' })).error).toBe(false);
      const ended = await runWait(c);
      expect(ended).toMatchObject({ state: 'cancelled', proofRef: `task:${c.task.id}:cancelled` });
      ivan.node.send(done(part));
      await nextOf(ivan.node, 'tests.ack');
      await until(async () => (await c.db.select().from(testRuns))[0]!.status === 'passed');
      expect(await runWait(c)).toEqual(ended);
    });

    it('is refused with its run where the department set dates and none for where a run starts', async () => {
      const c = await company();
      await policy(c, 'execution', 3_600_000);
      const started = await (await c.turn(c.bruno)).call('run_tests', { branch: 'main', command: 'make check' });
      expect(started.error).toBe(true);
      expect(started.text).toContain('sets dates for its waits');
      expect(await c.db.select().from(testRuns)).toEqual([]);
      expect(await c.db.select().from(taskWaits).where(eq(taskWaits.kind, 'run'))).toEqual([]);
    });

    it('stays with no plan when no head is there to review it', async () => {
      const c = await company();
      await policy(c, 'queue', 3_600_000);
      await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.head.id));
      const started = await (await c.turn(c.bruno)).call('run_tests', { branch: 'main', command: 'make check' });
      expect(started.error).toBe(false);
      expect(await runWait(c)).toMatchObject({ state: 'legacy_needs_plan' });
    });
  });

  it.each(RUN_TOOLS)("leaves another holder's wait alone when $tool ends and still tells its starter", async run => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const head = await c.turn(c.head, c.task.id);
    expect((await head.call(run.tool, { command: 'make check', ...run.args })).error).toBe(false);
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, head.job.id));
    const bruno = await c.turn(c.bruno);
    expect((await bruno.call('wait_for', { task: c.task.number, reason: 'A deployment', until: anHour() })).error).toBe(false);
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, bruno.job.id));

    const before = await taskRow(c);
    ivan.node.send(done(await nextOf(ivan.node, 'tests.run')));
    await until(async () => (await toldOf(c, c.head.id, c.task.id)).turns.length > 0);

    expect((await toldOf(c, c.head.id, c.task.id)).prompts).toEqual([expect.stringMatching(new RegExp(`${run.name} 1 (passed|is done)`))]);
    expect(await taskRow(c)).toMatchObject({ externalWait: { reason: 'A deployment' }, version: before.version });
    expect((await toldOf(c, c.bruno.id, c.task.id)).turns).toEqual([]);
  });

  it.each(RUN_TOOLS)('refuses a wait while the result of $tool waits for the agent in a turn', async run => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
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

it.each(RUN_TOOLS)('rejects a stale wait after unread check when $tool commits its result before the wait write', async run => {
  const c = await company(), machine = await c.machine(c.ceo, 'wait-race');
  const turn = await c.turn(c.bruno);
  expect((await turn.call(run.tool, { command: 'make check', ...run.args })).error).toBe(false);
  const part = await nextOf(machine.node, 'tests.run');
  const [stored] = await c.db.select().from(testParts).where(eq(testParts.id, part.partId));
  const checked = waitRaceBarrier(), resume = waitRaceBarrier(), original = waitNotices.requestedWaitNotice;
  // This production boundary runs after unreadMessage=false and before move starts its transaction.
  const paused = vi.spyOn(waitNotices, 'requestedWaitNotice').mockImplementation(async (...args) => {
    const notice = await original(...args);
    if (args[1].id === c.task.id) { checked.resolve(); await resume.promise; }
    return notice;
  });
  onTestFinished(() => { resume.resolve(); paused.mockRestore(); });
  const deadline = anHour();
  const waiting = waitFor(c.app.ctx, c.bruno.id, c.task.id, { reason: 'The run result', until: deadline }).then(
    () => ({ accepted: true, reason: null }),
    (error: unknown) => ({ accepted: false, reason: error instanceof ApiError ? error.reason : 'unexpected' }),
  );
  await checked.promise;
  expect((await taskRow(c)).externalWait).toBeNull();
  machine.node.send(done(part));
  await until(async () => (await c.db.select().from(testRuns).where(eq(testRuns.id, stored.runId)))[0]!.status === 'passed');
  expect((await taskRow(c)).externalWait).toBeNull();
  expect((await c.db.select().from(pendingWakes).where(and(eq(pendingWakes.taskId, c.task.id), eq(pendingWakes.why, run.why))))).toHaveLength(1);
  resume.resolve(); const outcome = await waiting;
  await nextOf(machine.node, 'tests.ack');
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, turn.job.id));
  const before = await taskRow(c), told = await toldOf(c, c.bruno.id, c.task.id);
  const expired = await checkExternalWaits(c.app.ctx, new Date(new Date(deadline).getTime() + 1));
  const after = await toldOf(c, c.bruno.id, c.task.id);
  expect({ ...outcome, externalWait: before.externalWait, results: told.news, expired, resultsAfter: after.news }).toEqual({ accepted: false, reason: 'task_changed', externalWait: null, results: 1, expired: 0, resultsAfter: 1 });
});
