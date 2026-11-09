import type { ProgramState } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, tasks } from '../src/db/schema.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { createRoute, routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { agentProgramState, checkSilentTurns } from '../src/modules/tasks/silent.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { failureCompany } from './failure-company.js';

const MIN = 60_000;
/* A working task with its required route, and a turn that carries the wake state a real assignment leaves. */
async function taskTurn(c: Awaited<ReturnType<typeof failureCompany>>) {
  const [task] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 1, title: 'Checkout', status: 'working', assigneeAgentId: c.agent.id }).returning();
  await c.db.transaction(tx => createRoute(tx, task!, {}));
  const taskWake = taskWakeOf(task!, { why: 'go_on' }, routeSnapshot(await routeOf(c.db, task!), task!.assigneeAgentId));
  const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, taskId: task!.id, prompt: 'Work', createdBy: null, message: { personId: null, text: 'Work', taskWake } });
  return { task, id };
}
describe('silence measured by signs of life', () => {
  it.each(['done', 'cancelled'] as const)('stops silent work on a %s task before it can call Operations', async status => {
    const c = await failureCompany();
    const { task, id } = await taskTurn(c);
    const now = Date.now();
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'thinking', since: now - 31 * MIN, screenAt: now, signAt: now - 31 * MIN }, new Date(now));
    await c.db.update(tasks).set({ status, closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, task!.id));
    await checkSilentTurns(c.ctx, new Date(now));
    expect(await c.jobOf(id)).toMatchObject({ status: 'failed', error: 'stale' });
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
    expect(c.sent.mock.calls).toContainEqual([BUILTIN, { type: 'job.cancel', jobId: id }]);
    expect((await c.log(task!.id)).filter(e => e.kind === 'wake_skipped')).toHaveLength(1);
  });

  it('keeps the last program evidence and redacted 200-line tail when running work becomes stale', async () => {
    const c = await failureCompany();
    const { task, id } = await taskTurn(c);
    const now = Date.now();
    const signAt = now - 121 * MIN;
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.program', jobId: id, state: 'tool', tool: 'Bash', since: signAt - MIN, screenAt: now, signAt }, new Date(now));
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, task!.id));
    await checkSilentTurns(c.ctx, new Date(now));

    const stale = await c.jobOf(id);
    expect(stale).toMatchObject({ status: 'failed', error: 'stale', tail: 'No output.', failure: { kind: 'unknown', retryable: false } });
    expect(stale.failure!.text).toContain('Program state: tool (Bash)');
    expect(stale.failure!.text).toContain(`Last sign of life: ${new Date(signAt).toISOString()}`);
    expect(stale.result).toBe(stale.failure!.text);
    expect(stale.result).not.toContain('Wake-up became obsolete');

    const lines = Array.from({ length: 205 }, (_, i) => `line ${i + 1}`);
    lines[204] = 'last [hidden] line';
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId: id, ok: false, sessionId: 'session', result: 'Stopped.', tail: lines.join('\n'), error: 'cancelled' });

    const ended = await c.jobOf(id);
    expect(ended).toMatchObject({ status: 'failed', error: 'stale', failure: stale.failure });
    expect(ended.tail).toBe(lines.slice(-200).join('\n'));
    expect(ended.tail).not.toContain('line 1\n');
    const card = (await c.app.inject({ url: `/api/agents/${c.agent.id}`, ...c.as(c.ceo) })).json();
    expect(card.failure).toMatchObject({ text: stale.failure!.text, tail: ended.tail });
  });

  it('says when a running stale turn never reported its program state or a sign of life', async () => {
    const c = await failureCompany();
    const { task, id } = await taskTurn(c);
    const now = Date.now();
    await c.db.update(jobs).set({ startedAt: new Date(now - 31 * MIN) }).where(eq(jobs.id, id));
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, task!.id));

    await checkSilentTurns(c.ctx, new Date(now));

    const stale = await c.jobOf(id);
    expect(stale).toMatchObject({ status: 'failed', error: 'stale', tail: 'No output.' });
    expect(stale.failure!.text).toContain('Program state: no data');
    expect(stale.failure!.text).toContain('Last sign of life: no data');
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
