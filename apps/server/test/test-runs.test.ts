import { createHmac } from 'node:crypto';
import type { ServerMessage } from '@hornhoof/protocol';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { agentEvents, departments, jobs, machines, nodes, pendingWakes, people, personAccess, tasks, testParts, testRuns } from '../src/db/schema.js';
import { createRoute, routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { afterJob } from '../src/modules/tasks/wake.js';
import { builtinOf, nodeIdentity } from '../src/modules/nodes/hub.js';
import { hostIdOf } from '../src/modules/network/join.js';
import { checkTestTimes, placesOf, pumpTests } from '../src/modules/testruns/runs.js';
import { as, connectNode, TEST_COMMIT, until, type FakeNode } from './helpers.js';
import { company, done, gets, GIB, idle, nextOf, NODE_KEY } from './test-runs-company.js';
import { BUILTIN } from './builtin.js';

type TestsRun = Extract<ServerMessage, { type: 'tests.run' }>;

describe('a test run', () => {
  it('runs on a machine that joined without a plan, as on any machine of the company', async () => {
    const c = await company();
    const box = await c.planless(c.ceo, 'build-box');
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { branch: 'main', command: 'npm test' })).error).toBe(false);
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
    const ivan = await c.machine(c.ceo, 'dev-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    const started = await call('run_tests', { branch: 'main', command: 'npm test -- --shard={part}/{parts}', parts: 2 });
    expect(started.error).toBe(false);
    expect(started.text).toContain('Test run 1');
    const first = await nextOf(ann.node, 'tests.run');
    const second = await nextOf(ivan.node, 'tests.run');
    expect(first).toMatchObject({ repo: { url: 'https://github.com/acme/shop.git', token: 'ghp_shop0123456789' }, branch: 'main', commitSha: TEST_COMMIT, task: c.task.number, command: 'npm test -- --shard=1/2', part: 1, parts: 2, timeoutMs: 30 * 60_000 });
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
    expect(prompt).toMatch(/part 2 of 2 failed on dev-mac/i);
    expect(prompt).toContain('> FAIL cart.test.ts: expected 2, got 3');
    expect(prompt).not.toContain('line 1\n');
    expect(prompt).toContain('tests-1-2.log');
    expect(await c.filesOn()).toEqual([
      { name: 'tests-1-1.log', text: 'ok 12 tests\n' },
      { name: 'tests-1-2.log', text: `${lines}\nFAIL cart.test.ts: expected 2, got 3\n` },
    ]);
    const state = JSON.parse((await call('test_run', { run: 1 })).text);
    expect(state).toMatchObject({ run: 1, task: c.task.number, status: 'failed', parts: [{ part: 1, status: 'passed', machine: 'ann-pc', log: 'tests-1-1.log' }, { part: 2, status: 'failed', machine: 'dev-mac', exitCode: 1 }] });
  });

  it('runs one part at a time on a machine, and a part that finds none free waits for the first that frees up', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test', branch: 'release-checkout' });
    const one = await nextOf(ivan.node, 'tests.run');
    expect(one.branch).toBe('release-checkout');
    const waits = await call('run_tests', { command: 'make test', branch: 'release-checkout' });
    expect(waits.text).toMatch(/waits for a free machine/);
    expect(JSON.parse((await call('test_run', { run: 2 })).text)).toMatchObject({ status: 'running', parts: [{ part: 1, status: 'queued', machine: null }] });
    expect(await gets(c.app.ctx, ivan.node, 'tests.run')).toBe(false);
    ivan.node.send(done(one));
    const two = await nextOf(ivan.node, 'tests.run');
    expect(two.partId).not.toBe(one.partId);
  });

  it('waits while no machine has the free memory its repository needs', async () => {
    const c = await company();
    await c.db.update(departments).set({ repoTestMemoryGb: 8 }).where(eq(departments.id, c.dev.id));
    const ivan = await c.machine(c.ceo, 'dev-mac', idle({ memFree: 6 * GIB }));
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { branch: 'main', command: 'make test' })).text).toMatch(/waits for a free machine/);
    expect(await gets(c.app.ctx, ivan.node, 'tests.run')).toBe(false);
    ivan.node.send({ type: 'load', ...idle({ memFree: 9 * GIB }) });
    expect((await nextOf(ivan.node, 'tests.run')).command).toBe('make test');
  });

  it('gives no new part to a loaded machine, and gives it one once its load drops', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac', idle({ load: 7.6 }));
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { branch: 'main', command: 'make test' })).text).toMatch(/waits for a free machine/);
    expect(await gets(c.app.ctx, ivan.node, 'tests.run')).toBe(false);
    ivan.node.send({ type: 'load', ...idle({ load: 2 }) });
    expect((await nextOf(ivan.node, 'tests.run')).command).toBe('make test');
  });

  it('leaves out a machine its owner took back, and one whose owner does not reach the repository', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac', idle({ load: 7 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const bob = await c.machine(c.bob, 'bob-pc');
    expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${ann.machineId}`, payload: { lendsTests: false }, ...as(c.ann) })).statusCode).toBe(200);
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test -- {part}', parts: 3 });
    expect((await nextOf(ivan.node, 'tests.run')).part).toBe(1);
    expect(await gets(c.app.ctx, ann.node, 'tests.run')).toBe(false);
    expect(await gets(c.app.ctx, bob.node, 'tests.run')).toBe(false);
    expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${ann.machineId}`, payload: { lendsTests: true }, ...as(c.ann) })).statusCode).toBe(200);
    expect((await nextOf(ann.node, 'tests.run')).part).toBe(2);
  });

  it('fails a part that runs past its time, and tells its node to stop it', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test', minutes: 5 });
    const run = await nextOf(ivan.node, 'tests.run');
    expect(run.timeoutMs).toBe(5 * 60_000);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 4 * 60_000));
    expect(await gets(c.app.ctx, ivan.node, 'tests.cancel')).toBe(false);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 15 * 60_000));
    expect(await nextOf(ivan.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: run.partId });
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 failed[\s\S]*did not end within 5 min/);
  });

  it('keeps a machine-queued part out of execution timeout until tests.started', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'queued-machine');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test', minutes: 1 });
    const run = await nextOf(ivan.node, 'tests.run');
    ivan.node.send({ type: 'tests.waiting', partId: run.partId, position: 2 });
    await until(async () => (await c.db.select().from(testParts).where(eq(testParts.id, run.partId)))[0]?.startedAt === null);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 15 * 60_000));
    const [waiting] = await c.db.select().from(testParts).where(eq(testParts.id, run.partId));
    expect(waiting).toMatchObject({ status: 'running', startedAt: null });
    expect(waiting!.tail).toContain('2');
    const visible = JSON.parse((await call('test_run', { run: 1 })).text) as { parts: { queuePosition?: number }[] };
    expect(visible.parts[0]!.queuePosition).toBe(2);
    ivan.node.send({ type: 'tests.started', partId: run.partId });
    await until(async () => (await c.db.select().from(testParts).where(eq(testParts.id, run.partId)))[0]?.startedAt !== null);
    expect((await c.db.select().from(testParts).where(eq(testParts.id, run.partId)))[0]!.tail).toBe('');
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 15 * 60_000));
    expect(await nextOf(ivan.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: run.partId });
  });

  it('stops on stop_tests: its parts end, their nodes stop them, and nobody is woken', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test -- {part}', parts: 2 });
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
    await c.machine(c.ceo, 'dev-mac');
    await (await c.turn(c.bruno)).call('run_tests', { branch: 'main', command: 'make test' });
    expect((await (await c.turn(c.head, null)).call('stop_tests', { run: 1 })).error).toBe(false);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 was stopped by Hana/);
  });

  it('runs a lost part again on the machine that lost it when no other machine could ever fit it', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    await c.machine(c.ann, 'ann-pc', idle({ memFree: 1 * GIB, memTotal: 1 * GIB }));
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    const lost = await nextOf(ivan.node, 'tests.run');
    ivan.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    const again = await nextOf(ivan.node, 'tests.run');
    expect(again).toMatchObject({ part: 1, command: 'make test' });
    expect(again.partId).not.toBe(lost.partId);
  });

  it('runs a part its machine lost in a restart again on another machine, under a new id, and says so', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    const lost = await nextOf(ann.node, 'tests.run');
    ann.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    const again = await nextOf(ivan.node, 'tests.run');
    expect(again).toMatchObject({ part: 1, command: 'make test' });
    expect(again.partId).not.toBe(lost.partId);
    expect(await gets(c.app.ctx, ann.node, 'tests.run')).toBe(false);
    /* The lost run's end, should it still come, changes nothing, and its node hears to stop it. */
    ann.node.send(done(lost, { ok: false, exitCode: 1, error: 'failed' }));
    await nextOf(ann.node, 'tests.ack');
    ann.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [lost.partId] });
    expect(await nextOf(ann.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: lost.partId });
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    ivan.node.send(done(again));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 passed[\s\S]*Part 1 of 1 passed on dev-mac[^\n]*It ran again after ann-pc restarted and lost it\./);
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ parts: [{ status: 'passed', machine: 'dev-mac', ranAgain: ['ann-pc restarted and lost it'] }] });
  });

  it('keeps a part through a 60-second disconnect and accepts its result after return', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { job, call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
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
    expect(await gets(c.app.ctx, back, 'tests.cancel')).toBe(false);
  });

  it('runs a part again once its machine is away for 3 minutes, at most twice, then fails it and says where it was lost', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    await nextOf(ivan.node, 'tests.run');
    ivan.node.close();
    await until(() => !c.app.ctx.hub.isOnline({ kind: 'node', nodeId: ivan.nodeId }));
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 60_000));
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ parts: [{ status: 'running' }] });
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 4 * 60_000));
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'running', parts: [{ status: 'queued', ranAgain: ['dev-mac went offline'] }] });
    /* The only machine there is takes it again once it is back. */
    const back = await c.reconnect(ivan);
    await nextOf(back, 'tests.run');
    back.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    await nextOf(back, 'tests.run');
    back.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(
      /Test run 1 failed[\s\S]*Part 1 of 1 failed on dev-mac[^:\n]*: its machine restarted and lost it\. It ran again after dev-mac went offline, and again after dev-mac restarted and lost it\./,
    );
    expect(await gets(c.app.ctx, back, 'tests.run')).toBe(false);
  });

  /* #1060: a machine away past its lease keeps nothing of its part once the part runs on another machine. What it sends
     back for it, should it come back with the part still running, counts for nothing, and it hears to stop it. */
  it('takes no end from the machine that was away once its part runs on another machine, and tells it to stop', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    const lost = await nextOf(ann.node, 'tests.run');
    ann.node.close();
    await until(() => !c.app.ctx.hub.isOnline({ kind: 'node', nodeId: ann.nodeId }));
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 4 * 60_000));
    const again = await nextOf(ivan.node, 'tests.run');
    expect(again).toMatchObject({ part: 1, command: 'make test' });
    expect(again.partId).not.toBe(lost.partId);
    const back = await connectNode(c.url, ann.key);
    back.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], load: idle(), tests: [lost.partId], work: true });
    expect(await nextOf(back, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: lost.partId });
    back.send(done(lost));
    await nextOf(back, 'tests.ack');
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'running', parts: [{ status: 'running' }] });
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    ivan.node.send(done(again, { ok: false, exitCode: 1, error: 'failed' }));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 failed[\s\S]*Part 1 of 1 failed on dev-mac[^\n]*It ran again after ann-pc went offline\./);
  });

  it("does not count a turn that ended while its test run goes on as standing still", async () => {
    const c = await company();
    await c.machine(c.ceo, 'dev-mac');
    const { job, call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, job.id));
    await afterJob(c.app.ctx, job.id);
    expect((await c.db.select({ silent: tasks.silent }).from(tasks).where(eq(tasks.id, c.task.id)))[0]).toEqual({ silent: 0 });
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
  });

  it('goes to the built-in node too, which reaches every repository', async () => {
    const c = await company();
    const node = await c.builtin();
    await (await c.turn(c.bruno)).call('run_tests', { branch: 'main', command: 'make test' });
    const run = await nextOf(node, 'tests.run');
    node.send(done(run));
    await nextOf(node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 passed[\s\S]*Part 1 of 1 passed on the built-in node/);
  });

  it('offers each built-in node as a place', async () => {
    const c = await company();
    const own = await c.builtin();
    /* Another machine of the company keeps a copy of its data, and its own built-in node is there too. */
    const MACHINE = 'c0'.repeat(16);
    const [row] = await c.db.select({ companyId: machines.companyId, personId: machines.personId }).from(machines).limit(1);
    const owner = row ?? { companyId: c.task.companyId, personId: (await c.db.select().from(people))[0]!.id };
    const [copy] = await c.db.insert(machines).values({ ...owner, machineKey: 'copy-box-0001', hostname: 'copy-box', role: 'data', networkId: MACHINE }).returning();
    const key = `builtin.${MACHINE}.${createHmac('sha256', NODE_KEY).update(`hornhoof builtin node ${MACHINE}`).digest('hex')}`;
    const other = await connectNode(c.url, key);
    other.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    await until(() => c.app.ctx.hub.loadOf(builtinOf(MACHINE)) !== null);
    const places = (await placesOf(c.app.ctx, c.task.companyId)).filter(place => place.builtin);
    expect(places.map(place => [place.key, place.name, place.builtinMachine === MACHINE, place.machineId])).toEqual([
      ['builtin', 'the built-in node', false, null],
      [`builtin:${MACHINE}`, 'the built-in node on copy-box', true, copy!.id],
    ]);
    /* With the server's own gone, a part goes to the other machine's, and is that node's alone. */
    own.close();
    await own.closed;
    await (await c.turn(c.bruno)).call('run_tests', { branch: 'main', command: 'make test' });
    const run = await nextOf(other, 'tests.run');
    const [part] = await c.db.select().from(testParts).where(eq(testParts.id, run.partId));
    expect(part).toMatchObject({ status: 'running', builtin: true, builtinMachine: MACHINE, machineId: copy!.id, machineName: 'the built-in node on copy-box' });
    /* The pool lists that node with its part, apart from the server's own. */
    const pool = (await c.app.inject({ url: '/api/pool', ...as(c.ceo) })).json() as { builtin: { parts: unknown[] }; builtins: { machine: string; name: string; online: boolean; parts: { part: number }[] }[] };
    expect(pool.builtin.parts).toEqual([]);
    expect(pool.builtins).toMatchObject([{ machine: MACHINE, name: 'the built-in node on copy-box', online: true, parts: [{ part: 1 }] }]);
    /* The server's own node, back with no part of its own, takes nothing from it. */
    const back = await c.builtin();
    back.send({ ...done(run), log: 'not mine' });
    other.send(done(run));
    await nextOf(other, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 passed[\s\S]*Part 1 of 1 passed on the built-in node on copy-box/);
  });

  /* A machine taken back from the company's runs lends none of its nodes, its built-in node with them; lent again, it
     takes parts as before. */
  it('gives no part to the built-in node of a machine its owner took back, and one again once it is lent', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const MACHINE = 'd0'.repeat(16);
    const [row] = await c.db.select({ companyId: machines.companyId, personId: machines.personId }).from(machines).limit(1);
    const [box] = await c.db.insert(machines).values({ ...row!, machineKey: 'mac-box-0001', hostname: 'mac-box', role: 'worker', networkId: MACHINE, lendsTests: false }).returning();
    const key = `builtin.${MACHINE}.${createHmac('sha256', NODE_KEY).update(`hornhoof builtin node ${MACHINE}`).digest('hex')}`;
    const builtin = await connectNode(c.url, key);
    builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    await until(() => c.app.ctx.hub.loadOf(builtinOf(MACHINE)) !== null);
    expect((await placesOf(c.app.ctx, c.task.companyId)).find(place => place.builtinMachine === MACHINE)).toMatchObject({ machineId: box!.id, lent: false });
    await (await c.turn(c.bruno)).call('run_tests', { branch: 'main', command: 'make test -- {part}', parts: 2 });
    expect((await nextOf(ivan.node, 'tests.run')).part).toBe(1);
    expect(await gets(c.app.ctx, builtin, 'tests.run')).toBe(false);
    expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${box!.id}`, payload: { lendsTests: true }, ...as(c.ceo) })).statusCode).toBe(200);
    expect((await nextOf(builtin, 'tests.run')).part).toBe(2);
  });

  /* The server's own built-in node runs on a computer of the company too; that computer taken back lends it no more. */
  it('gives no part to the server’s own built-in node when the computer it runs on is taken back', async () => {
    const c = await company({ HORNHOOF_HOST_ID: hostIdOf('home-box-0001-abcd') });
    const home = await c.machine(c.ceo, 'home-box');
    const ann = await c.machine(c.ann, 'ann-pc');
    expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${home.machineId}`, payload: { lendsTests: false }, ...as(c.ceo) })).statusCode).toBe(200);
    const own = await c.builtin();
    expect((await placesOf(c.app.ctx, c.task.companyId)).find(place => place.builtin)).toMatchObject({ key: 'builtin', lent: false });
    await (await c.turn(c.bruno)).call('run_tests', { branch: 'main', command: 'make test -- {part}', parts: 2 });
    expect((await nextOf(ann.node, 'tests.run')).part).toBe(1);
    expect(await gets(c.app.ctx, own, 'tests.run')).toBe(false);
    expect(await gets(c.app.ctx, home.node, 'tests.run')).toBe(false);
  });

  it('ends a part that found no free machine within 2 hours', async () => {
    const c = await company();
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { branch: 'main', command: 'make test' })).text).toMatch(/No machine that may take it is online now/);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 60 * 60_000));
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 3 * 60 * 60_000));
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 failed[\s\S]*no machine was free for it within 120 min/);
  });

  it('runs the parts of a machine disconnected from the company, and of a removed plan, again on another machine', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const ann = await c.machine(c.ann, 'ann-pc');
    const spare = await c.planless(c.ceo, 'spare-box', idle({ load: 7 }));
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test -- {part}', parts: 2 });
    const first = await nextOf(ivan.node, 'tests.run');
    await nextOf(ann.node, 'tests.run');
    expect((await c.app.inject({ method: 'POST', url: `/api/machines/${ivan.machineId}/disconnect`, ...as(c.ceo) })).statusCode).toBe(204);
    const one = await nextOf(spare.node, 'tests.run');
    expect(one).toMatchObject({ part: 1 });
    expect(one.partId).not.toBe(first.partId);
    expect((await c.app.inject({ method: 'DELETE', url: `/api/subscriptions/${ann.subscriptionId}`, ...as(c.ann) })).statusCode).toBe(204);
    /* One part at a time on a machine: the second waits for the first to end there. */
    expect(await gets(c.app.ctx, spare.node, 'tests.run')).toBe(false);
    spare.node.send(done(one));
    const two = await nextOf(spare.node, 'tests.run');
    expect(two).toMatchObject({ part: 2 });
    spare.node.send(done(two));
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toMatch(/Test run 1 passed/);
    expect(prompt).toMatch(/Part 1 of 2 passed on spare-box[^\n]*It ran again after dev-mac was disconnected from the company\./);
    expect(prompt).toMatch(/Part 2 of 2 passed on spare-box[^\n]*It ran again after ann-pc lost the plan its node ran for\./);
  });

  it('brings its result into the turn that already waits on the task', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { job, call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    const run = await nextOf(ivan.node, 'tests.run');
    const [task] = await c.db.select().from(tasks).where(eq(tasks.id, c.task.id));
    const taskWake = taskWakeOf(task!, { why: 'go_on' }, routeSnapshot(await routeOf(c.db, task!), task!.assigneeAgentId));
    const [waiting] = await c.db.insert(jobs).values({ companyId: job.companyId, subscriptionId: job.subscriptionId, agentId: c.bruno.id, taskId: c.task.id, kind: 'conversation', prompt: 'Rita sent it back.', timeoutMs: 900000 }).returning();
    await c.db.insert(agentEvents).values({ companyId: job.companyId, agentId: c.bruno.id, jobId: waiting!.id, kind: 'message', data: { text: 'Rita sent it back.', taskWake } });
    ivan.node.send(done(run));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => /Test run 1 passed/.test((await c.wokeWith(c.bruno.id)) ?? ''));
    expect(await c.wokeWith(c.bruno.id)).toMatch(/^Rita sent it back\.\n\nThe tests you ran on #1/);
    expect((await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.bruno.id), eq(jobs.status, 'queued')))).length).toBe(1);
  });

  it('is refused without a repository, without {part} in a split command, past 3 open runs, and without a task', async () => {
    const c = await company();
    const { call } = await c.turn(c.bruno);
    expect(await call('run_tests', { branch: 'main', command: 'make test', parts: 2 })).toMatchObject({ error: true, text: expect.stringContaining('{part}') });
    for (let i = 0; i < 3; i++) expect((await call('run_tests', { branch: 'main', command: 'make test' })).error).toBe(false);
    expect(await call('run_tests', { branch: 'main', command: 'make test' })).toMatchObject({ error: true, text: expect.stringContaining('3') });
    expect((await (await c.turn(c.sam, null)).call('run_tests', { branch: 'main', command: 'make test' })).text).toMatch(/task/);
    const [own] = await c.db.insert(tasks).values({ companyId: c.task.companyId, number: 99, title: 'Pitch', brief: '', body: '', departmentId: c.sales.id, assigneeAgentId: c.sam.id, status: 'working' }).returning();
    await c.db.transaction(tx => createRoute(tx, own!, {}, developmentStages()));
    expect((await (await c.turn(c.sam, own!.id)).call('run_tests', { branch: 'main', command: 'make test' })).text).toMatch(/repository/);
  });
});

