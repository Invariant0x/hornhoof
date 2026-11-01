import type { Limits, NodeMessage, QuotaRefusal, ServerMessage, UsageObservation } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { agents, companies, departments, jobs, requests, subscriptions, tasks } from '../src/db/schema.js';
import { pump } from '../src/modules/conversation/queue.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { createTask, submit } from '../src/modules/tasks/engine.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { setUpCompany, testApp } from './helpers.js';

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;
const full = (resetsAt: string | null): Limits => ({ status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt }], complete: true });
const epoch = '00000000-0000-4000-8000-000000000062';
const allowed: Limits = { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.1, resetsAt: null }], complete: true };

async function working(atGate = false) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  onTestFinished(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const companyId = company!.id;
  const [initial] = await db.select().from(subscriptions);
  const [sub] = await db.insert(subscriptions).values({ companyId, kind: 'personal', provider: 'kimi', label: 'Synthetic Kimi plan', ownerPersonId: initial!.ownerPersonId, status: 'ready', nodeVersion: '0.5.0' }).returning();
  const [department] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, departmentId: department!.id, name, kind, roleKey, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const executor = await hire('Bruno', 'worker', 'DEV-BE');
  const reviewer = await hire('Rita', 'worker', atGate ? 'DEV-SEC' : 'DEV-REV');
  if (atGate) await hire('Rex', 'worker', 'DEV-SEC');
  const worker = atGate ? reviewer : executor;
  const ctx = app.ctx;
  const starts: JobRun[] = [];
  vi.spyOn(ctx.hub, 'isReady').mockReturnValue(true);
  vi.spyOn(ctx.hub, 'send').mockImplementation((_node, message) => {
    if (message.type === 'job.run' && message.workspace?.key === worker.id) starts.push(message);
    return true;
  });
  const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Preserve work', brief: 'Synthetic task', body: 'Keep the work and pending review.', departmentId: department!.id, assigneeAgentId: executor.id, executor: true, gates: [reviewer.id] });
  const connection = { epoch, issuedAt: Date.now(), current: () => true };
  const receive = (message: NodeMessage) => handleNodeMessage(ctx, identityOf(sub!), message, connection);
  let seq = 0;
  const observe = (limits: Limits, changes: Partial<UsageObservation> = {}) => receive({ type: 'status', loggedIn: true, limits, usageObservation: { epoch, seq: ++seq, sampledAt: new Date().toISOString(), delivery: 'live', source: 'usage_fetch', outcome: 'success', complete: limits.complete === true, status: limits.status, windows: limits.windows, ...changes } as UsageObservation });
  const finish = async (error: Extract<NodeMessage, { type: 'job.done' }>['error'] = 'agent_failed', tail = 'Synthetic failure', quotaRefusal?: QuotaRefusal) => {
    const [job] = await db.select().from(jobs).where(and(eq(jobs.agentId, worker.id), eq(jobs.status, 'running')));
    expect(job).toBeDefined();
    await receive({ type: 'job.done', jobId: job!.id, ok: false, sessionId: 'synthetic-session', result: '', tail, error, ...(quotaRefusal ? { quotaRefusal } : {}) });
    return job!.id;
  };
  const wakes = atGate ? (await submit(ctx, executor.id, task.id, { summary: 'Synthetic submission', evidence: 'Fixture work complete' })).wakes : [{ agentId: worker.id, taskId: task.id, why: 'assigned' as const }];
  await wakeAll(ctx, wakes);
  await finish();
  await finish();
  const readTask = async () => (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!;
  expect((await readTask()).silent).toBe(2);
  expect(starts).toHaveLength(3);
  return { app, db, ctx, sub: sub!, worker, task, receive, observe, finish, readTask, starts, connection };
}

describe('quota waiting through node completion and the task queue', () => {
  it('preserves the two earlier failures and the pending gate while a known reset is still ahead', async () => {
    const c = await working();
    const before = await c.readTask();
    const limits = full('2030-01-01T01:00:00Z');
    await c.observe(limits);
    await c.finish();
    expect(await c.readTask()).toEqual(before);
    expect(await c.db.select().from(requests)).toEqual([]);
    await pump(c.ctx, c.worker.id);
    await pump(c.ctx, c.worker.id);
    expect(c.starts).toHaveLength(3);
    const waiting = await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.worker.id), eq(jobs.status, 'queued')));
    expect(waiting.map(j => j.taskId)).toEqual([c.task.id]);
  });

  it('waits on an explicit refusal with no known reset instead of turning silent two into stuck three', async () => {
    const c = await working();
    const before = await c.readTask();
    await c.observe(full(null));
    await c.finish();
    expect(await c.readTask()).toEqual(before);
    expect(await c.db.select().from(requests)).toEqual([]);
    expect(c.starts).toHaveLength(3);
  });

  it('requires confirmed recovery after the reported reset and then starts the same waiting work once', async () => {
    const c = await working();
    const before = await c.readTask();
    await c.observe(full('2030-01-01T01:00:00Z'));
    await c.finish();
    const [waiting] = await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.worker.id), eq(jobs.status, 'queued')));
    vi.setSystemTime(new Date('2030-01-01T01:00:06Z'));
    await pump(c.ctx, c.worker.id);
    expect(c.starts).toHaveLength(3);
    expect(await c.readTask()).toEqual(before);
    await c.observe(allowed);
    await pump(c.ctx, c.worker.id);
    expect(c.starts).toHaveLength(4);
    expect(c.starts[3]!.jobId).toBe(waiting!.id);
    expect(await c.db.select().from(requests)).toEqual([]);
  });

  it('does not let cached, replayed, partial or invalid-clock samples clear a known hold', async () => {
    const c = await working();
    await c.observe(full('2030-01-01T01:00:00Z'));
    await c.finish();
    vi.setSystemTime(new Date('2030-01-01T01:00:06Z'));
    await c.receive({ type: 'status', loggedIn: true, limits: allowed });
    const invalid: Partial<UsageObservation>[] = [
      { epoch: null }, { epoch: '00000000-0000-4000-8000-000000000063' },
      { seq: 1 }, { delivery: 'outbox' }, { complete: false },
      { sampledAt: '2030-01-01T00:00:00Z' }, { sampledAt: '2030-01-01T02:00:00Z' },
    ];
    for (const change of invalid) {
      await c.observe(allowed, change);
      expect(c.starts).toHaveLength(3);
    }
    c.connection.current = () => false;
    await c.observe(allowed);
    expect(c.starts).toHaveLength(3);
    c.connection.current = () => true;
    await c.observe(allowed);
    await pump(c.ctx, c.worker.id);
    expect(c.starts).toHaveLength(4);
  });

  it('retains a current-job refusal, session and prior failures until fresh recovery', async () => {
    const c = await working();
    const before = await c.readTask();
    const quotaRefusal: QuotaRefusal = { kind: 'provider_quota', provider: 'kimi', epoch, seq: 1, delivery: 'live', observedAt: new Date().toISOString(), source: { format: 'kimi_wire', version: 'synthetic' }, native: { sessionId: 'synthetic-session', turnId: '3', cursor: { start: 100, end: 200 } } };
    const id = await c.finish('agent_failed', 'Preserved diagnostic output', quotaRefusal);
    expect(await c.readTask()).toEqual(before);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, id)))[0]).toMatchObject({ status: 'failed', sessionId: 'synthetic-session', error: 'agent_failed', tail: 'Preserved diagnostic output', quotaRefusal });
    expect(await c.db.select().from(requests)).toEqual([]);
    vi.setSystemTime(new Date('2030-01-01T00:00:01Z'));
    await c.observe(allowed, { seq: 2 });
    await pump(c.ctx, c.worker.id);
    expect(c.starts).toHaveLength(4);
    expect(c.starts[3]).toMatchObject({ sessionId: 'synthetic-session' });
    expect(c.starts[3]!.toolToken).not.toBe(c.starts[2]!.toolToken);
    const initialize = (token: string | null | undefined) => c.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'quota-test', version: '1' } } } });
    expect((await initialize(c.starts[2]!.toolToken)).statusCode).toBe(401);
    expect((await initialize(c.starts[3]!.toolToken)).statusCode).toBe(200);
  });

  it('keeps both mandatory security reviewers on the pending panel during quota wait', async () => {
    const c = await working(true);
    const before = await c.readTask();
    expect(before).toMatchObject({ status: 'review', stage: 1, silent: 2 });
    expect(before.panel).toHaveLength(2);
    await c.observe(full(null));
    await c.finish();
    expect(await c.readTask()).toEqual(before);
    expect(await c.db.select().from(requests)).toEqual([]);
    expect(c.starts).toHaveLength(3);
  });

  it('retains the wait after app recreation and accepts one continuation after fresh recovery', async () => {
    const c = await working();
    await c.observe(full(null));
    const completed = await c.finish();
    const before = await c.readTask();
    await c.app.close();
    const replacement = await buildApp({ db: c.db, config: c.ctx.config });
    onTestFinished(() => replacement.close());
    vi.spyOn(replacement.ctx.hub, 'isReady').mockReturnValue(true);
    vi.spyOn(replacement.ctx.hub, 'send').mockImplementation((_id, message) => {
      if (message.type === 'job.run' && message.workspace?.key === c.worker.id) c.starts.push(message);
      return true;
    });
    await pump(replacement.ctx, c.worker.id);
    expect(c.starts).toHaveLength(3);
    expect(await c.readTask()).toEqual(before);
    vi.setSystemTime(new Date('2030-01-01T00:00:01Z'));
    const connection = { epoch: '00000000-0000-4000-8000-000000000063', issuedAt: Date.now(), current: () => true };
    const status: NodeMessage = { type: 'status', loggedIn: true, limits: allowed, usageObservation: { epoch: connection.epoch, seq: 1, sampledAt: new Date().toISOString(), delivery: 'live', source: 'usage_fetch', outcome: 'success', complete: true, status: 'allowed', windows: allowed.windows } };
    await handleNodeMessage(replacement.ctx, identityOf(c.sub), status, connection);
    await handleNodeMessage(replacement.ctx, identityOf(c.sub), status, connection);
    await handleNodeMessage(replacement.ctx, identityOf(c.sub), { type: 'job.done', jobId: completed, ok: false, sessionId: 'synthetic-session', result: '', tail: 'duplicate', error: 'agent_failed' }, connection);
    await pump(replacement.ctx, c.worker.id);
    expect(c.starts).toHaveLength(4);
    expect(await c.readTask()).toEqual(before);
    expect(await c.db.select().from(requests)).toEqual([]);
  });

  it('keeps legacy rejected usage without fresh evidence on ordinary error handling', async () => {
    const c = await working();
    await c.receive({ type: 'status', loggedIn: true, limits: full(null) });
    await c.finish();
    expect(await c.readTask()).toMatchObject({ status: 'waiting', silent: 3 });
  });

  it.each([
    ['unknown error', 'agent_failed', 'Unknown failure'],
    ['generic 429', 'agent_failed', 'HTTP 429, too many requests'],
    ['authentication failure', 'not_logged_in', 'Credentials expired'],
    ['compaction alone', 'agent_failed', 'full_compaction took 122 seconds'],
  ] as const)('keeps normal escalation for %s without a quota observation', async (_name, error, tail) => {
    const c = await working();
    await c.finish(error, tail);
    expect(await c.readTask()).toMatchObject({ silent: 3, status: 'waiting', executorAgentId: c.worker.id, gates: [c.task.gates[0]] });
    expect((await c.db.select().from(requests)).map(r => ({ kind: r.kind, status: r.status }))).toEqual([{ kind: 'stuck', status: 'open' }]);
    expect(c.starts).toHaveLength(3);
  });
});
