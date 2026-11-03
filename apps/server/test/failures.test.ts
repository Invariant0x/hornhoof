import type { Failure } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { agentEvents, jobs, tasks } from '../src/db/schema.js';
import { enqueueTurn, insertTurn, pump } from '../src/modules/conversation/queue.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { failureCompany } from './failure-company.js';

const failure = (kind: Failure['kind'], retryable = true): Failure => ({ kind, retryable, text: 'The provider said no this time.' });
const MIN = 60_000;
async function atWork() {
  const c = await failureCompany();
  const { task } = await createTask(c.ctx, { agentId: c.head.id }, { title: 'Checkout', brief: '', body: 'Work', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true, gates: [] });
  await wakeAll(c.ctx, [{ agentId: c.agent.id, taskId: task.id, why: 'assigned' }]);
  return { ...c, task, first: (await c.turnsOf())[0]! };
}

describe('named turn failures', () => {
  it.each(['overloaded', 'network', 'cut', 'rate_limited', 'unknown'] as const)('keeps %s, records why and waits a minute before continuing', async kind => {
    const c = await atWork();
    const at = new Date();
    await c.fail(c.first.id, failure(kind), at);
    expect(await c.jobOf(c.first.id)).toMatchObject({ failure: failure(kind) });
    const next = (await c.turnsOf())[1]!;
    expect(next).toMatchObject({ status: 'queued', continueOf: c.first.id, notBefore: new Date(+at + MIN) });
    expect(next.prompt).toContain('record');
    expect((await c.log(c.task.id)).map(e => e.text).join('\n')).toContain(kind);
    expect((await c.log(c.task.id)).map(e => e.text).join('\n')).toContain(next.notBefore!.toISOString());
    const shown = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, c.first.id), eq(agentEvents.kind, 'failed')));
    expect(shown[0]!.data).toMatchObject({ failure: failure(kind) });
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
  });

  it('retries at 1, 2, 5 and 10 minutes, keeps its session, blocks the line until then and never tries a fifth time', async () => {
    const c = await atWork();
    let current = c.first;
    const clock = vi.spyOn(Date, 'now');
    onTestFinished(() => clock.mockRestore());
    for (const [i, minutes] of [1, 2, 5, 10].entries()) {
      const at = new Date(Date.now());
      await c.fail(current.id, failure('network'), at);
      const next = (await c.turnsOf())[i + 1]!;
      expect(next).toMatchObject({ status: 'queued', notBefore: new Date(+at + minutes * MIN) });
      if (i === 0) await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.agent.id, prompt: 'Later words', kind: 'conversation', timeoutMs: 900000 });
      clock.mockReturnValue(+next.notBefore! - 1);
      await pump(c.ctx, c.agent.id);
      expect((await c.turnsOf()).some(j => j.status === 'running')).toBe(false);
      clock.mockReturnValue(+next.notBefore!);
      await pump(c.ctx, c.agent.id);
      expect((await c.jobOf(next.id)).status).toBe('running');
      expect(c.sent.mock.calls.some(([, m]) => m.type === 'job.run' && m.jobId === next.id && m.sessionId === 'session')).toBe(true);
      current = await c.jobOf(next.id);
      /* Keep the unrelated turn behind this retry, without changing this chain. */
      await c.db.delete(jobs).where(and(eq(jobs.agentId, c.agent.id), eq(jobs.prompt, 'Later words')));
    }
    await c.fail(current.id, failure('network'));
    expect(await c.turnsOf()).toHaveLength(5);
    const notices = await c.turnsOf(c.watcher.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.prompt).toContain('4 retries');
    expect((await c.db.select().from(tasks).where(eq(tasks.id, c.task.id)))[0]!.assigneeAgentId).toBe(c.agent.id);
    expect((await c.log(c.task.id)).map(e => e.text).join('\n')).toContain('Operations');
  });

  it.each(['refused', 'too_big', 'unknown'] as const)('does not retry %s and tells the head and Operations once', async kind => {
    const c = await atWork();
    await c.fail(c.first.id, failure(kind, false));
    expect(await c.turnsOf()).toHaveLength(1);
    expect(await c.turnsOf(c.head.id)).toHaveLength(1);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
    await c.fail(c.first.id, failure(kind, false));
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
  });

  it('continues a failed conversation outside any task with its own prompt and a short reason', async () => {
    const c = await failureCompany();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Answer the person', createdBy: null, answersCeo: true });
    await c.fail(id, failure('overloaded'));
    expect((await c.turnsOf())[1]).toMatchObject({ continueOf: id, answersCeo: true, status: 'queued', prompt: expect.stringContaining('Answer the person') });
    expect((await c.turnsOf())[1]!.prompt).toContain('overloaded');
  });

  it('keeps the old immediate continuation when an older node names no failure', async () => {
    const c = await atWork();
    await c.fail(c.first.id);
    expect((await c.turnsOf())[1]).toMatchObject({ continueOf: c.first.id, status: 'running', notBefore: null });
  });

  it('keeps the crash continuation and quick crash stop', async () => {
    const c = await atWork();
    await c.fail(c.first.id, failure('crash', false));
    expect((await c.turnsOf())[1]).toMatchObject({ status: 'running', continueOf: c.first.id, notBefore: null });
  });

  it('holds a usage_limit with no matching text until reset and queues the continuation without calling Operations', async () => {
    const c = await atWork();
    await c.fail(c.first.id, { kind: 'usage_limit', text: 'No more tokens now.', retryable: true });
    expect((await c.turnsOf())[1]).toMatchObject({ status: 'queued', continueOf: c.first.id });
    const state = (await c.app.inject({ url: `/api/agents/${c.agent.id}`, ...c.as(c.ceo) })).json();
    expect(state.subscription.limits.status).toBe('rejected');
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
  });

  it('gives the waiting retry and latest failure in both agent APIs', async () => {
    const c = await atWork();
    const at = new Date();
    await c.fail(c.first.id, failure('cut'), at);
    const expected = { retry: { attempt: 1, max: 4, at: +at + MIN, kind: 'cut' }, failure: { kind: 'cut', text: failure('cut').text, at: +at } };
    const card = (await c.app.inject({ url: `/api/agents/${c.agent.id}`, ...c.as(c.ceo) })).json();
    expect(card).toMatchObject(expected);
    const org = (await c.app.inject({ url: '/api/org', ...c.as(c.ceo) })).json();
    expect(org.departments.find((d: { id: string }) => d.id === c.dev.id).employees.find((a: { id: string }) => a.id === c.agent.id)).toMatchObject(expected);
  });
});