async function productNode(c: Awaited<ReturnType<typeof company>>) {
  const node = await c.builtin();
  node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: [{ id: 'node', version: '22.15.0', fingerprint: 'b'.repeat(64) }] });
  const { testCapabilities } = await import('../src/modules/testruns/describe.js');
  await until(() => testCapabilities(c.app.ctx, BUILTIN).testEnvironmentVersion === 1);
  return node;
}

async function productDescription(request: Extract<ServerMessage, { type: 'tests.describe' }>, runtimeCapabilities: { id: string; version: string; fingerprint: string; platform?: { os: string; arch: string; libc: string } }[] = [{ id: 'node', version: '22.15.0', fingerprint: 'b'.repeat(64) }]) {
  const manifest = {
    version: 1 as const, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }], profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }],
    dependencies: { adapter: 'npm', inputs: ['package-lock.json'], install: [], paths: ['node_modules'], cache: 'copy' as const }, services: [], prepare: [], reset: null,
    suites: [{ id: 'unit', root: '.', files: ['test/*.ts'], run: { program: 'node', args: ['runner.js'], cwd: '.' }, split: { kind: 'argv-files' as const }, profiles: ['fast'], finalChecks: [{ program: 'node', args: ['final.js'], cwd: '.' }] }],
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported' as const, reason: 'Not applicable.' } }, mutation: { status: 'unsupported' as const, language: 'typescript', reason: 'Not configured.' },
  };
  const { hashTestEnvironment } = await import('@hornhoof/protocol');
  const manifestSource = JSON.stringify(manifest);
  return { type: 'tests.described' as const, requestId: request.requestId, commitSha: request.commitSha, result: { status: 'ready' as const, description: {
    version: 1 as const, repositoryScope: request.repositoryScope, commitSha: request.commitSha, manifestSource, manifestHash: await hashTestEnvironment(manifestSource), manifest,
    inputDigests: [{ path: 'package-lock.json', digest: 'c'.repeat(64) }], inventory: ['test/a.ts', 'test/b.ts'].map(file => ({ suiteId: 'unit', file, selectionUnit: file })), runtimeCapabilities,
  } } };
}

