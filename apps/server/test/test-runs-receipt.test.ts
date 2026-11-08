import { describe, expect, it } from 'vitest';
import { testParts } from '../src/db/schema.js';
import { checkTestTimes } from '../src/modules/testruns/runs.js';
import { connectNode, until } from './helpers.js';
import { company, done, gets, idle, nextOf } from './test-runs-company.js';

/* A moment past the seconds a machine has to say it got a part, and one well inside them. Both are far short of any
   part's time limit, so only the receipt decides what happens to the part. */
const past = () => new Date(Date.now() + 11_000);
const inside = () => new Date(Date.now() + 2_000);

type Company = Awaited<ReturnType<typeof company>>;
const partsOf = (c: Company) => c.db.select().from(testParts);

/* A run whose one part went to a machine that says nothing of it, then a second machine that does, and the part moved
   there once its first machine's time to say it got it is over. */
async function movedOnce(c: Company) {
  const silent = await c.machine(c.ceo, 'silent-box', idle(), { receives: false });
  const { call } = await c.turn(c.bruno);
  await call('run_tests', { command: 'make test' });
  const lost = await nextOf(silent.node, 'tests.run');
  const ann = await c.machine(c.ann, 'ann-pc');
  await checkTestTimes(c.app.ctx, past());
  return { silent, ann, lost, call };
}

