import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { agents, jobs, tasks, turns } from '../src/db/schema.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { BUILTIN } from './builtin.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { createRoute, routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { failureCompany } from './failure-company.js';
import { prepareSharedDatabase } from './helpers-db.js';

/* The first copy of the shared database opens as the file is collected: a cold open is no part of the first test's time. */
await prepareSharedDatabase();

async function crossingRound(atOpening = false) {
  const c = await failureCompany();
  const enqueue = (prompt: string, taskId?: string) => enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt, createdBy: null, taskId });
  const first = await enqueue('Original work.');
  const startedAt = new Date(Date.now() - 60_000);
  const openedAt = atOpening ? startedAt : new Date(Date.now() - 30_000);
  await c.db.update(jobs).set({ startedAt }).where(eq(jobs.id, first));
  await c.db.insert(turns).values({ companyId: c.companyId, departmentId: c.dev.id, number: 1, goal: 'New work.', status: 'open', openedAt });
  const done = (id: string, now = new Date()) => handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId: id, ok: true, sessionId: 'old-session', result: 'Done.', tail: '', error: null }, now);
  const sent = (id: string) => c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'job.run' && m.jobId === id);
  return { ...c, first, enqueue, done, sent };
}

describe('worker sessions across company rounds', () => {
  it.each(['crash', 'overloaded'] as const)('keeps the original %s recovery when unheard words were reported first', async kind => {
    const c = await crossingRound();
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.unheard', agentKey: c.agent.id, jobId: c.first, text: 'Missed live words.' });
    const repeated = (await c.turnsOf()).find(j => j.id !== c.first)!;
    await c.fail(c.first, { kind, retryable: kind !== 'crash', text: 'The program stopped.' });
    const recovery = (await c.turnsOf()).find(j => j.continueOf === c.first && j.id !== repeated.id);
    expect(recovery).toMatchObject({ prompt: expect.stringContaining(`The last try failed (${kind})`) });
    expect(await c.jobOf(repeated.id)).toMatchObject({ continueOf: null });
  });

  it('allows an unheard repeat its own crash continuation', async () => {
    const c = await crossingRound();
    await c.done(c.first);
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.unheard', agentKey: c.agent.id, jobId: c.first, text: 'Missed live words.' });
    const repeated = (await c.turnsOf()).find(j => j.id !== c.first)!;
    await c.fail(repeated.id, { kind: 'crash', retryable: false, text: 'The program stopped.' });
    expect((await c.turnsOf()).find(j => j.continueOf === repeated.id)).toMatchObject({ status: 'running' });
  });

  it('does not replay finished work when an unheard repeat needs new instructions', async () => {
    const c = await crossingRound();
    await c.done(c.first);
    await c.db.update(agents).set({ overrides: { base: 'Changed instructions.' } }).where(eq(agents.id, c.agent.id));
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.unheard', agentKey: c.agent.id, jobId: c.first, text: 'Missed live words.' });
    const repeated = (await c.turnsOf()).find(j => j.id !== c.first)!;
    const run = c.sent(repeated.id);
    expect(run).toMatchObject({ sessionId: null, prompt: expect.stringContaining('Missed live words.') });
    if (run?.type !== 'job.run') throw new Error('No repeated turn sent.');
    expect(run.prompt).not.toContain('The turn that ended was asked:');
    expect(run.prompt).not.toContain('Original work.');
  });

  it('keeps the original session for unheard words reported after the job finished', async () => {
    const c = await crossingRound();
    let liveText = '';
    vi.mocked(c.ctx.hub.send).mockImplementation((node, message) => {
      if (message.type === 'agent.say') {
        liveText = message.text;
        queueMicrotask(() => { void handleNodeMessage(c.ctx, node, { type: 'agent.said', ref: message.ref, ok: true }); });
      }
      return true;
    });
    const kept = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'The missed answer.', createdBy: null,
      message: { personId: null, text: 'The missed answer.', from: 'agent', by: c.head.id, name: c.head.name } });
    expect(kept).toBe(c.first);
    await c.done(c.first);
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.unheard', agentKey: c.agent.id, jobId: c.first, text: liveText });
    const repeated = (await c.turnsOf()).find(j => j.id !== c.first)!;
    expect(c.sent(repeated.id)).toMatchObject({ sessionId: 'old-session', prompt: expect.stringContaining('The missed answer.') });
  });

  it('starts a new session for a task queued by the new company round during old work', async () => {
    const c = await crossingRound();
    const follow = await c.enqueue('An answer for the running job.');
    const [task] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 33, title: 'New round task', status: 'working', assigneeAgentId: c.agent.id }).returning();
    await c.db.transaction(tx => createRoute(tx, task!, {}, developmentStages()));
    const taskWake = taskWakeOf(task!, { why: 'go_on' }, routeSnapshot(await routeOf(c.db, task!), task!.assigneeAgentId));
    const next = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'The new round task.', createdBy: null, taskId: task!.id,
      message: { personId: null, text: 'The new round task.', taskWake } });
    await c.done(c.first);
    expect(c.sent(follow)).toMatchObject({ sessionId: 'old-session' });
    await c.done(follow);
    expect(c.sent(next)).toMatchObject({ sessionId: null });
  });

  it('uses the session origin after a live follow-up ran in the new round', async () => {
    for (const atOpening of [false, true]) {
      const c = await crossingRound(atOpening);
      const follow = await c.enqueue('Words for the running job.');
      await c.done(c.first);
      expect(c.sent(follow)).toMatchObject({ sessionId: 'old-session' });
      const next = await c.enqueue('Start the new round work.');
      await c.done(follow, (await c.jobOf(next)).createdAt);
      expect(c.sent(next)).toMatchObject({ sessionId: atOpening ? 'old-session' : null });
    }
  });
});