describe('pinned product environment runs', () => {
  it('requests metadata before parts, retains its snapshot, and runs final checks after the suite', async () => {
    const c = await company(), node = await productNode(c), { call } = await c.turn(c.bruno);
    const started = await call('run_tests', { branch: 'main', suite: 'unit' });
    expect(started).toMatchObject({ error: false }); expect(started.text).toContain('environment');
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ mode: 'product', commitSha: TEST_COMMIT, environmentStatus: 'describing', parts: [] });
    expect((await c.db.select().from(testRuns))[0]!.environmentRequest).toMatchObject({ builtin: true, requestId: expect.any(String) });
    const request = await nextOf(node, 'tests.describe'); expect(request.commitSha).toBe(TEST_COMMIT);
    expect(await c.db.select().from(testParts)).toEqual([]);
    const reply = await productDescription(request); node.send(reply);
    await until(async () => (await c.db.select().from(testRuns))[0]?.environmentSnapshot !== null);
    expect((await c.db.select().from(testParts).orderBy(asc(testParts.part))).map(p => p.status)).toEqual(['running', 'queued']);
    const part = await nextOf(node, 'tests.run');
    expect(part).toMatchObject({ command: '', environment: { snapshot: { description: reply.result.description, profile: 'fast' }, selection: { kind: 'suite', suiteId: 'unit', files: ['test/a.ts', 'test/b.ts'] } } });
    const [before] = await c.db.select().from(testRuns); expect(before!.environmentHash).toBe(reply.result.description.manifestHash);
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ mode: 'product', commitSha: TEST_COMMIT, environmentStatus: 'ready', environment: { profile: 'fast' }, parts: [{ selection: { kind: 'suite' } }, { selection: { kind: 'final' } }] });
    node.send({ ...reply, result: { ...reply.result, description: { ...reply.result.description, inventory: [] } } }); await pumpTests(c.app.ctx);
    expect((await c.db.select().from(testRuns))[0]!.environmentSnapshot).toEqual(before!.environmentSnapshot);
    node.send(productDone(part));
    await until(async () => (await c.db.select().from(testParts)).some(p => p.part === 2 && p.status === 'running'));
    const final = await nextOf(node, 'tests.run');
    expect(final.environment!.selection).toEqual({ kind: 'final', suiteId: 'unit', files: [] }); node.send(productDone(final));
    await until(async () => (await c.db.select().from(testRuns))[0]?.status === 'passed');
  });
  it('ignores an answer from an unassigned node and terminates invalid metadata without a successful empty run', async () => {
    const c = await company(), node = await productNode(c), other = await c.machine(c.ceo, 'foreign'), { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { branch: 'main', suite: 'unit' })).error).toBe(false);
    const request = await nextOf(node, 'tests.describe'), reply = await productDescription(request); other.node.send(reply); await pumpTests(c.app.ctx);
    expect((await c.db.select().from(testRuns))[0]!.environmentSnapshot).toBeNull();
    node.send({ ...reply, result: { ...reply.result, description: { ...reply.result.description, manifestHash: 'f'.repeat(64) } } });
    await until(async () => (await c.db.select().from(testRuns))[0]?.status === 'failed');
    expect((await c.db.select().from(testParts))[0]).toMatchObject({ status: 'failed', error: 'description_mismatch' });
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ mode: 'product', commitSha: TEST_COMMIT, environmentStatus: 'failed', environmentProblem: { code: 'description_mismatch' } });
  });
  it('cancels a pending description and refuses a late snapshot after stop', async () => {
    const c = await company(), node = await productNode(c), { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { branch: 'main' })).error).toBe(false); const request = await nextOf(node, 'tests.describe');
    expect((await call('stop_tests', { run: 1 })).error).toBe(false);
    expect(await nextOf(node, 'tests.describe.cancel')).toMatchObject({ requestId: request.requestId }); node.send(await productDescription(request)); await pumpTests(c.app.ctx);
    expect((await c.db.select().from(testRuns))[0]).toMatchObject({ status: 'stopped', environmentSnapshot: null }); expect(await c.db.select().from(testParts)).toEqual([]);
  });
});

