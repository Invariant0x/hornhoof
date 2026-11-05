import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { agentProgramState, checkSilentTurns } from '../src/modules/tasks/silent.js';
import { checkQueueLoad } from '../src/modules/nodes/check-slots.js';
import { jobs } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { TOOL_QUIET_ALARM_MS } from '@hornhoof/protocol/map';
import { failureCompany } from './failure-company.js';

describe('machine check waiting and the watchdog', () => {
  it('excludes queue time from silence and resumes alarms after a normal quiet interval', async () => {
    const c = await failureCompany();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'check', createdBy: null });
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
