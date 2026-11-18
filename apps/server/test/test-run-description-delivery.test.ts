import type { ServerMessage, TestsDescribed } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { expect, it, onTestFinished, vi } from 'vitest';
import { agents, departments, jobs, tasks, testParts, testRuns } from '../src/db/schema.js';
import { NodeHub } from '../src/modules/nodes/hub.js';
import { acceptDescription, newEnvironmentRequest, noteTestCapabilities, pumpDescriptions, repositoryScope, resetDescriptionDelivery } from '../src/modules/testruns/describe.js';
import type { Place } from '../src/modules/testruns/runs.js';
import { BUILTIN } from './builtin.js';
import { planningEnvironment } from './fixtures/run-planning/environment.js';
import { prepareApp, setUpCompany, testApp, TEST_COMMIT } from './helpers.js';

await prepareApp();

/* Recorded transport events, without a socket, a port or a wall-clock wait. */
function socket() {
  const frames: { message: ServerMessage; complete?: (error?: Error) => void }[] = [];
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    readyState: 1, frames, failure: null as Error | null,
    close() { this.readyState = 3; emitter.emit('close', 1006); },
    ping() {},
    send(frame: string, complete?: (error?: Error) => void) {
      if (this.failure) { const error = this.failure; this.failure = null; throw error; }
      frames.push({ message: JSON.parse(frame) as ServerMessage, complete });
    },
  });
}

async function fixture() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-18T03:00:00Z'));
  onTestFinished(() => { vi.useRealTimers(); });
  const hub = new NodeHub({ pingMs: 2_147_483_647, onClose: async () => {}, onMessage: async () => {} });
  onTestFinished(() => hub.stop());
  const ctx = { ...app.ctx, hub };
  const [agent] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator')), companyId = agent!.companyId;
  const [department] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://example.test/fixture.git' }).returning();
  const [task] = await db.insert(tasks).values({ companyId, departmentId: department!.id, number: 1, title: 'Delivery fixture' }).returning();
  const [job] = await db.insert(jobs).values({ companyId, subscriptionId: agent!.subscriptionId!, agentId: agent!.id, taskId: task!.id, prompt: 'Fixture', timeoutMs: 10_000, status: 'running' }).returning();
  const [run] = await db.insert(testRuns).values({ companyId, departmentId: department!.id, taskId: task!.id, agentId: agent!.id, jobId: job!.id, number: 1, command: '', commitSha: TEST_COMMIT, timeoutMs: 10_000, createdAt: new Date(),
    environmentRequest: newEnvironmentRequest(repositoryScope(companyId, department!.id, department!.repoUrl!), { mode: 'product' }) }).returning();
  const load = { cpus: 8, load: 0.1, memFree: 16 * 1024 ** 3, memTotal: 16 * 1024 ** 3, tests: 0, jobs: 0 };
  const runtimes = [{ id: 'node', version: '22.23.4', fingerprint: 'b'.repeat(64) }, { id: 'python', version: '3.12.0', fingerprint: 'c'.repeat(64) }];
  const connect = () => {
    const transport = socket();
    hub.attach(BUILTIN, transport as unknown as WebSocket); hub.greet(BUILTIN); hub.report(BUILTIN, load);
    noteTestCapabilities(ctx, BUILTIN, { testEnvironmentVersion: 1, testRuntimes: runtimes });
    return transport;
  };
  const transport = connect();
  const place: Place = { key: 'builtin', node: BUILTIN, name: 'Fixture', machineId: null, nodeId: null, builtin: true, builtinMachine: null, lent: true, busy: false, usage: { parts: 0, cores: 0, memoryBytes: 0 }, load, access: null, works: true };
  const pump = () => pumpDescriptions(ctx, async () => [place], async () => ({ department: department!, repo: { url: department!.repoUrl!, branch: 'main', token: '' } }), async () => {});
  const stored = async () => (await db.select().from(testRuns).where(eq(testRuns.id, run!.id)))[0]!;
  return { ctx, db, transport, connect, pump, stored, runtimes };
}