function productDone(part: TestsRun, runtimes = part.environment!.snapshot.description.runtimeCapabilities) {
  const { snapshot, selection } = part.environment!;
  return done(part, { commit: part.commitSha, environmentReceipt: { version: 1, commitSha: part.commitSha, manifestHash: snapshot.description.manifestHash, ...selection, runtimes, dependencies: { key: 'd'.repeat(64), hit: false }, environments: [], phases: { checkoutMs: 1, dependenciesMs: 1, environmentMs: 0, servicesMs: 0, commandMs: 1, cleanupMs: 1 } } });
}

it.each(['missing', 'wrong-selection', 'wrong-hash'])('refuses a successful product result with %s receipt evidence', async kind => {
  const c = await company(), node = await productNode(c), { call } = await c.turn(c.bruno);
  expect((await call('run_tests', { branch: 'main' })).error).toBe(false);
  const request = await nextOf(node, 'tests.describe'); node.send(await productDescription(request));
  const part = await nextOf(node, 'tests.run');
  const message = productDone(part) as ReturnType<typeof productDone> & { environmentReceipt: import('@hornhoof/protocol').TestEnvironmentReceipt };
  if (kind === 'missing') delete (message as { environmentReceipt?: unknown }).environmentReceipt;
  if (kind === 'wrong-selection') {
    if (message.environmentReceipt.version !== 1) throw new Error('This fixture requires a legacy receipt.');
    message.environmentReceipt.files = ['test/a.ts'];
  }
  if (kind === 'wrong-hash') message.environmentReceipt.manifestHash = 'f'.repeat(64);
  node.send(message);
  await until(async () => (await c.db.select().from(testRuns))[0]?.status === 'failed');
  const parts = await c.db.select().from(testParts).orderBy(asc(testParts.part));
  expect(parts).toMatchObject([{ status: 'failed', error: 'environment_invalid', environmentReceipt: null }, { status: 'failed', error: 'prerequisite_failed' }]);
});