describe('a delayed retry owns the line', () => {
  it('holds an older turn on another task until the retry, even for a head who combines task turns', async () => {
    const c = await atWork();
    const [other] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 2, title: 'Other work' }).returning();
    await insertTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, taskId: other!.id, prompt: 'Older queued work', createdBy: null });
    await c.fail(c.first.id, failure('network'));
    expect((await c.turnsOf()).some(j => j.status === 'running')).toBe(false);
  });

  it('keeps a passing rate limit separate from a plan usage limit, even when the words match the old pattern', async () => {
    const c = await atWork();
    const { handleNodeMessage } = await import('../src/modules/nodes/messages.js');
    const { BUILTIN } = await import('../src/modules/nodes/hub.js');
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId: c.first.id, ok: false, sessionId: 'session', result: '', tail: '429 rate limit', error: 'agent_failed', failure: failure('rate_limited') });
    const { agentState } = await import('../src/modules/conversation/queue.js');
    expect((await agentState(c.ctx, c.agent.id)).limitUntil).toBeNull();
  });
});

describe('conversation recovery', () => {
  it('continues a crash outside any task once and tells Operations if the continuation crashes too', async () => {
    const c = await failureCompany();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Answer the owner', createdBy: null });
    await c.fail(id, failure('crash', false));
    expect((await c.turnsOf())[1]).toMatchObject({ continueOf: id, status: 'running' });
    await c.fail((await c.turnsOf())[1]!.id, failure('crash', false));
    expect(await c.turnsOf()).toHaveLength(2);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
  });

  it('keeps the session id on a resumed running turn so a later safe restart can use it', async () => {
    const c = await atWork();
    await c.fail(c.first.id, failure('crash', false));
    expect((await c.turnsOf())[1]).toMatchObject({ sessionId: 'session', status: 'running' });
  });
});

describe('a refusal without an Operations watcher', () => {
  it('still tells the head when Operations is switched off', async () => {
    const c = await atWork();
    const { agents } = await import('../src/db/schema.js');
    await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.watcher.id));
    await c.fail(c.first.id, failure('refused', false));
    expect(await c.turnsOf(c.head.id)).toHaveLength(1);
    expect((await c.log(c.task.id)).map(e => e.text).join('\n')).toContain('Operations');
    await c.db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, c.watcher.id));
    const { reconcile } = await import('../src/modules/tasks/reconcile.js');
    await reconcile(c.ctx);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
    await reconcile(c.ctx);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
  });
});

describe('crash counting by kind', () => {
  it('stops after three named quick crashes', async () => {
    const c = await atWork();
    for (let i = 0; i < 3; i++) {
      const current = (await c.turnsOf())[i]!;
      expect(current.status).toBe('running');
      await c.fail(current.id, failure('crash', false));
    }
    expect(await c.turnsOf()).toHaveLength(3);
    expect((await c.turnsOf(c.head.id)).length).toBeGreaterThan(0);
  });

  it('does not count a passing failure as a quick crash', async () => {
    const c = await atWork();
    await c.fail(c.first.id, failure('network'));
    const retry = (await c.turnsOf())[1]!;
    await c.db.update(jobs).set({ notBefore: new Date(Date.now() - 1) }).where(eq(jobs.id, retry.id));
    await pump(c.ctx, c.agent.id);
    await c.fail(retry.id, failure('crash', false));
    const next = (await c.turnsOf())[2]!;
    await c.fail(next.id, failure('crash', false));
    expect((await c.turnsOf())[3]).toMatchObject({ status: 'running' });
  });
});

describe('operational facts in the task log', () => {
  it('does not count refused restart requests as turns that continued without handing work in', async () => {
    const c = await atWork();
    const { restartProgram } = await import('../src/modules/tasks/program-restarts.js');
    for (let i = 0; i < 8; i++) await restartProgram(c.ctx, c.companyId, c.agent.id);
    await c.fail(c.first.id, failure('crash', false));
    await c.fail((await c.turnsOf())[1]!.id, failure('crash', false));
    expect((await c.turnsOf())[2]).toMatchObject({ status: 'running' });
    const notices = (await c.log(c.task.id)).filter(e => e.data.job === c.first.id);
    expect(notices.every(e => e.text.includes(c.agent.name))).toBe(true);
  });
});

it('holds the whole line until the retry even when task turns were switched off meanwhile', async () => {
  const c = await atWork();
  await c.fail(c.first.id, failure('network'));
  const { agents } = await import('../src/db/schema.js');
  await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.agent.id));
  await insertTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Answer the person later', createdBy: null });
  await pump(c.ctx, c.agent.id);
  expect((await c.turnsOf()).some(j => j.status === 'running')).toBe(false);
});