describe('a part sent to a machine', () => {
  it('goes to another machine when its machine does not say within seconds that it got it, and stops on the first', async () => {
    const c = await company();
    const silent = await c.machine(c.ceo, 'silent-box', idle(), { receives: false });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const lost = await nextOf(silent.node, 'tests.run');
    const ann = await c.machine(c.ann, 'ann-pc');
    await checkTestTimes(c.app.ctx, inside());
    expect(await partsOf(c)).toMatchObject([{ id: lost.partId, status: 'running', nodeId: silent.nodeId, lost: [] }]);

    await checkTestTimes(c.app.ctx, past());
    const [moved] = await partsOf(c);
    expect(moved).toMatchObject({ status: 'running', nodeId: ann.nodeId, machineName: 'ann-pc', lost: [{ machine: 'silent-box', why: 'not_received' }] });
    expect(moved!.id).not.toBe(lost.partId);
    expect(await nextOf(silent.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: lost.partId });
    const again = await nextOf(ann.node, 'tests.run');
    expect(again.partId).toBe(moved!.id);

    ann.node.send(done(again));
    await nextOf(ann.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 passed[\s\S]*Part 1 of 1 passed on ann-pc[^\n]*It ran again after silent-box did not say it got it within 10 s\./);
  });

  it('stays on the machine that said it got it, however often it says so', async () => {
    const c = await company();
    const slow = await c.machine(c.ceo, 'slow-box', idle(), { receives: false });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const run = await nextOf(slow.node, 'tests.run');
    await c.machine(c.ann, 'ann-pc');
    slow.node.send({ type: 'tests.received', partId: run.partId });
    slow.node.send({ type: 'tests.received', partId: run.partId });
    await new Promise(r => setTimeout(r, 200));

    await checkTestTimes(c.app.ctx, past());
    expect(await partsOf(c)).toMatchObject([{ id: run.partId, status: 'running', nodeId: slow.nodeId, lost: [] }]);
    expect(await gets(slow.node, 'tests.cancel')).toBe(false);
  });

  it('never goes to a node that does not confirm the parts it gets, and goes to one that does once it is there', async () => {
    const c = await company();
    const old = await c.machine(c.ceo, 'old-node', idle(), { testDispatch: false });
    const { call } = await c.turn(c.bruno);
    const started = await call('run_tests', { command: 'make test' });
    expect(started.text).toMatch(/waits for a free machine\. No machine that may take it is online now/);
    expect(await gets(old.node, 'tests.run')).toBe(false);
    expect(await partsOf(c)).toMatchObject([{ status: 'queued', nodeId: null }]);

    const fresh = await c.machine(c.ann, 'ann-pc');
    expect(await nextOf(fresh.node, 'tests.run')).toMatchObject({ part: 1, command: 'make test' });
    expect(await gets(old.node, 'tests.run')).toBe(false);
  });

  it('stops a part its first machine starts or says it got after the part went elsewhere, and keeps that machine out of the result', async () => {
    const c = await company();
    const { silent, ann, lost, call } = await movedOnce(c);
    expect(await nextOf(silent.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: lost.partId });
    const again = await nextOf(ann.node, 'tests.run');
    const [before] = await partsOf(c);

    silent.node.send({ type: 'tests.received', partId: lost.partId });
    expect(await nextOf(silent.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: lost.partId });
    silent.node.send({ type: 'tests.started', partId: lost.partId });
    expect(await nextOf(silent.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: lost.partId });

    /* A pass the first machine reports late, even twice, is no result of the part that runs elsewhere. */
    silent.node.send(done(lost));
    expect(await nextOf(silent.node, 'tests.ack')).toEqual({ type: 'tests.ack', partId: lost.partId });
    silent.node.send(done(lost));
    expect(await nextOf(silent.node, 'tests.ack')).toEqual({ type: 'tests.ack', partId: lost.partId });
    const [after] = await partsOf(c);
    expect(after).toEqual(before);
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'running', parts: [{ status: 'running', machine: 'ann-pc' }] });

    /* Back after a restart with the part it was told to stop, it is told again. */
    silent.node.close();
    const back = await connectNode(c.url, silent.key, { receives: false });
    back.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [lost.partId], work: true });
    expect(await nextOf(back, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: lost.partId });

    ann.node.send(done(again, { ok: false, exitCode: 1, error: 'failed', log: 'FAIL cart.test.ts\n' }));
    await nextOf(ann.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 failed[\s\S]*Part 1 of 1 failed on ann-pc/);
    ann.node.send(done(again));
    await nextOf(ann.node, 'tests.ack');
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'failed', parts: [{ status: 'failed', machine: 'ann-pc', exitCode: 1 }] });
  });

  it('keeps a part its machine said it got through a disconnect, and takes its result after return', async () => {
    const c = await company();
    const box = await c.machine(c.ceo, 'box', idle(), { receives: false });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const run = await nextOf(box.node, 'tests.run');
    box.node.send({ type: 'tests.received', partId: run.partId });
    await new Promise(r => setTimeout(r, 200));
    box.node.close();
    await until(() => !c.app.ctx.hub.isOnline({ kind: 'node', nodeId: box.nodeId }));

    await checkTestTimes(c.app.ctx, past());
    expect(await partsOf(c)).toMatchObject([{ id: run.partId, status: 'running', nodeId: box.nodeId, lost: [] }]);
    const back = await connectNode(c.url, box.key, { receives: false });
    back.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [run.partId], work: true });
    await until(() => c.app.ctx.hub.isReady({ kind: 'node', nodeId: box.nodeId }));
    back.send(done(run));
    await nextOf(back, 'tests.ack');
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'passed', parts: [{ status: 'passed', machine: 'box' }] });
    expect(await gets(back, 'tests.cancel')).toBe(false);
  });

  it('does not run work elsewhere that its machine did not say it got unless the work may run twice', async () => {
    const c = await company();
    const silent = await c.machine(c.ceo, 'silent-box', idle(), { receives: false });
    const { call } = await c.turn(c.bruno);
    await call('run_work', { command: 'make deploy' });
    const deploy = await nextOf(silent.node, 'tests.run');
    const ann = await c.machine(c.ann, 'ann-pc');
    await checkTestTimes(c.app.ctx, past());
    expect(await partsOf(c)).toMatchObject([{ id: deploy.partId, status: 'failed', error: 'not_received' }]);
    expect(await nextOf(silent.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: deploy.partId });
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Work run 1 failed[\s\S]*Part 1 of 1 failed on silent-box[^:]*: its machine did not say it got it within 10 s, and it did not run again elsewhere, as it may still run there and run_work did not say it is repeatable/);
    expect(await gets(ann.node, 'tests.run')).toBe(false);
  });

  it('fails a part no machine says it got once it went out three times, and says why', async () => {
    const c = await company();
    const silent = await c.machine(c.ceo, 'silent-box', idle(), { receives: false });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    for (const lost of [0, 1]) {
      await nextOf(silent.node, 'tests.run');
      await checkTestTimes(c.app.ctx, past());
      expect((await partsOf(c))[0]!.lost).toHaveLength(lost + 1);
    }
    await nextOf(silent.node, 'tests.run');
    await checkTestTimes(c.app.ctx, past());
    expect(await partsOf(c)).toMatchObject([{ status: 'failed', error: 'not_received' }]);
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(
      /Test run 1 failed[\s\S]*Part 1 of 1 failed on silent-box[^:\n]*: its machine did not say it got it within 10 s\. It ran again after silent-box did not say it got it within 10 s, and again after silent-box did not say it got it within 10 s\./,
    );
    expect(await gets(silent.node, 'tests.run')).toBe(false);
  });
});