it('selects a capable sibling volume, holds no machine to where it ran before as each has the harness, and goes on when one disappears', async () => {
  const c = await company();
  const connect = await c.app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(c.ceo) });
  const code = connect.json().command.split('--join ')[1];
  const joined = (await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'cache-shared-0001-abcd', hostname: 'cache-shared', os: 'linux', arch: 'x86_64' } })).json();
  const connected: { node: FakeNode; id: string }[] = [];
  for (const entry of joined.nodes) {
    const node = await connectNode(c.url, entry.key);
    node.send({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], tests: [], work: true, load: idle({ host: 'a'.repeat(64) }) });
    await until(() => c.app.ctx.hub.loadOf(nodeIdentity(entry.nodeId)) !== null); connected.push({ node, id: entry.nodeId });
  }
  const [base] = await placesOf(c.app.ctx, c.task.companyId), sibling = connected.find(node => node.id !== base!.nodeId)!, original = connected.find(node => node.id === base!.nodeId)!;
  const { testCapabilities } = await import('../src/modules/testruns/describe.js');
  const advertise = async (entry: typeof sibling, fingerprint = 'b'.repeat(64)) => {
    entry.node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: [{ id: 'node', version: '22.15.0', fingerprint }] });
    await until(() => testCapabilities(c.app.ctx, nodeIdentity(entry.id)).testEnvironmentVersion === 1);
  };
  await advertise(sibling);
  const { call } = await c.turn(c.bruno);
  expect((await call('run_tests', { branch: 'main' })).error).toBe(false);
  const request = await nextOf(sibling.node, 'tests.describe'); sibling.node.send(await productDescription(request));
  const first = await nextOf(sibling.node, 'tests.run'); sibling.node.send(productDone(first));
  const final = await nextOf(sibling.node, 'tests.run'); sibling.node.send(productDone(final));
  await until(async () => (await c.db.select().from(testRuns))[0]?.status === 'passed');
  await advertise(original);
  expect((await call('run_tests', { branch: 'main' })).error).toBe(false);
  const nextRequest = await nextOf(original.node, 'tests.describe'); original.node.send(await productDescription(nextRequest));
  const next = await nextOf(original.node, 'tests.run');
  expect((await c.db.select().from(testParts).where(eq(testParts.id, next.partId)))[0]!.nodeId).toBe(original.id);
  expect(next.environment!.snapshot.description.commitSha).toBe(TEST_COMMIT);
  await call('stop_tests', { run: 2 }); original.node.close(); await original.node.closed;
  expect((await call('run_tests', { branch: 'main' })).error).toBe(false);
  const otherRequest = await nextOf(sibling.node, 'tests.describe'); sibling.node.send(await productDescription(otherRequest));
  const other = await nextOf(sibling.node, 'tests.run');
  expect((await c.db.select().from(testParts).where(eq(testParts.id, other.partId)))[0]!.nodeId).toBe(sibling.id);
  await call('stop_tests', { run: 3 });
});