it.each(['The operation was aborted', 'WebSocket is not open: readyState 2 (CLOSING)'])('retries a failed transport write without treating it as delivery: %s', async message => {
  const f = await fixture();
  await f.pump();
  const first = f.transport.frames[0]!;
  first.complete?.(new Error(message));
  await f.pump();
  expect(f.transport.frames.map(frame => frame.message)).toEqual([first.message, first.message]);
  expect((await f.stored()).environmentRequest).toMatchObject({ requestId: (first.message as { requestId: string }).requestId, attempts: 1, problem: null });
  f.transport.close();
  const next = f.connect(); resetDescriptionDelivery(f.ctx);
  await f.pump();
  expect(next.frames.map(frame => frame.message)).toEqual([first.message]);
});

it('keeps a thrown socket write retryable instead of aborting the description pump', async () => {
  const f = await fixture();
  f.transport.failure = new Error('The operation was aborted');
  await expect(f.pump()).resolves.toBeUndefined();
  await f.pump();
  expect(f.transport.frames.map(frame => frame.message.type)).toEqual(['tests.describe']);
  expect((await f.stored()).environmentRequest!.attempts).toBe(1);
});

it('repeats an unanswered request after a minute, preserving its id and avoiding a retry on each pump', async () => {
  const f = await fixture();
  await f.pump();
  const first = f.transport.frames[0]!.message, now = Date.now();
  vi.setSystemTime(now + 59_999); await f.pump();
  expect(f.transport.frames).toHaveLength(1);
  vi.setSystemTime(now + 60_000); await f.pump(); await f.pump();
  expect(f.transport.frames.map(frame => frame.message)).toEqual([first, first]);
  expect((await f.stored()).environmentRequest!.attempts).toBe(1);
});

it('replays the same pending request when a reconnecting hello resets delivery', async () => {
  const f = await fixture();
  await f.pump(); await f.pump();
  expect(f.transport.frames).toHaveLength(1);
  const first = f.transport.frames[0]!.message;
  f.transport.close();
  const next = f.connect();
  resetDescriptionDelivery(f.ctx);
  await f.pump();
  expect(next.frames.map(frame => frame.message)).toEqual([first]);
  expect((await f.stored()).environmentRequest!.attempts).toBe(1);
});

it('does not let a late failure of the old write clear the newer attempt', async () => {
  const f = await fixture();
  await f.pump();
  const first = f.transport.frames[0]!;
  vi.setSystemTime(Date.now() + 60_000); await f.pump();
  first.complete?.(new Error('The operation was aborted'));
  await f.pump();
  expect(f.transport.frames.map(frame => frame.message)).toEqual([first.message, first.message]);
});

it('publishes one description and one set of parts for answers to the first and repeated request', async () => {
  const f = await fixture();
  await f.pump();
  vi.setSystemTime(Date.now() + 60_000); await f.pump();
  expect(f.transport.frames).toHaveLength(2);
  const request = (await f.stored()).environmentRequest!;
  const { snapshot } = await planningEnvironment();
  const reply: TestsDescribed = { type: 'tests.described', requestId: request.requestId!, commitSha: TEST_COMMIT,
    result: { status: 'ready', description: { ...snapshot.description, repositoryScope: request.repositoryScope, runtimeCapabilities: f.runtimes } } };
  await acceptDescription(f.ctx, BUILTIN, reply);
  const stored = await f.stored(), parts = await f.db.select().from(testParts);
  expect(stored.environmentSnapshot).not.toBeNull(); expect(parts.length).toBeGreaterThan(0);
  await acceptDescription(f.ctx, BUILTIN, reply); await f.pump();
  expect(await f.stored()).toEqual(stored);
  expect(await f.db.select().from(testParts)).toEqual(parts);
  expect(f.transport.frames).toHaveLength(2);
});
