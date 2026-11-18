import { randomUUID } from 'node:crypto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { BUILTIN } from './builtin.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { receiveNodeMessage } from '../src/modules/nodes/lifecycle.js';
import type { SaidLoad } from '../src/modules/nodes/hub.js';
import { CHECK_LEASE_MS, LOAD_MS } from '@hornhoof/protocol';
import { agentProgramState, checkSilentTurns } from '../src/modules/tasks/silent.js';
import { checkQueueLoad, checkQueueSnapshot } from '../src/modules/nodes/check-slots.js';
import { jobs } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { TOOL_QUIET_ALARM_MS } from '@hornhoof/protocol/map';
import { failureCompany } from './failure-company.js';

describe('machine check waiting and the watchdog', () => {
  it('excludes queue time from silence and resumes alarms after a normal quiet interval', async () => {
    const c = await failureCompany();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'check', createdBy: null });
    /* The check queue reads the clock itself when a check ends: it stands still, so the end is at now to the millisecond. */
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const now = Date.now(), stale = now - 121 * 60_000;
    let loadAt = now;
    vi.spyOn(c.ctx.hub, 'loadOf').mockImplementation(() => ({ cpus: 1, load: 0, tests: 0, jobs: 1, memFree: 1e9, memTotal: 2e9, at: loadAt }));
    const request = { type: 'check.acquire' as const, id: randomUUID(), label: 'build', agentId: c.agent.id, jobId: id };
    await handleNodeMessage(c.ctx, BUILTIN, request);
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'tool', tool: 'shell', since: stale, screenAt: stale, signAt: stale }, new Date(now));
    await checkSilentTurns(c.ctx, new Date(now));
    expect(agentProgramState(c.ctx, { id }).alarm).toBeNull();
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'check.release', id: request.id });
    await checkSilentTurns(c.ctx, new Date(now));
    expect(agentProgramState(c.ctx, { id }).alarm).toBeNull();
    loadAt = now + TOOL_QUIET_ALARM_MS + 1000;
    await checkQueueLoad(c.ctx, BUILTIN);
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'tool', tool: 'shell', since: stale, screenAt: stale, signAt: stale }, new Date(loadAt));
    await checkSilentTurns(c.ctx, new Date(loadAt));
    expect(agentProgramState(c.ctx, { id }).alarm?.reason).toBe('program_stalled');
  });

  it('rejects queue ownership from another node without hiding a real stalled turn', async () => {
    const c = await failureCompany();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'check', createdBy: null });
    const request = { type: 'check.acquire' as const, id: randomUUID(), label: 'build', agentId: c.agent.id, jobId: id };
    const other = { kind: 'node' as const, nodeId: randomUUID() };
    await handleNodeMessage(c.ctx, other, request);
    expect(c.sent.mock.calls).toContainEqual([other, { type: 'check.state', id: request.id, state: 'ended', position: 0 }]);
    const now = Date.now(), stale = now - 121 * 60_000;
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'tool', tool: 'shell', since: stale, screenAt: stale, signAt: stale }, new Date(now));
    await checkSilentTurns(c.ctx, new Date(now));
    expect(agentProgramState(c.ctx, { id }).alarm?.reason).toBe('program_stalled');
  });

  it('keeps the missing-report alarm when the program has never sent its state', async () => {
    const c = await failureCompany();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'check', createdBy: null });
    const now = Date.now(), old = new Date(now - 31 * 60_000);
    await c.db.update(jobs).set({ startedAt: old, createdAt: old }).where(eq(jobs.id, id));
    vi.spyOn(c.ctx.hub, 'loadOf').mockReturnValue({ cpus: 1, load: 0, tests: 0, jobs: 1, memFree: 1e9, memTotal: 2e9, at: now });
    const request = { type: 'check.acquire' as const, id: randomUUID(), label: 'check', agentId: c.agent.id, jobId: id };
    await handleNodeMessage(c.ctx, BUILTIN, request);
    await checkSilentTurns(c.ctx, new Date(now));
    expect(agentProgramState(c.ctx, { id }).alarm?.reason).toBe('node_silent');
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'check.release', id: request.id });
    await checkSilentTurns(c.ctx, new Date(now));
    expect(agentProgramState(c.ctx, { id }).alarm?.reason).toBe('node_silent');
  });

  it('keeps missing-node alarms even while a check request is queued', async () => {
    const c = await failureCompany();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'check', createdBy: null });
    const now = Date.now(), old = now - 31 * 60_000;
    vi.spyOn(c.ctx.hub, 'loadOf').mockReturnValue({ cpus: 1, load: 0, tests: 0, jobs: 1, memFree: 1e9, memTotal: 2e9, at: now });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'check.acquire', id: randomUUID(), label: 'check', agentId: c.agent.id, jobId: id });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'tool', since: old, screenAt: old, signAt: old }, new Date(old));
    await checkSilentTurns(c.ctx, new Date(now));
    expect(agentProgramState(c.ctx, { id }).alarm?.reason).toBe('node_silent');
  });
});