it('gives a part to a node of another build and processor of the class that described its run, and the Tests report accepts its receipt, but not to another system or Node major', async () => {
  const c = await company();
  const connect = await c.app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(c.ceo) });
  const code = connect.json().command.split('--join ')[1];
  const joined = (await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'runtime-match-0001', hostname: 'runtime-match', os: 'linux', arch: 'x86_64' } })).json();
  const connected: { node: FakeNode; id: string }[] = [];
  for (const entry of joined.nodes) {
    const node = await connectNode(c.url, entry.key);
    node.send({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], tests: [], work: true, load: idle({ host: 'a'.repeat(64) }) });
    await until(() => c.app.ctx.hub.loadOf(nodeIdentity(entry.nodeId)) !== null); connected.push({ node, id: entry.nodeId });
  }
  const { testCapabilities } = await import('../src/modules/testruns/describe.js');
  const { passedProductPart } = await import('../src/modules/testruns/receipts.js');
  const { runsInClass } = await import('@hornhoof/protocol');
  type Runtime = { id: string; version: string; fingerprint: string; platform: { os: string; arch: string; libc: string } };
  const runtime = (fingerprint: string, platform: Partial<Runtime['platform']> = {}, version = '22.15.0'): Runtime[] => [{ id: 'node', version, fingerprint, platform: { os: 'linux', arch: 'x64', libc: 'glibc', ...platform } }];
  const x64 = runtime('b'.repeat(64)), arm64 = runtime('c'.repeat(64), { arch: 'arm64' }), darwin = runtime('d'.repeat(64), { os: 'darwin', arch: 'arm64' }), node24 = runtime('e'.repeat(64), {}, '24.1.0');
  const advertise = async (entry: { node: FakeNode; id: string }, testRuntimes: Runtime[]) => {
    entry.node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes });
    await until(() => JSON.stringify(testCapabilities(c.app.ctx, nodeIdentity(entry.id)).testRuntimes) === JSON.stringify(testRuntimes));
  };
  /* The machine gives a run without a snapshot to its first node, so that one describes it. */
  const order = await c.db.select({ id: nodes.id }).from(nodes).where(inArray(nodes.id, connected.map(entry => entry.id))).orderBy(asc(nodes.createdAt), asc(nodes.id));
  const [describer, other] = order.map(row => connected.find(entry => entry.id === row.id)!) as [typeof connected[number], typeof connected[number]];
  await advertise(describer, x64);
  const { call } = await c.turn(c.bruno);
  expect((await call('run_tests', { branch: 'main', suite: 'unit' })).error).toBe(false);
  const request = await nextOf(describer.node, 'tests.describe');
  /* The describer, an x64 machine, takes no part now. */
  await advertise(describer, []);
  describer.node.send(await productDescription(request, x64));
  await until(async () => (await c.db.select().from(testRuns))[0]?.environmentSnapshot !== null);
  const snapshot = (await c.db.select().from(testRuns))[0]!.environmentSnapshot!;
  for (const foreign of [darwin, node24]) {
    await advertise(other, foreign); await pumpTests(c.app.ctx);
    expect((await c.db.select().from(testParts)).map(part => [part.status, part.nodeId])).toEqual([['queued', null], ['queued', null]]);
    expect(runsInClass(snapshot, foreign)).toBe(false);
  }
  /* An arm64 machine of the same system, libc and Node major takes the parts, and the Tests report accepts what it proves. */
  await advertise(other, arm64);
  const first = await nextOf(other.node, 'tests.run'); other.node.send(productDone(first, arm64));
  const final = await nextOf(other.node, 'tests.run'); other.node.send(productDone(final, arm64));
  await until(async () => (await c.db.select().from(testRuns))[0]?.status === 'passed');
  const parts = await c.db.select().from(testParts).orderBy(asc(testParts.part));
  expect(parts.map(part => part.nodeId)).toEqual([other.id, other.id]);
  expect(parts.map(part => part.environmentReceipt?.runtimes)).toEqual([arm64, arm64]);
  expect(parts.every(part => passedProductPart(snapshot, part))).toBe(true);
  for (const foreign of [darwin, node24]) expect(passedProductPart(snapshot, { ...parts[0]!, environmentReceipt: { ...parts[0]!.environmentReceipt!, runtimes: foreign } })).toBe(false);
});

