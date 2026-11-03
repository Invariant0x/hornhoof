import type { ProgramState } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, tasks } from '../src/db/schema.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { agentProgramState, checkSilentTurns } from '../src/modules/tasks/silent.js';
import { failureCompany } from './failure-company.js';

const MIN = 60_000;
describe('silence measured by signs of life', () => {
  it.each(['done', 'cancelled'] as const)('stops silent work on a %s task before it can call Operations', async status => {
    const c = await failureCompany();
    const [task] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 1, title: 'Checkout', status: 'working', assigneeAgentId: c.agent.id }).returning();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, taskId: task!.id, prompt: 'Work', createdBy: null });
    const now = Date.now();
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'thinking', since: now - 31 * MIN, screenAt: now, signAt: now - 31 * MIN }, new Date(now));
    await c.db.update(tasks).set({ status, closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, task!.id));
    await checkSilentTurns(c.ctx, new Date(now));
    expect(await c.jobOf(id)).toMatchObject({ status: 'failed', error: 'stale' });
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
    expect(c.sent.mock.calls).toContainEqual([BUILTIN, { type: 'job.cancel', jobId: id }]);
    expect((await c.log(task!.id)).filter(e => e.kind === 'wake_skipped')).toHaveLength(1);
  });

  it.each<[ProgramState, number]>([['thinking', 30], ['retrying', 30], ['idle', 30], ['tool', 120]])('%s alarms at %i minutes since the sign, even while the screen changes', async (state, minutes) => {
    const c = await failureCompany();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Work', createdBy: null });
    const signAt = Date.now();
    const report = (now: number, lastSign = signAt) => handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state, since: signAt - MIN, screenAt: now, signAt: lastSign, ...(state === 'retrying' ? { retry: { attempt: 2, max: 5, nextAt: null } } : {}), ...(state === 'tool' ? { tool: 'Bash' } : {}) }, new Date(now));
    await report(signAt + minutes * MIN - 1);
    await checkSilentTurns(c.ctx, new Date(signAt + minutes * MIN - 1));
    expect(agentProgramState(c.ctx, { id }).alarm).toBeNull();
    await report(signAt + minutes * MIN);
    await checkSilentTurns(c.ctx, new Date(signAt + minutes * MIN));
    expect(agentProgramState(c.ctx, { id }).alarm).toEqual({ reason: 'program_stalled', since: signAt });
    const notices = await c.turnsOf(c.watcher.id);
    expect(notices).toHaveLength(1);
    for (const fact of [state, new Date(signAt).toISOString(), 'Last sign', 'restart_program', 'outside any task']) expect(notices[0]!.prompt).toContain(fact);
    if (state === 'retrying') expect(notices[0]!.prompt).toContain('2 of 5');
    await checkSilentTurns(c.ctx, new Date(signAt + minutes * MIN + 1));
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
    await report(signAt + minutes * MIN + 2, signAt + minutes * MIN + 2);
    await checkSilentTurns(c.ctx, new Date(signAt + minutes * MIN + 2));
    expect(agentProgramState(c.ctx, { id }).alarm).toBeNull();
  });

  it('never calls a live node asking a person silent, even after two hours without a sign', async () => {
    const c = await failureCompany();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Work', createdBy: null });
    const now = Date.now();
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'asking', since: now - 180 * MIN, screenAt: now - 180 * MIN, signAt: now - 180 * MIN }, new Date(now));
    await checkSilentTurns(c.ctx, new Date(now));
    expect(agentProgramState(c.ctx, { id }).alarm).toBeNull();
    await checkSilentTurns(c.ctx, new Date(now + 30 * MIN));
    expect(agentProgramState(c.ctx, { id }).alarm).toEqual({ reason: 'node_silent', since: now });
  });

  it('keeps the older node screen rule exactly, including an asking state', async () => {
    const c = await failureCompany();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Work', createdBy: null });
    const now = Date.now();
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'asking', since: now - 31 * MIN, screenAt: now - 30 * MIN }, new Date(now));
    await checkSilentTurns(c.ctx, new Date(now));
    expect(agentProgramState(c.ctx, { id }).alarm).toEqual({ reason: 'program_stalled', since: now - 30 * MIN });
    expect((await c.db.select().from(jobs).where(eq(jobs.id, id)))[0]!.status).toBe('running');
  });
});