/* #1060: the load of home-api waited behind its other frames and the shared pump of test runs, so the one handled was old
   while frames kept coming. The lease of a machine heard within 90 s holds; one silent for 90 s ends. */
describe('a machine check lease and the frames heard from the machine', () => {
  it('grants a slot to a machine heard just now whose last handled load is 90 s old, and ends the one of a silent machine', async () => {
    const c = await failureCompany();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'check', createdBy: null });
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const now = Date.now();
    let heard = now;
    vi.spyOn(c.ctx.hub, 'loadOf').mockReturnValue({ cpus: 10, load: 0, tests: 0, jobs: 1, memFree: 1e9, memTotal: 2e9, at: now - 90_000 });
    vi.spyOn(c.ctx.hub, 'lastSeenAt').mockImplementation(() => heard);
    const request = { type: 'check.acquire' as const, id: randomUUID(), label: 'build', agentId: c.agent.id, jobId: id };
    await handleNodeMessage(c.ctx, BUILTIN, request);
    await new Promise(done => setImmediate(done));
    /* A server that just started holds its slots for a lease, so the request waits in the queue instead of ending. */
    const states = (slot: string) => c.sent.mock.calls.map(([, m]) => m).filter(m => m.type === 'check.state' && m.id === slot).map(m => m.type === 'check.state' ? m.state : null);
    expect(states(request.id)).toEqual(['queued']);
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'check.release', id: request.id });
    heard = now - 90_000;
    const late = { ...request, id: randomUUID() };
    await handleNodeMessage(c.ctx, BUILTIN, late);
    await new Promise(done => setImmediate(done));
    expect(states(late.id)).toEqual(['ended']);
  });
});

it('accepts a fresh socket order, discards a late snapshot from its replaced socket and keeps lease IDs out of the machine reply', async () => {
  const c = await failureCompany();
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => { vi.useRealTimers(); });
  const start = Date.now();
  const machine = { cpus: 1, load: 0, memFree: 1e9, memTotal: 2e9, tests: 0, jobs: 0 };
  let stored: SaidLoad | null = null;
  vi.spyOn(c.ctx.hub, 'report').mockImplementation((_id, load) => { stored = { ...load, at: Date.now() }; });
  vi.spyOn(c.ctx.hub, 'loadOf').mockImplementation(() => stored);
  let linkId = 'old';
  vi.spyOn(c.ctx.hub, 'isCurrentLink').mockImplementation((_id, seen) => seen === linkId);
  const report = (sequence: number, ids: string[]) => ({ type: 'load' as const, ...machine, checkLeases: { sequence, ids } });
  const receive = (sequence: number, ids: string[]) => receiveNodeMessage(c.ctx, BUILTIN, report(sequence, ids), { linkId, receivedAt: Date.now() });
  const a = randomUUID(), b = randomUUID();
  await receive(99, []);
  vi.setSystemTime(start + CHECK_LEASE_MS + 1);
  await receive(100, []);
  await handleNodeMessage(c.ctx, BUILTIN, { type: 'check.acquire', id: a, label: 'build' });
  await handleNodeMessage(c.ctx, BUILTIN, { type: 'check.acquire', id: b, label: 'lint' });
  const holds = () => checkQueueSnapshot(c.ctx, BUILTIN)?.holders.map(entry => entry.request.id);
  expect(holds()).toEqual([a]);

  vi.setSystemTime(Date.now() + LOAD_MS + 2);
  const previous = { linkId, receivedAt: Date.now() - 1 };
  linkId = 'new';
  await receive(1, [a, b]);
  // Its handler may have started before the socket was replaced and finish after the new socket reported.
  await handleNodeMessage(c.ctx, BUILTIN, report(101, []), new Date(), previous);
  expect(holds()).toEqual([a]);

  const response = await c.app.inject({ url: '/api/machines', ...c.as(c.ceo) });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ builtin: { load: machine } });
  expect(response.body).not.toContain('checkLeases');
  expect(response.body).not.toContain(a);
  expect(response.body).not.toContain(b);

  await receive(2, [b]);
  expect(holds()).toEqual([b]);
});