it('fails a run at once when the node that described it lacks a runtime its profile needs, as no part could prove it on the described runtimes', async () => {
  const c = await company(), node = await productNode(c), { call } = await c.turn(c.bruno);
  expect((await call('run_tests', { branch: 'main' })).error).toBe(false);
  const request = await nextOf(node, 'tests.describe'), reply = await productDescription(request);
  reply.result.description.manifest.runtimes.push({ id: 'python', version: '3.12' });
  reply.result.description.manifest.suites[0].finalChecks = [];
  reply.result.description.manifestSource = JSON.stringify(reply.result.description.manifest);
  const { hashTestEnvironment } = await import('@hornhoof/protocol'); reply.result.description.manifestHash = await hashTestEnvironment(reply.result.description.manifestSource);
  node.send(reply);
  await until(async () => (await c.db.select().from(testRuns))[0]?.status === 'failed');
  expect((await c.db.select().from(testParts))).toMatchObject([{ status: 'failed', error: 'runtime_missing', tail: expect.stringContaining('python 3.12') }]);
  expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ environmentStatus: 'failed', environmentProblem: { code: 'runtime_missing' } });
});

it('refuses product mode when pinning returns a non-40-character commit before creating a run', async () => {
  const c = await company(), { call } = await c.turn(c.bruno);
  vi.spyOn(c.app.ctx, 'readCommit').mockResolvedValue({ branch: 'task-1', commitSha: 'a'.repeat(64) });
  const result = await call('run_tests', { branch: 'main' });
  expect(result.error).toBe(true); expect(result.text).toContain('40'); expect(await c.db.select().from(testRuns)).toEqual([]);
});

it('resends its persisted describe request after server state is recreated and ignores unknown request IDs', async () => {
  const c = await company(), node = await productNode(c), { call } = await c.turn(c.bruno);
  expect((await call('run_tests', { branch: 'main' })).error).toBe(false); const request = await nextOf(node, 'tests.describe');
  const restarted = { ...c.app.ctx };
  const { noteTestCapabilities } = await import('../src/modules/testruns/describe.js');
  noteTestCapabilities(restarted, BUILTIN, { testEnvironmentVersion: 1, testRuntimes: [{ id: 'node', version: '22.15.0', fingerprint: 'b'.repeat(64) }] });
  await pumpTests(restarted);
  expect(await nextOf(node, 'tests.describe')).toEqual(request);
  node.send({ ...await productDescription(request), requestId: '99999999-9999-4999-8999-999999999999' }); await pumpTests(c.app.ctx);
  expect((await c.db.select().from(testRuns))[0]!.environmentSnapshot).toBeNull();
  node.send(await productDescription(request)); const part = await nextOf(node, 'tests.run');
  expect(part.commitSha).toBe(request.commitSha); await call('stop_tests', { run: 1 });
});

