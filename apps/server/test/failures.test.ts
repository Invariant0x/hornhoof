import type { Failure } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { agentEvents, agents, jobs, tasks } from '../src/db/schema.js';
import { decisionPrincipal } from '../src/modules/conversation/decision-context.js';
import { said } from '../src/modules/conversation/live.js';
import { enqueueTurn, GONE_ALONG, insertTurn, pump } from '../src/modules/conversation/queue.js';
import { appendEvent, messageForJob } from '../src/modules/events/store.js';
import { createTask, report } from '../src/modules/tasks/engine.js';
import { cancelJob, wakeAll } from '../src/modules/tasks/wake.js';
import { echelonsTurn } from './helpers.js';
import { failureCompany } from './failure-company.js';
import { BUILTIN } from './builtin.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { createRoute, routeOf } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { shortReason } from '../src/modules/tasks/failures.js';
import { originalPromptOf } from '../src/modules/conversation/requested-prompt.js';

const failure = (kind: Failure['kind'], retryable = true): Failure => ({ kind, retryable, text: 'The provider said no this time.' });
const MIN = 60_000;
async function atWork() {
  const c = await failureCompany();
  await echelonsTurn(c.db, c.companyId);
  const builder = await c.hire('Dana', 'worker', 'DEV-BE', c.dev.id);
  const { task } = await createTask(c.ctx, { agentId: c.head.id }, { title: 'Checkout', brief: '', body: 'Work', departmentId: c.dev.id, architectAgentId: c.agent.id, assigneeAgentId: builder.id, executor: true, resultKind: 'code' });
  await wakeAll(c.ctx, [{ agentId: c.agent.id, taskId: task.id, why: 'assigned' }]);
  return { ...c, task, first: (await c.turnsOf())[0]! };
}

