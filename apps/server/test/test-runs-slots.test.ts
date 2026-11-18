import { randomUUID } from 'node:crypto';
import { hashTestEnvironment, parseNodeMessage, type CheckQueueRequest, type RunKind } from '@hornhoof/protocol';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentEvents, agents, departments, machines, nodes, people, testParts, testRuns, tasks, jobs } from '../src/db/schema.js';
import { checkQueueLoad, checkQueueSnapshot, closeCheckQueue, receiveCheckRequest, recordPartQueueWait } from '../src/modules/nodes/check-slots.js';
import { nodeIdentity, ownBuiltin } from '../src/modules/nodes/hub.js';
import { handleNodeClose, handleNodeMessage } from '../src/modules/nodes/messages.js';
import { testsHello } from '../src/modules/testruns/runs.js';
import { planningEnvironment } from './fixtures/run-planning/environment.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { company, idle } from './test-runs-company.js';

await prepareSharedDatabase();

async function stand(kind: RunKind = 'tests', hiddenHolder = false) {
  const c = await company();
  const turn = await c.turn(c.bruno);
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  onTestFinished(() => { vi.useRealTimers(); });
  const [owner] = await c.db.select().from(people).where(eq(people.isOwner, true));
  const [machine] = await c.db.insert(machines).values({ companyId: c.task.companyId, personId: owner!.id, machineKey: 'slot-host', hostname: 'home-api' }).returning();
  const [node] = await c.db.insert(nodes).values({ companyId: c.task.companyId, machineId: machine!.id, subscriptionId: turn.job.subscriptionId }).returning();
  const id = nodeIdentity(node!.id);
  vi.spyOn(c.app.ctx.hub, 'loadOf').mockImplementation(() => ({ ...idle({ cpus: 1, load: 0 }), at: Date.now() }));
  vi.spyOn(c.app.ctx.hub, 'lastSeenAt').mockImplementation(() => Date.now());
  await checkQueueLoad(c.app.ctx, id);
  vi.setSystemTime(Date.now() + 90_001);
  await checkQueueLoad(c.app.ctx, id);
  const [privateTask] = hiddenHolder ? await c.db.insert(tasks).values({ ...c.task, id: randomUUID(), number: 2, departmentId: c.sales.id, assigneeAgentId: c.sam.id, executorAgentId: c.sam.id, createdByAgentId: c.sam.id, title: 'Private work' }).returning() : [];
  const runs = await c.db.insert(testRuns).values([1, 2, 3].map(number => ({ companyId: c.task.companyId, number, taskId: number === 1 && privateTask ? privateTask.id : c.task.id, agentId: number === 1 && hiddenHolder ? c.sam.id : c.bruno.id, jobId: turn.job.id, kind: number === 1 ? 'work' as const : kind, command: 'make check', timeoutMs: 60_000, status: 'running' as const }))).returning();
  const parts = await c.db.insert(testParts).values(runs.map(run => ({ companyId: c.task.companyId, runId: run.id, part: 1, status: 'running' as const, nodeId: node!.id, machineId: machine!.id, machineName: 'home-api' }))).returning();
  const claims = parts.map(part => ({ type: 'check.acquire' as const, id: randomUUID(), label: `Run part ${part.id}` }));
  const since = new Date().toISOString();
  for (const claim of claims) await receiveCheckRequest(c.app.ctx, id, claim, sql`false`);
  await new Promise<void>(resolve => setImmediate(resolve));
  await recordPartQueueWait(c.app.ctx, id, { type: 'tests.waiting', partId: parts[2]!.id, position: 2 });
  const read = async () => JSON.parse((await turn.call(kind === 'tests' ? 'test_run' : 'work_run', { run: 3 })).text);
  const release = async (index: number) => {
    await receiveCheckRequest(c.app.ctx, id, { type: 'check.release', id: claims[index]!.id }, sql`false`);
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  return { c, turn, node, id, claims, parts, since, read, release };
}

describe('reading a part that waits for a machine check slot', () => {
  it('uses the pinned worker count of an assigned part for its lease', async () => {
    const s = await stand();
    const ctx = s.c.app.ctx;
    await s.release(0); await s.release(1); await s.release(2);
    const part = s.parts[1]!, { snapshot } = await planningEnvironment();
    const browser = snapshot.description.manifest.suites[0]!;
    browser.run = { program: 'npx', args: ['playwright', 'test', '--workers=2'], cwd: 'web' };
    snapshot.description.manifestSource = JSON.stringify(snapshot.description.manifest);
    snapshot.description.manifestHash = await hashTestEnvironment(snapshot.description.manifestSource);
    await s.c.db.update(testRuns).set({ environmentSnapshot: snapshot, memoryGb: 4 }).where(eq(testRuns.id, part.runId));
    const selection = { kind: 'suite' as const, suiteId: browser.id, files: ['web/test/a.test.ts'] };
    await s.c.db.update(testParts).set({ environmentSelection: { selection, after: [] } }).where(eq(testParts.id, part.id));
    const check = s.claims[1]!;
    await receiveCheckRequest(ctx, s.id, check, sql`false`);
    expect(checkQueueSnapshot(ctx, s.id)).toMatchObject({ holders: [], queue: [{ request: { id: check.id } }] });
    vi.mocked(ctx.hub.loadOf).mockImplementation(() => ({ ...idle({ cpus: 1, hostCpus: 8, hostLoad: 0 }), at: Date.now() }));
    await checkQueueLoad(ctx, s.id);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(checkQueueSnapshot(ctx, s.id)).toMatchObject({ holders: [{ request: { id: check.id } }], queue: [] });
  });

  it.each(['built-in', 'ordinary'] as const)('releases old leases when a new %s node process greets the server', async kind => {
    const s = await stand();
    const ctx = s.c.app.ctx;
    await s.release(0); await s.release(1); await s.release(2);
    await s.c.db.update(nodes).set({ keyHash: 'recorded-node' }).where(eq(nodes.id, s.node!.id));
    const builtin = ownBuiltin(ctx.config);
    const restarted = kind === 'built-in' ? builtin : s.id;
    const peer = kind === 'built-in' ? s.id : builtin;
    const load = idle({ cpus: 1, load: 0, host: 'a'.repeat(64) });
    vi.mocked(ctx.hub.loadOf).mockImplementation(() => ({ ...load, at: Date.now() }));
    const stream = randomUUID();
    const machineUpAt = '2026-11-18T08:00:00.000Z';
    const first = { startedAt: '2026-11-18T08:57:00.000Z', machineUpAt, container: 'home-api' };
    const next = { ...first, startedAt: '2026-11-18T10:16:00.000Z' };
    const greet = (id: typeof restarted, boot = first) => handleNodeMessage(ctx, id, { type: 'hello', version: '0.32.1', loggedIn: true, stream, running: [], tests: s.parts.map(part => part.id), load, boot });
    await greet(restarted); await greet(peer);
    const old = { type: 'check.acquire' as const, id: randomUUID(), label: 'Describe product test environment' };
    const waiting = { ...old, id: randomUUID() }, other = { ...old, id: randomUUID() };
    const acquire = (id: typeof restarted, claim: CheckQueueRequest = old) => receiveCheckRequest(ctx, id, claim, sql`false`);
    const snapshot = () => checkQueueSnapshot(ctx, peer);
    await acquire(restarted); await acquire(restarted, waiting); await acquire(peer, other);
    expect(snapshot()).toMatchObject({ capacity: 1, holders: [{ request: { id: old.id } }], queue: [{ request: { id: waiting.id } }, { request: { id: other.id } }] });

    await handleNodeClose(ctx, restarted);
    await greet(restarted);
    await acquire(restarted, { ...old, resume: true });
    expect(snapshot()?.holders.map(claim => claim.request.id)).toEqual([old.id]);

    await handleNodeClose(ctx, restarted);
    await greet(restarted, next);
    const sent = vi.spyOn(ctx.hub, 'send');
    await acquire(restarted, { ...old, resume: true });
    expect(sent).toHaveBeenCalledWith(restarted, { type: 'check.state', id: old.id, state: 'ended', position: 0 });
    expect(snapshot()).toMatchObject({ capacity: 1, holders: [{ request: { id: other.id } }], queue: [] });
  });

  it('sends a quiet running part to Operations once through the program alarm inbox', async () => {
    const s = await stand();
    const { db } = s.c;
    const companyId = s.c.task.companyId;
    const ctx = s.c.app.ctx;
    const [ops] = await db.insert(departments).values({ companyId, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const [operator] = await db.insert(agents).values({ companyId, kind: 'head', name: 'Operations', roleKey: 'OPS-HEAD', departmentId: ops!.id, subscriptionId: s.turn.job.subscriptionId, model: '' }).returning();
    const partId = s.parts[1]!.id;
    const frame = parseNodeMessage(JSON.stringify({ type: 'tests.silent', partId, n: 1 }));
    expect(frame).not.toBeNull();
    const report = (id = s.id) => handleNodeMessage(ctx, id, frame!);
    const notices = async () => (await db.select({ data: agentEvents.data }).from(agentEvents).where(eq(agentEvents.agentId, operator!.id))).map(row => row.data);
    await report();
    expect(await notices()).toEqual([]);
    await handleNodeMessage(ctx, s.id, { type: 'tests.started', partId });
    vi.setSystemTime(Date.now() + 60_000);
    await report({ kind: 'builtin', machine: 'another-machine' });
    expect(await notices()).toEqual([]);
    await Promise.all([report(), report()]);
    expect(await notices()).toEqual([expect.objectContaining({ text: expect.stringContaining('Test run 2, part 1'), notification: expect.objectContaining({ source: 'program_alarm' }) })]);
  });

  it('clears held and queued claims of a part the database replaced when its node no longer has it', async () => {
    const s = await stand();
    const ctx = s.c.app.ctx;
    const gone = s.parts[0]!, replacement = randomUUID();
    await receiveCheckRequest(ctx, s.id, { ...s.claims[0]!, id: randomUUID() }, sql`false`);
    await s.c.db.update(testParts).set({ id: replacement, status: 'queued', nodeId: null }).where(eq(testParts.id, gone.id));
    await testsHello(ctx, s.id, s.parts.slice(1).map(part => part.id));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(checkQueueSnapshot(ctx, s.id)).toMatchObject({ capacity: 1, holders: [{ request: { id: s.claims[1]!.id } }], queue: [{ request: { id: s.claims[2]!.id } }] });
  });

  it('clears waiting checks for a stopped part and admits the next after the node releases', async () => {
    const s = await stand();
    const ctx = s.c.app.ctx;
    const nested = { ...s.claims[0]!, id: randomUUID() };
    await receiveCheckRequest(ctx, s.id, nested, sql`false`);
    expect((await s.turn.call('stop_work', { run: 1 })).error).toBe(false);
    await receiveCheckRequest(ctx, s.id, { ...nested, id: randomUUID() }, sql`false`);
    expect(checkQueueSnapshot(ctx, s.id)).toMatchObject({ holders: [{ request: { id: s.claims[0]!.id }, retired: true }],
      queue: [{ request: { id: s.claims[1]!.id } }, { request: { id: s.claims[2]!.id } }] });
    await s.release(0);
    expect(checkQueueSnapshot(ctx, s.id)).toMatchObject({ holders: [{ request: { id: s.claims[1]!.id } }], queue: [{ request: { id: s.claims[2]!.id } }] });
  });

  it.each(['tests', 'work'] as const)('shows the current holder and ordered queue for %s, and updates on release', async kind => {
    const s = await stand(kind);
    const part = (await s.read()).parts[0];
    expect(part).toMatchObject({ queuePosition: 2, checkSlot: { machine: 'home-api', state: 'queued', capacity: 1, position: 2, holders: [{ kind: 'work', run: 1, task: s.c.task.number, part: 1, since: s.since }], ahead: [{ kind, run: 2, part: 1, position: 1 }] } });
    expect(part.waiting).toContain('home-api');
    expect(part.waiting).toContain('Work run 1');
    expect(part.waiting).toContain(`task ${s.c.task.number}`);
    expect(part.waiting).toContain(s.since);
    expect(part.waiting).toContain('Ahead:');
    expect(part.waiting).not.toMatch(/[\r\n]/);
    await s.release(0);
    expect((await s.read()).parts[0]).toMatchObject({ queuePosition: 1, checkSlot: { state: 'queued', position: 1, holders: [{ kind, run: 2 }], ahead: [] } });
    await s.release(1);
    expect((await s.read()).parts[0]).toMatchObject({ queuePosition: 0, checkSlot: { state: 'running', position: 0, holders: [{ run: 3 }], ahead: [] } });
    await s.release(2);
    const empty = (await s.read()).parts[0];
    expect(empty.checkSlot).toMatchObject({ state: 'not_recorded', holders: [], ahead: [] });
    expect(empty.waiting).toContain('Queue is empty');
  });

  it('keeps inaccessible holders private and refuses an unrelated reader before showing slot details', async () => {
    const s = await stand('tests', true);
    const part = (await s.read()).parts[0];
    expect(part.checkSlot.holders).toEqual([{ kind: 'unavailable', since: s.since, position: 0, releasing: false }]);
    expect(part.waiting).toContain('details unavailable');
    expect(JSON.stringify(part)).not.toContain('Private work');
    expect(part.checkSlot.holders[0]).not.toHaveProperty('task');
    const other = await s.c.turn(s.c.sam, null);
    expect(await other.call('test_run', { run: 3 })).toMatchObject({ error: true, text: expect.stringContaining('There is no test run 3') });
  });

  it.each(['part label', 'line break'])('identifies an agent check by its task with a %s', async labelKind => {
    const s = await stand();
    await s.release(0); await s.release(1); await s.release(2);
    await s.c.db.update(jobs).set({ nodeId: s.node!.id }).where(eq(jobs.id, s.turn.job.id));
    const label = labelKind === 'part label' ? `Run part ${s.parts[2]!.id}` : 'eslint\ncheck';
    const local = { type: 'check.acquire' as const, id: randomUUID(), jobId: s.turn.job.id, agentId: s.c.bruno.id, label };
    await receiveCheckRequest(s.c.app.ctx, s.id, local, eq(jobs.id, s.turn.job.id));
    expect((await s.read()).parts[0].checkSlot).toMatchObject({ state: 'not_recorded', position: null });
    await receiveCheckRequest(s.c.app.ctx, s.id, { ...s.claims[2]!, id: randomUUID() }, sql`false`);
    await new Promise<void>(resolve => setImmediate(resolve));
    const part = (await s.read()).parts[0];
    expect(part.checkSlot).toMatchObject({ state: 'queued', position: 1 });
    expect(part.checkSlot.holders).toMatchObject([{ kind: 'check', task: s.c.task.number, agent: 'Bruno', label: label.replace('\n', ' '), since: expect.any(String) }]);
    expect(part.waiting).not.toMatch(/[\r\n]/);
    const head = await s.c.turn(s.c.head, null);
    const visible = JSON.parse((await head.call('test_run', { run: 3 })).text);
    expect(visible.parts[0].checkSlot.holders).toMatchObject([{ kind: 'check', agent: 'Bruno', task: s.c.task.number }]);
  });

  it('keeps multiple predecessors in their FIFO order', async () => {
    const s = await stand();
    await s.release(2);
    await s.c.db.update(jobs).set({ nodeId: s.node!.id }).where(eq(jobs.id, s.turn.job.id));
    await receiveCheckRequest(s.c.app.ctx, s.id, { type: 'check.acquire', id: randomUUID(), jobId: s.turn.job.id, label: 'lint' }, eq(jobs.id, s.turn.job.id));
    await receiveCheckRequest(s.c.app.ctx, s.id, { ...s.claims[2]!, id: randomUUID() }, sql`false`);
    const part = (await s.read()).parts[0];
    expect(part.queuePosition).toBe(3);
    expect(part.checkSlot.ahead.map((claim: { kind: string; position: number }) => [claim.kind, claim.position])).toEqual([['tests', 1], ['check', 2]]);
  });

  it('does not mistake an unrecorded part for an empty queue during startup', async () => {
    const s = await stand();
    closeCheckQueue(s.c.app.ctx);
    const unknown = (await s.read()).parts[0];
    expect(unknown.checkSlot).toMatchObject({ state: 'not_recorded', capacity: null, queued: null, position: null });
    expect(unknown.waiting).toContain('Queue state is not recorded by this server');
    await checkQueueLoad(s.c.app.ctx, s.id);
    await receiveCheckRequest(s.c.app.ctx, s.id, { type: 'check.acquire', id: randomUUID(), label: 'another check' }, sql`false`);
    const part = (await s.read()).parts[0];
    expect(part.checkSlot).toMatchObject({ state: 'not_recorded', capacity: 0, queued: 1, position: null });
    expect(part.waiting).not.toContain('Queue is empty');
  });

  it('admits the newly requested part after rejecting a claim on the wrong node', async () => {
    const s = await stand();
    await s.release(0); await s.release(1); await s.release(2);
    const [other] = await s.c.db.insert(nodes).values({ companyId: s.c.task.companyId, machineId: s.node!.machineId }).returning();
    await receiveCheckRequest(s.c.app.ctx, nodeIdentity(other!.id), { ...s.claims[0]!, id: randomUUID() }, sql`false`);
    await receiveCheckRequest(s.c.app.ctx, s.id, { ...s.claims[2]!, id: randomUUID() }, sql`false`);
    await new Promise<void>(resolve => setImmediate(resolve));
    const part = (await s.read()).parts[0];
    expect(part.checkSlot).toMatchObject({ state: 'running', holders: [{ kind: 'tests', run: 3 }], ahead: [] });
  });
});