it('fails an unanswered description once at its queue deadline and never passes an empty product plan', async () => {
  const c = await company(), node = await productNode(c), { call } = await c.turn(c.bruno);
  expect((await call('run_tests', { branch: 'main' })).error).toBe(false); const request = await nextOf(node, 'tests.describe');
  expect((await c.db.select().from(testRuns))[0]).toMatchObject({ status: 'running', parts: 0 });
  await c.db.update(testRuns).set({ createdAt: new Date(Date.now() - 2 * 3_600_000 - 1000) });
  await checkTestTimes(c.app.ctx);
  expect((await c.db.select().from(testRuns))[0]).toMatchObject({ status: 'failed' });
  expect((await c.db.select().from(testParts))[0]).toMatchObject({ status: 'failed', error: 'timeout' });
  expect(await nextOf(node, 'tests.describe.cancel')).toMatchObject({ requestId: request.requestId });
  const wakes = await c.db.select().from(pendingWakes).where(eq(pendingWakes.taskId, c.task.id));
  expect(wakes).toHaveLength(1); await checkTestTimes(c.app.ctx); expect(await c.db.select().from(pendingWakes).where(eq(pendingWakes.taskId, c.task.id))).toEqual(wakes);
});

it('refuses to dispatch a pinned product snapshot after its repository configuration changes', async () => {
  const c = await company(), node = await productNode(c), { call } = await c.turn(c.bruno);
  const { testCapabilities } = await import('../src/modules/testruns/describe.js');
  expect((await call('run_tests', { branch: 'main' })).error).toBe(false);
  const request = await nextOf(node, 'tests.describe'), reply = await productDescription(request);
  /* The node takes no part until the repository changed: it names no runtime for a while. */
  node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: [] });
  await until(() => testCapabilities(c.app.ctx, BUILTIN).testRuntimes?.length === 0);
  node.send(reply); await until(async () => (await c.db.select().from(testRuns))[0]?.environmentSnapshot !== null);
  await c.db.update(departments).set({ repoUrl: 'https://example.test/replacement.git' }).where(eq(departments.id, c.dev.id));
  node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: reply.result.description.runtimeCapabilities });
  await until(async () => (await c.db.select().from(testRuns))[0]?.status === 'failed');
  expect((await c.db.select().from(testParts))[0]).toMatchObject({ status: 'failed', error: 'no_repository', nodeId: null });
  expect(await gets(c.app.ctx, node, 'tests.run')).toBe(false);
});

it('retries interrupted metadata under new request IDs at the same pinned commit and fails once after three attempts', async () => {
  const c = await company(), node = await productNode(c), { call } = await c.turn(c.bruno);
  expect((await call('run_tests', { branch: 'main' })).error).toBe(false);
  let request = await nextOf(node, 'tests.describe');
  const first = request;
  for (const code of ['cancelled', 'timeout'] as const) {
    node.send({ type: 'tests.described', requestId: request.requestId, commitSha: request.commitSha, result: { status: 'error', problem: { code, detail: 'A transient metadata interruption.' } } });
    await until(async () => { const [run] = await c.db.select().from(testRuns); return run!.status !== 'running' || run!.environmentRequest!.requestId !== request.requestId; });
    expect((await c.db.select().from(testRuns))[0]!.status).toBe('running');
    const previous = request; request = await nextOf(node, 'tests.describe');
    expect(request.requestId).not.toBe(previous.requestId); expect(request.commitSha).toBe(first.commitSha); expect(request.repositoryScope).toEqual(first.repositoryScope);
  }
  node.send({ type: 'tests.described', requestId: request.requestId, commitSha: request.commitSha, result: { status: 'error', problem: { code: 'commit_unavailable', detail: 'The metadata node could not complete discovery.' } } });
  await until(async () => (await c.db.select().from(testRuns))[0]!.status === 'failed');
  expect((await c.db.select().from(testRuns))[0]!.environmentRequest).toMatchObject({ attempts: 3, problem: { code: 'commit_unavailable' } });
  expect(await c.db.select().from(testParts)).toHaveLength(1);
  expect(await c.db.select().from(pendingWakes).where(eq(pendingWakes.taskId, c.task.id))).toHaveLength(1);
});

it.each(['lending', 'access'])('rechecks a persisted metadata node after revoking %s', async permission => {
  const c = await company(), machine = await c.machine(c.ann, 'metadata-owner'), id = nodeIdentity(machine.nodeId);
  const { noteTestCapabilities, testCapabilities } = await import('../src/modules/testruns/describe.js');
  const capabilities = { testEnvironmentVersion: 1 as const, testRuntimes: [{ id: 'node', version: '22.15.0', fingerprint: 'b'.repeat(64) }] };
  machine.node.send({ type: 'status', loggedIn: true, limits: null, ...capabilities });
  await until(() => testCapabilities(c.app.ctx, id).testEnvironmentVersion === 1);
  const { call } = await c.turn(c.bruno); expect((await call('run_tests', { branch: 'main' })).error).toBe(false);
  const request = await nextOf(machine.node, 'tests.describe');
  if (permission === 'lending') expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${machine.machineId}`, payload: { lendsTests: false }, ...as(c.ann) })).statusCode).toBe(200);
  else {
    const [owner] = await c.db.select({ id: machines.personId }).from(machines).where(eq(machines.id, machine.machineId));
    await c.db.delete(personAccess).where(eq(personAccess.personId, owner!.id));
  }
  const restarted = { ...c.app.ctx }; noteTestCapabilities(restarted, id, capabilities); await pumpTests(restarted);
  expect(await gets(c.app.ctx, machine.node, 'tests.describe')).toBe(false);
  expect((await c.db.select().from(testRuns))[0]!.environmentRequest!.requestId).toBeNull();
  const replacement = await productNode(c), next = await nextOf(replacement, 'tests.describe');
  expect(next.requestId).not.toBe(request.requestId); expect(next.commitSha).toBe(request.commitSha);
});