describe('named turn failures', () => {
  it('does not deliver a delayed Operations failure notice after its task closes', async () => {
    const c = await atWork();
    await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.watcher.id));
    await c.fail(c.first.id, failure('refused', false));
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, c.task.id));
    await c.db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, c.watcher.id));
    const { reconcile } = await import('../src/modules/tasks/reconcile.js');
    await reconcile(c.ctx);
    await reconcile(c.ctx);
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
    expect((await c.log(c.task.id)).filter(e => e.kind === 'wake_skipped')).toHaveLength(1);
  });

  it('keeps a person and their one message when a task continuation uses the shared repeat path', async () => {
    const c = await failureCompany();
    const { task } = await createTask(c.ctx, { agentId: c.head.id }, { title: 'Checkout', brief: '', body: 'Work', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true });
    const text = 'Keep my task message and its author.';
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, taskId: task.id, prompt: text, createdBy: c.sub.ownerPersonId, message: { personId: c.sub.ownerPersonId, text, taskWake: taskWakeOf(task, { why: 'message' as Parameters<typeof taskWakeOf>[1]['why'] }, (await routeOf(c.db, task)).state) } });
    await c.fail(id);
    const retry = (await c.turnsOf()).find(j => j.continueOf === id)!;
    expect(retry).toMatchObject({ createdBy: c.sub.ownerPersonId, answersCeo: true });
    const words = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, retry.id), eq(agentEvents.kind, 'typed')));
    expect(words).toEqual([expect.objectContaining({ personId: c.sub.ownerPersonId, data: expect.objectContaining({ text, taskWake: expect.objectContaining({ why: 'message', status: 'working' }) }) })]);
    const messages = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.agent.id), eq(agentEvents.kind, 'message')));
    expect(messages.filter(e => (e.data as { text?: string }).text?.includes(text))).toHaveLength(1);
  });

  it('keeps the refreshed task wake with hidden repeated words and rejects it after the phase changes', async () => {
    const c = await atWork();
    await c.fail(c.first.id, failure('overloaded'));
    const retry = (await c.turnsOf()).find(j => j.continueOf === c.first.id)!;
    const words = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, retry.id));
    expect(words.filter(e => e.kind === 'message')).toEqual([]);
    expect(words.filter(e => e.kind === 'typed')).toEqual([expect.objectContaining({ data: expect.objectContaining({ taskWake: expect.objectContaining({ why: 'assigned', status: 'working', stage: 'architecture' }) }) })]);
    await report(c.ctx, c.agent.id, c.task.id, { done: true, summary: 'Plan the checkout change and its affected checks.' });
    await c.db.update(jobs).set({ notBefore: new Date(Date.now() - 1) }).where(eq(jobs.id, retry.id));
    await pump(c.ctx, c.agent.id);
    expect(await c.jobOf(retry.id)).toMatchObject({ status: 'obsolete', error: 'stale' });
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
  });

  it.each(['overloaded', 'refused', 'crash'] as const)('rejects a %s follow-up on a closed task before retries or Operations', async kind => {
    const c = await atWork();
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, c.task.id));
    await c.fail(c.first.id, failure(kind, kind !== 'refused'));
    expect((await c.turnsOf()).map(j => j.id)).toEqual([c.first.id]);
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
    expect(await c.turnsOf(c.head.id)).toEqual([]);
    expect((await c.log(c.task.id)).filter(e => e.kind === 'wake_skipped')).toEqual([expect.objectContaining({ data: { job: c.first.id, wake: 'continue' } })]);
  });

  it('rejects a named failure after the task was handed to another agent', async () => {
    const c = await atWork();
    await c.db.update(tasks).set({ assigneeAgentId: c.head.id, executorAgentId: c.head.id }).where(eq(tasks.id, c.task.id));
    await c.fail(c.first.id, failure('overloaded'));
    expect((await c.turnsOf()).map(j => j.id)).toEqual([c.first.id]);
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
  });

  it('keeps a pending person cancellation when a named failure arrives late', async () => {
    const c = await atWork();
    await cancelJob(c.ctx, c.first.id);
    await c.fail(c.first.id, failure('overloaded'));
    expect(await c.jobOf(c.first.id)).toMatchObject({ status: 'failed', error: 'cancelled', failure: null, result: 'Stopped.' });
    expect((await c.turnsOf()).map(j => j.id)).toEqual([c.first.id]);
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
  });

  it.each(['overloaded', 'crash'] as const)('keeps the %s orchestrator retry without a principal after live words could not be saved', async kind => {
    const c = await failureCompany();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, prompt: 'Approve this work.', createdBy: c.sub.ownerPersonId, message: { personId: c.sub.ownerPersonId, text: 'Approve this work.' } });
    expect(await decisionPrincipal(c.db, id)).toMatchObject({ personId: c.sub.ownerPersonId });
    c.sent.mockImplementation((node, m) => {
      if (m.type === 'agent.say') said(c.ctx, node, m.ref, true);
      return true;
    });
    const save = vi.spyOn(c.db, 'transaction').mockRejectedValueOnce(new Error('Message save failed.'));
    onTestFinished(() => save.mockRestore());
    await expect(enqueueTurn(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, prompt: 'Wait for the review.', createdBy: null, message: { personId: null, text: 'Wait for the review.', from: 'agent', by: c.head.id } })).rejects.toThrow('Message save failed.');
    save.mockRestore();
    expect(await c.jobOf(id)).toMatchObject({ decisionInputPending: true });
    expect(await decisionPrincipal(c.db, id)).toBeNull();

    await c.fail(id, failure(kind, kind !== 'crash'));
    const retry = (await c.turnsOf(orchestrator!.id)).find(j => j.continueOf === id)!;
    await c.db.update(jobs).set({ notBefore: new Date(Date.now() - 1) }).where(eq(jobs.id, retry.id));
    await pump(c.ctx, orchestrator!.id);
    expect(await c.jobOf(retry.id)).toMatchObject({ status: 'running' });
    expect(await decisionPrincipal(c.db, retry.id)).toEqual({ personId: c.sub.ownerPersonId, sourceSeq: null });
  });

  it.each(['overloaded', 'crash'] as const)('keeps the CEO as the principal of a %s orchestrator retry', async kind => {
    const c = await failureCompany();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, prompt: 'Approve this work.', createdBy: c.sub.ownerPersonId, message: { personId: c.sub.ownerPersonId, text: 'Approve this work.' } });
    await c.fail(id, failure(kind, kind !== 'crash'));
    const retry = (await c.turnsOf(orchestrator!.id)).find(j => j.continueOf === id)!;
    await c.db.update(jobs).set({ notBefore: new Date(Date.now() - 1) }).where(eq(jobs.id, retry.id));
    await pump(c.ctx, orchestrator!.id);
    expect(await decisionPrincipal(c.db, retry.id)).toMatchObject({ personId: c.sub.ownerPersonId });
    expect(await c.jobOf(retry.id)).toMatchObject({ createdBy: c.sub.ownerPersonId, answersCeo: true });
  });

  it('adds no second message with the prompt when a conversation without a task is retried', async () => {
    const c = await failureCompany();
    const prompt = 'Answer the person once.';
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt, createdBy: c.sub.ownerPersonId, message: { personId: c.sub.ownerPersonId, text: prompt } });
    await c.fail(id, failure('overloaded'));
    const messages = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.agent.id), eq(agentEvents.kind, 'message')));
    expect(messages.filter(e => (e.data as { text: string }).text.includes(prompt))).toHaveLength(1);
  });

  it('keeps an employee message envelope and a CEO principal across conversation retries', async () => {
    const c = await failureCompany();
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Check the logs.', createdBy: null, message: { personId: null, text: 'Check the logs.', from: 'agent', by: c.head.id, name: c.head.name } });
    const original = await messageForJob(c.ctx, { id, companyId: c.companyId, agentId: c.agent.id });
    expect(original).toMatchObject({ direction: 'in', from: { kind: 'agent', id: c.head.id } });
    await c.fail(id, failure('overloaded'));
    const retry = (await c.turnsOf()).find(j => j.continueOf === id)!;
    expect(await messageForJob(c.ctx, { id: retry.id, companyId: c.companyId, agentId: c.agent.id })).toEqual(original);

    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const silent = await insertTurn(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, prompt: '', createdBy: c.sub.ownerPersonId, answersCeo: true });
    await c.db.update(jobs).set({ status: 'running', startedAt: new Date() }).where(eq(jobs.id, silent));
    await c.fail(silent, failure('overloaded'));
    const silentRetry = (await c.turnsOf(orchestrator!.id)).find(j => j.continueOf === silent)!;
    await c.db.update(jobs).set({ notBefore: new Date(Date.now() - 1) }).where(eq(jobs.id, silentRetry.id));
    await pump(c.ctx, orchestrator!.id);
    expect(await decisionPrincipal(c.db, silentRetry.id)).toMatchObject({ personId: c.sub.ownerPersonId });

    const withNotice = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, prompt: 'Approve it.', createdBy: c.sub.ownerPersonId, message: { personId: c.sub.ownerPersonId, text: 'Approve it.' } });
    await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: withNotice, kind: 'message', data: { text: 'Checks passed.', from: 'agent', by: c.head.id } });
    await c.fail(withNotice, failure('overloaded'));
    const noticeRetry = (await c.turnsOf(orchestrator!.id)).find(j => j.continueOf === withNotice)!;
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, silentRetry.id));
    await c.db.update(jobs).set({ notBefore: new Date(Date.now() - 1) }).where(eq(jobs.id, noticeRetry.id));
    await pump(c.ctx, orchestrator!.id);
    expect(await decisionPrincipal(c.db, noticeRetry.id)).toMatchObject({ personId: c.sub.ownerPersonId });
  });

  it.each([undefined, 'network', 'refused'] as const)('checks carried tasks after %s without changing the own task follow-up', async kind => {
    const c = await atWork();
    const [carried] = await c.db.insert(tasks).values({ companyId: c.companyId, departmentId: c.dev.id, number: 2, title: 'Refunds', status: 'working', assigneeAgentId: c.agent.id, executorAgentId: c.agent.id }).returning();
    await c.db.transaction(tx => createRoute(tx, carried!, { paths: ['logic/refunds.ts'] }, developmentStages()));
    await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.agent.id, taskId: carried!.id, kind: 'conversation', prompt: 'Handle refunds', timeoutMs: 900000, status: 'done', result: GONE_ALONG, startedAt: c.first.startedAt, finishedAt: c.first.startedAt });

    await c.fail(c.first.id, kind ? failure(kind, kind !== 'refused') : undefined);

    const turns = await c.turnsOf();
    /* It goes on, and a failure does not count towards being stuck. */
    expect((await c.log(carried!.id)).some(e => e.kind === 'continued')).toBe(false);
    expect(turns.filter(j => j.taskId === carried!.id && ['queued', 'running'].includes(j.status))).toHaveLength(1);
    const own = turns.filter(j => j.taskId === c.task.id && j.id !== c.first.id);
    expect(own).toHaveLength(kind === 'refused' ? 0 : 1);
    if (kind === 'network') expect(own[0]).toMatchObject({ status: 'queued', continueOf: c.first.id, notBefore: expect.any(Date) });
    if (kind) expect((await c.log(c.task.id)).some(e => e.kind === 'continued')).toBe(false);
  });

  it.each(['overloaded', 'network', 'cut', 'rate_limited', 'tools', 'unknown'] as const)('keeps %s, records why and waits a minute before continuing', async kind => {
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

  it.each([
    { status: 'done', error: null, named: false, shown: 'none' },
    { status: 'done', error: null, named: true, shown: 'none' },
    { status: 'failed', error: 'agent_failed', named: false, shown: 'none' },
    { status: 'failed', error: 'agent_failed', named: true, shown: 'latest' },
    { status: 'failed', error: 'cancelled', named: false, shown: 'first' },
    { status: 'failed', error: 'removed', named: false, shown: 'first' },
    { status: 'failed', error: 'switched_off', named: false, shown: 'first' },
    { status: 'running', error: null, named: false, shown: 'first' },
  ] as const)('shows $shown failure after a later $status turn with error $error and named failure $named', async ({ status, error, named, shown }) => {
    const c = await atWork();
    const at = new Date();
    await c.fail(c.first.id, failure('cut'), at);
    const later = new Date(+at + 1000);
    await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.agent.id, kind: 'conversation', prompt: 'Later work', timeoutMs: 900000, status, error, failure: named ? failure('refused', false) : null, finishedAt: status === 'running' ? null : later });
    const expectedFailure = shown === 'none' ? null : { kind: shown === 'first' ? 'cut' : 'refused', text: failure('cut').text, at: shown === 'first' ? +at : +later };
    const expected = { failure: expectedFailure, retry: { attempt: 1, max: 4, at: +at + MIN, kind: 'cut' } };

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
    const { BUILTIN } = await import('./builtin.js');
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

/* When a retry reported the program's raw first-run screen as the failure reason, "The turn that ended was asked"
   must keep the original work prompt instead of the previous retry's prompt. */
describe('a retry of a retry', () => {
  const SCREEN = "    ▄▀▀▄\n   ▀▀▀▀▀▀\n  ▀▀▀▀▀▀▀▀\nWelcome to Antigravity CLI!\nChoose your color scheme:\n  > terminal\n    light\n  [Next]";
  /* A program that never took its prompt, so there is no session to go on in. An older node gave its screen as the reason. */
  const neverTook = (c: Awaited<ReturnType<typeof failureCompany>>, jobId: string, text: string, at: Date) =>
    handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId, ok: false, sessionId: null, error: 'agent_failed', tail: SCREEN, result: '', failure: { kind: 'unknown', retryable: true, text } }, at);

  it.each([
    ['the screen alone', SCREEN, null],
    ['a reason and then the screen', `The program did not show its prompt within 120 s.\n\n${SCREEN}`, 'The program did not show its prompt within 120 s.'],
  ])('says what the first try was asked, once, and a short reason without %s', async (_, text, reason) => {
    const c = await atWork();
    const clock = vi.spyOn(Date, 'now');
    onTestFinished(() => clock.mockRestore());
    const asked = (await c.jobOf(c.first.id)).requestedPrompt!;
    expect(asked).toContain('is yours to do');
    let current = c.first;
    for (const i of [1, 2, 3]) {
      await neverTook(c, current.id, text, new Date(Date.now()));
      const next = (await c.turnsOf())[i]!;
      clock.mockReturnValue(+next.notBefore!);
      await pump(c.ctx, c.agent.id);
      current = await c.jobOf(next.id);
      expect(current.status).toBe('running');
    }
    const prompt = current.prompt;
    /* What the turn was asked is the first try's work, whole, with no retry inside it. */
    const what = prompt.split('The turn that ended was asked:')[1]!.trim();
    expect(what.startsWith(asked)).toBe(true);
    expect(what).not.toContain('The last try failed');
    expect(prompt.split('The last try failed')).toHaveLength(2);
    expect(prompt).not.toContain('Welcome to Antigravity CLI');
    expect(prompt).not.toContain('▀▀');
    expect(prompt).toContain(`The last try failed (unknown): ${reason ?? 'the program gave no reason'}`);
  });

  it('goes back past a turn a node restart ran once more, to the work of the first try', async () => {
    const c = await atWork();
    const first = await c.jobOf(c.first.id);
    const turn = async (prompt: string, link: { continueOf: string } | { retryOf: string }) =>
      (await c.db.insert(jobs).values({ companyId: first.companyId, agentId: first.agentId, subscriptionId: first.subscriptionId, taskId: first.taskId, timeoutMs: first.timeoutMs, prompt, requestedPrompt: prompt, status: 'failed', ...link }).returning())[0]!;
    const retried = await turn('The last try failed (network): fetch failed', { continueOf: first.id });
    const restarted = await turn('Your last turn was cut off. Hornhoof runs it once more.\n\nThe last try failed (network): fetch failed', { retryOf: retried.id });
    expect(await originalPromptOf(c.ctx, restarted)).toBe(first.requestedPrompt);
    const after = await turn('The last try failed (unknown): The program did not show its prompt within 120 s.', { continueOf: restarted.id });
    expect(await originalPromptOf(c.ctx, after)).toBe(first.requestedPrompt);
  });

  it('says what the first try was asked once a turn a node restart ran once more fails too', async () => {
    const c = await atWork();
    const asked = (await c.jobOf(c.first.id)).requestedPrompt!;
    /* The node comes back without the turn, so Hornhoof runs it once more with a note before what it was asked. */
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'hello', version: '0.5.2', loggedIn: true, running: [] });
    await pump(c.ctx, c.agent.id);
    const restarted = (await c.turnsOf())[1]!;
    expect(restarted).toMatchObject({ retryOf: c.first.id, status: 'running' });
    expect(restarted.requestedPrompt).toContain('was cut off');
    /* That try never takes its prompt, so the next one cannot go on in its session and says what the turn was asked. */
    const clock = vi.spyOn(Date, 'now');
    onTestFinished(() => clock.mockRestore());
    await neverTook(c, restarted.id, 'The program did not show its prompt within 120 s.', new Date(Date.now()));
    const next = (await c.turnsOf())[2]!;
    clock.mockReturnValue(+next.notBefore!);
    await pump(c.ctx, c.agent.id);
    const what = (await c.jobOf(next.id)).prompt.split('The turn that ended was asked:')[1]!.trim();
    expect(what.startsWith(asked)).toBe(true);
    expect(what).not.toContain('was cut off');
  });

  it('says what a conversation outside any task was asked once, after a retry that did not go on either', async () => {
    const c = await failureCompany();
    const clock = vi.spyOn(Date, 'now');
    onTestFinished(() => clock.mockRestore());
    const asked = 'Answer the person once.';
    let current = await c.jobOf(await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: asked, createdBy: null, answersCeo: true }));
    for (const i of [1, 2]) {
      await neverTook(c, current.id, 'The program did not show its prompt within 120 s.', new Date(Date.now()));
      const next = (await c.turnsOf())[i]!;
      clock.mockReturnValue(+next.notBefore!);
      await pump(c.ctx, c.agent.id);
      current = await c.jobOf(next.id);
      expect(current.status).toBe('running');
    }
    /* The catch-up of its new session shows the conversation before; the turn itself is the retry's reason and the work. */
    expect(current.prompt.trimEnd().endsWith(`The last try failed (unknown): The program did not show its prompt within 120 s.\n\n${asked}`)).toBe(true);
    expect(current.prompt.split('The last try failed')).toHaveLength(2);
    expect(current.prompt).not.toContain('The turn that ended was asked');
  });
});

it('gives the first line of a failure as its reason, short, and none for a screen', () => {
  expect(shortReason('  The provider said   no.\nMore lines.')).toBe('The provider said no.');
  expect(shortReason(`${'a'.repeat(300)}`)).toBe('a'.repeat(300));
  expect(shortReason(`${'a'.repeat(301)}`)).toBe(`${'a'.repeat(299)}…`);
  for (const screen of ['    ▄▀▀▄\n Welcome', '╭────╮\n│ > │', '', '> terminal', '✻ Welcome to Claude Code!', 'Welcome to Antigravity CLI! ▄▀▀▄', 'Choose your color scheme: ╭────╮']) expect(shortReason(screen)).toBe('the program gave no reason');
  /* A provider's own words may start with a code, a bracket or a quote. */
  for (const reason of ['429 Resource has been exhausted', '[ERROR] stream closed', '{"error":{"code":503}}', '"model" is not available', "(no output)", "'gemini-4' is not a model", '`agy` exited with 1']) expect(shortReason(reason)).toBe(reason);
});
