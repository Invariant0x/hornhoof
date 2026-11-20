import { MAX_RUN_FILES } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { FILE_BYTES } from '../src/modules/tasks/file-policy.js';
import { until } from './helpers.js';
import { company, done, idle, nextOf } from './test-runs-company.js';

/* What a part of a test run leaves in $HH_OUT goes on the run's task, as a part of work's does (#1674): a browser check's
   pictures, say, which otherwise leave their machine only inside the log. Made-up files. */
describe('the files a part of a test run made', () => {
  const octets = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream' });

  it('go on its task as test-<run>-<part>-<name>, and the result and test_run name them', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'npx playwright test plan-card.spec.ts' });
    const run = await nextOf(ivan.node, 'tests.run');
    const put = await c.app.inject({ method: 'PUT', url: `/api/parts/${run.partId}/files/shot-375.png`, headers: octets(ivan.key), payload: Buffer.from('png') });
    expect(put.statusCode).toBe(201);
    expect(put.json()).toEqual({ name: 'test-1-1-shot-375.png' });
    /* A test run takes in no task files. */
    await c.putFile('data.csv', 'a,b\n');
    expect((await c.app.inject({ url: `/api/parts/${run.partId}/files/data.csv`, headers: { authorization: `Bearer ${ivan.key}` } })).statusCode).toBe(404);
    ivan.node.send(done(run, { ok: false, exitCode: 1, error: 'failed', log: 'Put on the task: shot-375.png.\n' }));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toMatch(/Test run 1 failed/);
    expect(prompt).toContain('What it made is on #1: test-1-1-shot-375.png. Get a file with hh-fetch 1 <name>.');
    expect(prompt).toContain("Each part's full log is on #1: hh-fetch 1 tests-1-1.log.");
    expect((await c.filesOn()).map(f => f.name).sort()).toEqual(['data.csv', 'test-1-1-shot-375.png', 'tests-1-1.log']);
    expect((await c.filesOn()).find(f => f.name === 'test-1-1-shot-375.png')!.text).toBe('png');
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ parts: [{ part: 1, status: 'failed', log: 'tests-1-1.log', made: ['test-1-1-shot-375.png'] }] });
  });

  it('of a lost attempt go when the part runs again, and the old attempt puts no more', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make shots' });
    const lost = await nextOf(ann.node, 'tests.run');
    const put = (key: string, partId: string, name: string) => c.app.inject({ method: 'PUT', url: `/api/parts/${partId}/files/${name}`, headers: octets(key), payload: Buffer.from(name) });
    expect((await put(ann.key, lost.partId, 'old.png')).statusCode).toBe(201);
    ann.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    const again = await nextOf(ivan.node, 'tests.run');
    expect(again.partId).not.toBe(lost.partId);
    expect(await c.filesOn()).toEqual([]);
    expect((await put(ann.key, lost.partId, 'late.png')).statusCode).toBe(404);
    expect((await put(ivan.key, again.partId, 'new.png')).statusCode).toBe(201);
    ivan.node.send(done(again));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toContain('What it made is on #1: test-1-1-new.png.');
    expect((await c.filesOn()).map(f => f.name).sort()).toEqual(['test-1-1-new.png', 'tests-1-1.log']);
  });

  it('are taken from no part that was stopped or has ended', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make shots' });
    const first = await nextOf(ivan.node, 'tests.run');
    await call('stop_tests', { run: 1 });
    await nextOf(ivan.node, 'tests.cancel');
    expect((await c.app.inject({ method: 'PUT', url: `/api/parts/${first.partId}/files/shot.png`, headers: octets(ivan.key), payload: Buffer.from('x') })).statusCode).toBe(404);
    ivan.node.send(done(first, { ok: false, error: 'cancelled', exitCode: null, log: 'Stopped.\n' }));
    await nextOf(ivan.node, 'tests.ack');
    await call('run_tests', { branch: 'main', command: 'make shots' });
    const second = await nextOf(ivan.node, 'tests.run');
    ivan.node.send(done(second));
    await nextOf(ivan.node, 'tests.ack');
    expect((await c.app.inject({ method: 'PUT', url: `/api/parts/${second.partId}/files/shot.png`, headers: octets(ivan.key), payload: Buffer.from('x') })).statusCode).toBe(404);
    expect((await c.filesOn()).map(f => f.name).sort()).toEqual(['tests-1-1.log', 'tests-2-1.log']);
  });

  it('are at most as many and as large as a part of work may put, and fit the room the company has for files', async () => {
    const c = await company({ TASK_FILES_MB: '2' });
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make shots' });
    const run = await nextOf(ivan.node, 'tests.run');
    const put = (name: string, bytes: Buffer) => c.app.inject({ method: 'PUT', url: `/api/parts/${run.partId}/files/${name}`, headers: octets(ivan.key), payload: bytes });
    expect((await put('too-big.bin', Buffer.alloc(FILE_BYTES + 1))).statusCode).toBe(413);
    const full = await put('over-room.bin', Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(full.statusCode).toBe(413);
    for (let i = 1; i <= MAX_RUN_FILES; i++) expect((await put(`shot-${i}.png`, Buffer.from('png'))).statusCode).toBe(201);
    const more = await put('one-more.png', Buffer.from('png'));
    expect(more.statusCode).toBe(409);
    expect(more.json().error.message).toBe(`A part puts at most ${MAX_RUN_FILES} files on its task.`);
    expect((await c.filesOn()).filter(f => f.name?.startsWith('test-1-1-'))).toHaveLength(MAX_RUN_FILES);
  });
});
