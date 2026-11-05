import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { departments, jobs, tasks, testParts } from '../src/db/schema.js';
import { afterJob } from '../src/modules/tasks/wake.js';
import { checkTestTimes } from '../src/modules/testruns/runs.js';
import { as, connectNode, TEST_COMMIT, until } from './helpers.js';
import { company, done, gets, GIB, idle, nextOf } from './test-runs-company.js';

describe('a test run', () => {
  it('runs on a machine that joined without a plan, as on any machine of the company', async () => {
    const c = await company();
    const box = await c.planless(c.ceo, 'build-box');
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'npm test' })).error).toBe(false);
    const run = await nextOf(box.node, 'tests.run');
    expect(run).toMatchObject({ command: 'npm test', part: 1, parts: 1 });
    expect((await c.db.select().from(testParts))[0]).toMatchObject({ status: 'running', nodeId: box.nodeId, machineId: box.machineId, machineName: 'build-box' });
    box.node.send(done(run));
    await nextOf(box.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/part 1 of 1 passed on build-box|passed on build-box/i);
  });

  it('splits into parts across the freest machines, puts each log on the task and wakes the agent with the result', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    const started = await call('run_tests', { command: 'npm test -- --shard={part}/{parts}', parts: 2 });
    expect(started.error).toBe(false);
    expect(started.text).toContain('Test run 1');
    const first = await nextOf(ann.node, 'tests.run');
    const second = await nextOf(ivan.node, 'tests.run');
    expect(first).toMatchObject({ repo: { url: 'https://github.com/acme/shop.git', token: 'ghp_shop0123456789' }, branch: `task-${c.task.number}`, commitSha: TEST_COMMIT, task: c.task.number, command: 'npm test -- --shard=1/2', part: 1, parts: 2, timeoutMs: 30 * 60_000 });
    expect(second).toMatchObject({ command: 'npm test -- --shard=2/2', part: 2, parts: 2 });
    ann.node.send({ type: 'tests.started', partId: first.partId });
    ann.node.send(done(first, { log: 'ok 12 tests\n' }));
    expect(await nextOf(ann.node, 'tests.ack')).toEqual({ type: 'tests.ack', partId: first.partId });
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    ivan.node.send(done(second, { ok: false, exitCode: 1, error: 'failed', log: `${lines}\nFAIL cart.test.ts: expected 2, got 3\n` }));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toContain('Test run 1 failed');
    expect(prompt).toMatch(/part 1 of 2 passed on ann-pc/i);
    expect(prompt).toMatch(/part 2 of 2 failed on ivan-mac/i);
    expect(prompt).toContain('> FAIL cart.test.ts: expected 2, got 3');
    expect(prompt).not.toContain('line 1\n');
    expect(prompt).toContain('tests-1-2.log');
    expect(await c.filesOn()).toEqual([
      { name: 'tests-1-1.log', text: 'ok 12 tests\n' },
      { name: 'tests-1-2.log', text: `${lines}\nFAIL cart.test.ts: expected 2, got 3\n` },
    ]);
    const state = JSON.parse((await call('test_run', { run: 1 })).text);
    expect(state).toMatchObject({ run: 1, task: c.task.number, status: 'failed', parts: [{ part: 1, status: 'passed', machine: 'ann-pc', log: 'tests-1-1.log' }, { part: 2, status: 'failed', machine: 'ivan-mac', exitCode: 1 }] });
  });

  it('runs one part at a time on a machine, and a part that finds none free waits for the first that frees up', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test', branch: 'task-1-checkout' });
    const one = await nextOf(ivan.node, 'tests.run');
    expect(one.branch).toBe('task-1-checkout');
    const waits = await call('run_tests', { command: 'make test', branch: 'task-1-checkout' });
    expect(waits.text).toMatch(/waits for a free machine/);
    expect(JSON.parse((await call('test_run', { run: 2 })).text)).toMatchObject({ status: 'running', parts: [{ part: 1, status: 'queued', machine: null }] });
    expect(await gets(ivan.node, 'tests.run')).toBe(false);
    ivan.node.send(done(one));
    const two = await nextOf(ivan.node, 'tests.run');
    expect(two.partId).not.toBe(one.partId);
  });

  it('waits while no machine has the free memory its repository needs', async () => {
    const c = await company();
    await c.db.update(departments).set({ repoTestMemoryGb: 8 }).where(eq(departments.id, c.dev.id));
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ memFree: 6 * GIB }));
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'make test' })).text).toMatch(/waits for a free machine/);
    expect(await gets(ivan.node, 'tests.run')).toBe(false);
    ivan.node.send({ type: 'load', ...idle({ memFree: 9 * GIB }) });
    expect((await nextOf(ivan.node, 'tests.run')).command).toBe('make test');
  });

  it('gives no new part to a loaded machine, and gives it one once its load drops', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 7.6 }));
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'make test' })).text).toMatch(/waits for a free machine/);
    expect(await gets(ivan.node, 'tests.run')).toBe(false);
    ivan.node.send({ type: 'load', ...idle({ load: 2 }) });
    expect((await nextOf(ivan.node, 'tests.run')).command).toBe('make test');
  });

  it('leaves out a machine its owner took back, and one whose owner does not reach the repository', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 7 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const bob = await c.machine(c.bob, 'bob-pc');
    expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${ann.machineId}`, payload: { lendsTests: false }, ...as(c.ann) })).statusCode).toBe(200);
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 3 });
    expect((await nextOf(ivan.node, 'tests.run')).part).toBe(1);
    expect(await gets(ann.node, 'tests.run')).toBe(false);
    expect(await gets(bob.node, 'tests.run')).toBe(false);
    expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${ann.machineId}`, payload: { lendsTests: true }, ...as(c.ann) })).statusCode).toBe(200);
    expect((await nextOf(ann.node, 'tests.run')).part).toBe(2);
  });

  it('fails a part that runs past its time, and tells its node to stop it', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test', minutes: 5 });
    const run = await nextOf(ivan.node, 'tests.run');
    expect(run.timeoutMs).toBe(5 * 60_000);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 4 * 60_000));
    expect(await gets(ivan.node, 'tests.cancel')).toBe(false);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 15 * 60_000));
    expect(await nextOf(ivan.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: run.partId });
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 failed[\s\S]*did not end within 5 min/);
  });

  it('stops on stop_tests: its parts end, their nodes stop them, and nobody is woken', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 2 });
    const run = await nextOf(ivan.node, 'tests.run');
    const stopped = await call('stop_tests', { run: 1 });
    expect(stopped).toEqual({ text: 'Test run 1 is stopped.', error: false });
    expect(await nextOf(ivan.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: run.partId });
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'stopped', parts: [{ status: 'stopped' }, { status: 'stopped' }] });
    ivan.node.send(done(run, { ok: false, error: 'cancelled', exitCode: null, log: 'Stopped.\n' }));
    await nextOf(ivan.node, 'tests.ack');
    expect(await c.filesOn()).toEqual([{ name: 'tests-1-1.log', text: 'Stopped.\n' }]);
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    expect((await call('stop_tests', { run: 1 })).error).toBe(true);
    /* Sales sees nothing of development's runs. */
    expect((await (await c.turn(c.sam, null)).call('stop_tests', { run: 1 })).text).toMatch(/no test run 1/i);
  });

  it('wakes its agent when another one stopped it', async () => {
    const c = await company();
    await c.machine(c.ceo, 'ivan-mac');
    await (await c.turn(c.bruno)).call('run_tests', { command: 'make test' });
    expect((await (await c.turn(c.head, null)).call('stop_tests', { run: 1 })).error).toBe(false);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 was stopped by Hana/);
  });

  it('runs a lost part again on the machine that lost it when no other machine could ever fit it', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    await c.machine(c.ann, 'ann-pc', idle({ memFree: 1 * GIB, memTotal: 1 * GIB }));
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const lost = await nextOf(ivan.node, 'tests.run');
    ivan.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    const again = await nextOf(ivan.node, 'tests.run');
    expect(again).toMatchObject({ part: 1, command: 'make test' });
    expect(again.partId).not.toBe(lost.partId);
  });

  it('runs a part its machine lost in a restart again on another machine, under a new id, and says so', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const lost = await nextOf(ann.node, 'tests.run');
    ann.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    const again = await nextOf(ivan.node, 'tests.run');
    expect(again).toMatchObject({ part: 1, command: 'make test' });
    expect(again.partId).not.toBe(lost.partId);
    expect(await gets(ann.node, 'tests.run')).toBe(false);
    /* The lost run's end, should it still come, changes nothing, and its node hears to stop it. */
    ann.node.send(done(lost, { ok: false, exitCode: 1, error: 'failed' }));
    await nextOf(ann.node, 'tests.ack');
    ann.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [lost.partId] });
    expect(await nextOf(ann.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: lost.partId });
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    ivan.node.send(done(again));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 passed[\s\S]*Part 1 of 1 passed on ivan-mac[^\n]*It ran again after ann-pc restarted and lost it\./);
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ parts: [{ status: 'passed', machine: 'ivan-mac', ranAgain: ['ann-pc restarted and lost it'] }] });
  });

  it('keeps a part through a 60-second disconnect and accepts its result after return', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { job, call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const started = await nextOf(ivan.node, 'tests.run');
    ivan.node.close();
    await until(() => !c.app.ctx.hub.isOnline({ kind: 'node', nodeId: ivan.nodeId }));

    await checkTestTimes(c.app.ctx, new Date(Date.now() + 60_000));
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'running', parts: [{ status: 'running' }] });

    const back = await connectNode(c.url, ivan.key);
    back.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [job.id], load: idle(), tests: [started.partId], work: true });
    await until(() => c.app.ctx.hub.isReady({ kind: 'node', nodeId: ivan.nodeId }));
    back.send(done(started));
    await nextOf(back, 'tests.ack');

    const result = JSON.parse((await call('test_run', { run: 1 })).text);
    expect(result).toMatchObject({ status: 'passed', parts: [{ status: 'passed' }] });
    expect(result.parts[0].ranAgain).toBeUndefined();
    expect(await gets(back, 'tests.cancel')).toBe(false);
  });

  it('runs a part again once its machine is away for 3 minutes, at most twice, then fails it and says where it was lost', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    await nextOf(ivan.node, 'tests.run');
    ivan.node.close();
    await until(() => !c.app.ctx.hub.isOnline({ kind: 'node', nodeId: ivan.nodeId }));
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 60_000));
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ parts: [{ status: 'running' }] });
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 4 * 60_000));
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'running', parts: [{ status: 'queued', ranAgain: ['ivan-mac went offline'] }] });
    /* The only machine there is takes it again once it is back. */
    const back = await c.reconnect(ivan);
    await nextOf(back, 'tests.run');
    back.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    await nextOf(back, 'tests.run');
    back.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(
      /Test run 1 failed[\s\S]*Part 1 of 1 failed on ivan-mac[^:\n]*: its machine restarted and lost it\. It ran again after ivan-mac went offline, and again after ivan-mac restarted and lost it\./,
    );
    expect(await gets(back, 'tests.run')).toBe(false);
  });

  it("does not count a turn that ended while its test run goes on as standing still", async () => {
    const c = await company();
    await c.machine(c.ceo, 'ivan-mac');
    const { job, call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, job.id));
    await afterJob(c.app.ctx, job.id);
    expect((await c.db.select({ silent: tasks.silent }).from(tasks).where(eq(tasks.id, c.task.id)))[0]).toEqual({ silent: 0 });
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
  });

  it('goes to the built-in node too, which reaches every repository', async () => {
    const c = await company();
    const node = await c.builtin();
    await (await c.turn(c.bruno)).call('run_tests', { command: 'make test' });
    const run = await nextOf(node, 'tests.run');
    node.send(done(run));
    await nextOf(node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 passed[\s\S]*Part 1 of 1 passed on the built-in node/);
  });

  it('ends a part that found no free machine within 2 hours', async () => {
    const c = await company();
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'make test' })).text).toMatch(/No machine that may take it is online now/);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 60 * 60_000));
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 3 * 60 * 60_000));
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 failed[\s\S]*no machine was free for it within 120 min/);
  });

  it('runs the parts of a machine disconnected from the company, and of a removed plan, again on another machine', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const ann = await c.machine(c.ann, 'ann-pc');
    const spare = await c.planless(c.ceo, 'spare-box', idle({ load: 7 }));
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 2 });
    const first = await nextOf(ivan.node, 'tests.run');
    await nextOf(ann.node, 'tests.run');
    expect((await c.app.inject({ method: 'POST', url: `/api/machines/${ivan.machineId}/disconnect`, ...as(c.ceo) })).statusCode).toBe(204);
    const one = await nextOf(spare.node, 'tests.run');
    expect(one).toMatchObject({ part: 1 });
    expect(one.partId).not.toBe(first.partId);
    expect((await c.app.inject({ method: 'DELETE', url: `/api/subscriptions/${ann.subscriptionId}`, ...as(c.ann) })).statusCode).toBe(204);
    /* One part at a time on a machine: the second waits for the first to end there. */
    expect(await gets(spare.node, 'tests.run')).toBe(false);
    spare.node.send(done(one));
    const two = await nextOf(spare.node, 'tests.run');
    expect(two).toMatchObject({ part: 2 });
    spare.node.send(done(two));
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toMatch(/Test run 1 passed/);
    expect(prompt).toMatch(/Part 1 of 2 passed on spare-box[^\n]*It ran again after ivan-mac was disconnected from the company\./);
    expect(prompt).toMatch(/Part 2 of 2 passed on spare-box[^\n]*It ran again after ann-pc lost the plan its node ran for\./);
  });

  it('brings its result into the turn that already waits on the task', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { job, call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const run = await nextOf(ivan.node, 'tests.run');
    await c.db.insert(jobs).values({ companyId: job.companyId, subscriptionId: job.subscriptionId, agentId: c.bruno.id, taskId: c.task.id, kind: 'conversation', prompt: 'Rita sent it back.', timeoutMs: 900000 });
    ivan.node.send(done(run));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => /Test run 1 passed/.test((await c.wokeWith(c.bruno.id)) ?? ''));
    expect(await c.wokeWith(c.bruno.id)).toMatch(/^Rita sent it back\.\n\nThe tests you ran on #1/);
    expect((await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.bruno.id), eq(jobs.status, 'queued')))).length).toBe(1);
  });

  it('is refused without a repository, without {part} in a split command, past 3 open runs, and without a task', async () => {
    const c = await company();
    const { call } = await c.turn(c.bruno);
    expect(await call('run_tests', { command: 'make test', parts: 2 })).toMatchObject({ error: true, text: expect.stringContaining('{part}') });
    for (let i = 0; i < 3; i++) expect((await call('run_tests', { command: 'make test' })).error).toBe(false);
    expect(await call('run_tests', { command: 'make test' })).toMatchObject({ error: true, text: expect.stringContaining('3') });
    expect((await (await c.turn(c.sam, null)).call('run_tests', { command: 'make test' })).text).toMatch(/task/);
    const [own] = await c.db.insert(tasks).values({ companyId: c.task.companyId, number: 99, title: 'Pitch', brief: '', body: '', departmentId: c.sales.id, assigneeAgentId: c.sam.id, status: 'working' }).returning();
    expect((await (await c.turn(c.sam, own!.id)).call('run_tests', { command: 'make test' })).text).toMatch(/repository/);
  });
});
