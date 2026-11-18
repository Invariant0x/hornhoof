import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testParts } from '../src/db/schema.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { placesOf, pumpTests } from '../src/modules/testruns/runs.js';
import { as, connectNode, until, type FakeNode } from './helpers.js';
import { company, done, gets, GIB, idle, nextOf, reportHost } from './test-runs-company.js';

const onePartMemory = { hostMemFree: 4 * GIB };

describe('parts on physical computers', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    { memory: 94, load: 0, limit: '', admitted: 3, why: null },
    { memory: 12, load: 0, limit: '', admitted: 3, why: null },
    { memory: 4, load: 0, limit: '', admitted: 1, why: /Short of the 4 GB of free memory/ },
    { memory: 94, load: 7, limit: '', admitted: 1, why: /free cores/ },
    { memory: 94, load: 0, limit: '2', admitted: 2, why: /limit of 2 parts/ },
  ])('admits $admitted parts on the shared 8-core host with $memory GB, load $load and cap "$limit"', async ({ memory, load, limit, admitted, why }) => {
    const c = await company({ MAX_RUNS_PER_HOST: limit });
    const sample = idle({ host: 'a'.repeat(64), hostCpus: 8, hostLoad: load, hostMemFree: memory * GIB, hostMemory: 94 * GIB });
    await c.planless(c.ceo, 'home-api', sample);
    await c.planless(c.ceo, 'home-api-worker', sample);
    await c.builtin(sample);
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test -- {part}', parts: 3 });
    const parts = await c.db.select().from(testParts).orderBy(asc(testParts.part));
    expect(parts.map(part => part.status)).toEqual([...Array(admitted).fill('running'), ...Array(3 - admitted).fill('queued')]);
    if (admitted === 3) expect(parts.filter(part => part.builtin)).toHaveLength(1);
    if (why) {
      const pool = (await c.app.inject({ url: '/api/pool', ...as(c.ceo) })).json();
      expect(pool.waiting[0].why).toMatch(why);
    }
  });

  it.each(['run_tests', 'run_work'])('sends %s parts to a free machine while another waits for an update', async tool => {
    const c = await company({ HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-run-drain-')) });
    const first = await c.machine(c.ann, 'updating');
    const second = await c.machine(c.ceo, 'available');
    const { call } = await c.turn(c.bruno);
    const prepared = await c.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${first.key}` }, payload: {} });
    expect(prepared.json().ready).toBe(true);
    const started = await call(tool, { command: 'printf checked', branch: tool === 'run_work' ? 'task-1' : 'main' });
    expect(started.error).toBe(false);
    const parts = await c.db.select().from(testParts);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ nodeId: second.nodeId, status: 'running' });
    expect(await gets(c.app.ctx, first.node, 'tests.run')).toBe(false);
  });

  it.each([
    { selectedGb: 2, siblingGb: 12, status: 'queued' },
    { selectedGb: 12, siblingGb: 2, status: 'running' },
  ])('uses the selected node with $selectedGb GB, even when its sibling reports $siblingGb GB last', async ({ selectedGb, siblingGb, status }) => {
    const c = await company();
    const connect = await c.app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(c.ceo) });
    const code = connect.json().command.split('--join ')[1];
    const joined = (await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'shared-0001-abcd', hostname: 'shared', os: 'linux', arch: 'x86_64' } })).json();
    const connected: { node: FakeNode; id: string }[] = [];
    const host = { host: 'linux', hostCpus: 16, hostLoad: 1, hostMemFree: 12 * GIB, hostMemory: 16 * GIB };
    for (const entry of joined.nodes) {
      const node = await connectNode(c.url, entry.key);
      node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], tests: [], work: true, load: idle({ ...host, memFree: GIB }) });
      await until(() => c.app.ctx.hub.loadOf(nodeIdentity(entry.nodeId)) !== null);
      connected.push({ node, id: entry.nodeId });
    }
    const [chosen] = await placesOf(c.app.ctx, c.task.companyId);
    const selected = connected.find(n => n.id === chosen!.nodeId)!;
    const sibling = connected.find(n => n.id !== selected.id)!;
    selected.node.send({ type: 'load', ...idle({ ...host, memFree: selectedGb * GIB }) });
    await until(() => c.app.ctx.hub.loadOf(nodeIdentity(selected.id))?.memFree === selectedGb * GIB);
    const selectedAt = c.app.ctx.hub.loadOf(nodeIdentity(selected.id))!.at;
    /* The sibling's report comes a millisecond later on a clock the test moves. */
    vi.useFakeTimers({ toFake: ['Date'], now: selectedAt + 1 });
    sibling.node.send({ type: 'load', ...idle({ ...host, memFree: siblingGb * GIB }) });
    await until(() => (c.app.ctx.hub.loadOf(nodeIdentity(sibling.id))?.at ?? 0) > selectedAt);
    vi.useRealTimers();
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ status }]);
    if (status === 'running') expect((await c.db.select().from(testParts))[0]!.nodeId).toBe(selected.id);
    else expect((await c.app.inject({ url: '/api/pool', ...as(c.ceo) })).json().waiting[0].why).toMatch(/Short of the 4 GB/);
  });

  it('groups reports received through the node protocol without injecting hub state', async () => {
    const c = await company();
    const load = idle({ host: 'linux', hostCpus: 16, hostLoad: 1, hostMemFree: 12 * GIB, hostMemory: 16 * GIB });
    await c.planless(c.ceo, 'container-one', load);
    await c.planless(c.ceo, 'container-two', load);
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test -- {part}', parts: 2 });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ status: 'running' }, { status: 'running' }]);
  });

  it('sends the next run to another host even when a sibling container looks idle', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    reportHost(c, one.nodeId, 'linux', onePartMemory);
    reportHost(c, two.nodeId, 'linux', onePartMemory);
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    await nextOf(one.node, 'tests.run');
    const mac = await c.machine(c.ceo, 'laptop', idle({ load: 6 }));
    reportHost(c, mac.nodeId, 'mac', { hostLoad: 6 });
    await call('run_tests', { branch: 'main', command: 'make test' });
    const state = JSON.parse((await call('test_run', { run: 2 })).text);
    expect(state.parts).toMatchObject([{ status: 'running', machine: 'laptop' }]);
    expect(await gets(c.app.ctx, two.node, 'tests.run')).toBe(false);
  });

  it('keeps the next run queued until a part on the shared host ends', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    reportHost(c, one.nodeId, 'linux', onePartMemory);
    reportHost(c, two.nodeId, 'linux', onePartMemory);
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    const first = await nextOf(one.node, 'tests.run');
    const waits = await call('run_tests', { branch: 'main', command: 'make test' });
    expect(waits.text).toMatch(/Test run 2.*waits for a free machine/);
    expect(JSON.parse((await call('test_run', { run: 2 })).text).parts).toMatchObject([{ status: 'queued', machine: null }]);
    expect(await gets(c.app.ctx, two.node, 'tests.run')).toBe(false);
    const pool = (await c.app.inject({ url: '/api/pool', ...as(c.ceo) })).json();
    expect(pool.waiting[0].why).toMatch(/Short of the 4 GB of free memory/);
    one.node.send(done(first));
    await nextOf(one.node, 'tests.run');
    expect(JSON.parse((await call('test_run', { run: 2 })).text).parts[0].status).toBe('running');
  });

  it('keeps a node reserved when its host has room, since the node shares one test user', async () => {
    const c = await company();
    const box = await c.planless(c.ceo, 'container');
    reportHost(c, box.nodeId, 'linux');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test -- {part}', parts: 2 });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ status: 'running' }, { status: 'queued' }]);
  });

  it('uses the newest report of a shared host even when its other container reported an idle host earlier', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'stale-container');
    const two = await c.planless(c.ceo, 'current-container');
    const mac = await c.machine(c.ceo, 'laptop', idle({ load: 6 }));
    /* The second report of the host comes later on a clock the test moves. */
    vi.useFakeTimers({ toFake: ['Date'] });
    reportHost(c, one.nodeId, 'linux', { hostLoad: 1 });
    vi.setSystemTime(Date.now() + 5);
    reportHost(c, two.nodeId, 'linux', { hostLoad: 15 });
    reportHost(c, mac.nodeId, 'mac', { hostLoad: 5 });
    vi.useRealTimers();
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ machine: 'laptop' }]);
  });

  it('keeps old places without a host separate, including the built-in node', async () => {
    const c = await company();
    await c.planless(c.ceo, 'one');
    await c.planless(c.ceo, 'two');
    await c.builtin();
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test -- {part}', parts: 3 });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts.map((p: { status: string }) => p.status)).toEqual(['running', 'running', 'running']);
  });

  it('picks by host resources instead of an idle container on a loaded host', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'idle-container');
    const mac = await c.machine(c.ceo, 'laptop', idle({ load: 6 }));
    reportHost(c, one.nodeId, 'linux', { hostLoad: 15 });
    reportHost(c, mac.nodeId, 'mac', { hostLoad: 2 });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ machine: 'laptop' }]);
  });

  it('keeps the host slot occupied while a disconnected node may still run its part', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    reportHost(c, one.nodeId, 'linux', onePartMemory);
    reportHost(c, two.nodeId, 'linux', onePartMemory);
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    await nextOf(one.node, 'tests.run');
    one.node.close();
    await until(() => !c.app.ctx.hub.isOnline(nodeIdentity(one.nodeId)));
    expect((await call('run_tests', { branch: 'main', command: 'make test' })).text).toMatch(/waits for a free machine/);
    expect(await gets(c.app.ctx, two.node, 'tests.run')).toBe(false);
  });

  it('tries another physical computer when a sibling container lost a part', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    const mac = await c.machine(c.ceo, 'laptop', idle({ load: 6 }));
    reportHost(c, one.nodeId, 'linux');
    reportHost(c, two.nodeId, 'linux');
    reportHost(c, mac.nodeId, 'mac', { hostLoad: 6 });
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    const first = await nextOf(one.node, 'tests.run');
    one.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], tests: [], load: idle() });
    await until(async () => (await c.db.select().from(testParts)).some(p => p.id !== first.partId));
    expect(JSON.parse((await call('test_run', { run: 1 })).text).parts).toMatchObject([{ status: 'running', machine: 'laptop' }]);
  });

  it('reserves memory when run requests arrive together', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    reportHost(c, one.nodeId, 'linux', onePartMemory);
    reportHost(c, two.nodeId, 'linux', onePartMemory);
    const { call } = await c.turn(c.bruno);
    await Promise.all([call('run_tests', { branch: 'main', command: 'make test' }), call('run_tests', { branch: 'main', command: 'make test' })]);
    const parts = await c.db.select().from(testParts).orderBy(asc(testParts.createdAt));
    expect(parts.map(p => p.status).sort()).toEqual(['queued', 'running']);
  });

  it('recovers the occupied host from the database when its sibling reconnects before it after a server restart', async () => {
    const c = await company();
    const one = await c.planless(c.ceo, 'container-one');
    const two = await c.planless(c.ceo, 'container-two');
    reportHost(c, one.nodeId, 'linux', onePartMemory);
    reportHost(c, two.nodeId, 'linux', onePartMemory);
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { branch: 'main', command: 'make test' });
    await nextOf(one.node, 'tests.run');
    one.node.close();
    await until(() => !c.app.ctx.hub.isOnline(nodeIdentity(one.nodeId)));
    await call('run_tests', { branch: 'main', command: 'make test' });
    /* A new server context has the persisted database and the sibling's connection, without the old server's cache. */
    await pumpTests({ ...c.app.ctx });
    expect(JSON.parse((await call('test_run', { run: 2 })).text).parts).toMatchObject([{ status: 'queued', machine: null }]);
    expect(await gets(c.app.ctx, two.node, 'tests.run')).toBe(false);
  });

  it('queues and explains a run whose host has memory but whose container does not', async () => {
    const c = await company();
    const box = await c.planless(c.ceo, 'small-container');
    reportHost(c, box.nodeId, 'linux', { memFree: 2 * GIB, hostMemFree: 12 * GIB });
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { branch: 'main', command: 'make test' })).text).toMatch(/waits for a free machine/);
    const pool = (await c.app.inject({ url: '/api/pool', ...as(c.ceo) })).json();
    expect(pool.waiting[0].why).toMatch(/Short of the 4 GB/);
  });
});
