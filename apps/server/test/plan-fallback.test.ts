import type { Limits } from '@hornhoof/protocol';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentChanges, agents, jobs, machines, nodes, subscriptions, tasks } from '../src/db/schema.js';
import { pump } from '../src/modules/conversation/queue.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { BUILTIN } from './builtin.js';
import { failureCompany } from './failure-company.js';
import { echelonsTurn } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
/* How long after a window starts over the waiting turns go out. */
const LIMIT_GRACE_MS = 5_000;
const usageLimit = { kind: 'usage_limit' as const, text: 'You have hit your usage limit.', retryable: false };

/* Acme's company key, which Hana, Bruno, Walt and the orchestrator run on, with Bruno at work on a task, and a plan of the
   CEO's beside it on a machine of his, which serves everyone. The clock goes only as far as a test moves it. */
async function atWork() {
  const c = await failureCompany();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  onTestFinished(() => { vi.useRealTimers(); });
  await echelonsTurn(c.db, c.companyId);
  const plan = async (label: string, provider: 'openai_api' | 'anthropic_api' = 'openai_api') =>
    (await c.db.insert(subscriptions).values({ companyId: c.companyId, provider, kind: 'api_key', targetKind: 'any', label, status: 'ready', ownerPersonId: c.sub.ownerPersonId }).returning())[0]!;
  const personal = async (label: string, provider: 'codex' | 'claude' = 'codex') => {
    const [sub] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider, kind: 'personal', label, status: 'ready', ownerPersonId: c.sub.ownerPersonId }).returning();
    const [box] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: `machine-of-${label}`, hostname: `${label.toLowerCase()}-box` }).returning();
    await c.db.insert(nodes).values({ companyId: c.companyId, machineId: box!.id, subscriptionId: sub!.id, status: 'ready', version: '0.29.2', keyHash: `key-of-${label}` });
    return sub!;
  };
  const spare = await personal('Spare');
  await c.db.update(agents).set({ model: 'claude-opus-5-5', effort: 'high' }).where(eq(agents.id, c.agent.id));
  const { task } = await createTask(c.ctx, { agentId: c.head.id }, { title: 'Checkout', brief: '', body: 'Work', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true, resultKind: 'code' });
  await wakeAll(c.ctx, [{ agentId: c.agent.id, taskId: task.id, why: 'assigned' }]);
  const first = (await c.turnsOf())[0]!;
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const agentOf = async (id: string) => (await c.db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const limits = (id: string, value: Limits) => c.db.update(subscriptions).set({ limits: value, limitsUpdatedAt: new Date() }).where(eq(subscriptions.id, id));
  const resetsAt = () => new Date(Date.now() + HOUR).toISOString();
  const full = (until = resetsAt()): Limits => ({ status: 'rejected', windows: [{ name: 'seven_day', utilization: 1, resetsAt: until }] });
  /* A turn ends as the node it went out to tells it. */
  const done = async (id: string) => {
    const [job] = await c.db.select({ nodeId: jobs.nodeId }).from(jobs).where(eq(jobs.id, id));
    await handleNodeMessage(c.ctx, job?.nodeId ? nodeIdentity(job.nodeId) : BUILTIN, { type: 'job.done', jobId: id, ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null }, new Date());
  };
  const runningOf = async (agentId: string) => (await c.db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'running'))))[0];
  const card = async (id: string) => (await c.app.inject({ url: `/api/agents/${id}`, ...c.as(c.ceo) })).json();
  const planChanges = (id: string) => c.db.select().from(agentChanges).where(and(eq(agentChanges.agentId, id), eq(agentChanges.field, 'subscription'))).orderBy(asc(agentChanges.createdAt));
  return { ...c, plan, personal, spare, task, first, orchestrator: orchestrator!, agentOf, limits, full, resetsAt, done, runningOf, card, planChanges };
}

describe('a plan at its limit', () => {
  it('moves everyone on it to a fallback with room at once, with their tasks, and their waiting turn goes out there', async () => {
    const c = await atWork();
    await c.db.update(agents).set({ model: 'claude-opus-5-5' }).where(eq(agents.id, c.orchestrator.id));
    await c.fail(c.first.id, usageLimit);

    for (const id of [c.agent.id, c.head.id, c.watcher.id, c.orchestrator.id]) expect(await c.agentOf(id)).toMatchObject({ subscriptionId: c.spare.id });
    /* The orchestrator has no role to pick a model by: another program runs it on its Default, as a move by hand does. */
    expect(await c.agentOf(c.orchestrator.id)).toMatchObject({ model: '', effort: null });
    const bruno = await c.agentOf(c.agent.id);
    expect(bruno.effort).toBeNull();
    expect(bruno.model).not.toBe('claude-opus-5-5');
    /* The work the limit cut short goes on on the fallback at once, and the task stays his. */
    expect(await c.runningOf(c.agent.id)).toMatchObject({ subscriptionId: c.spare.id, continueOf: c.first.id });
    expect((await c.db.select().from(tasks).where(eq(tasks.id, c.task.id)))[0]).toMatchObject({ assigneeAgentId: c.agent.id });
    const [until] = (await c.db.select({ limits: subscriptions.limits }).from(subscriptions).where(eq(subscriptions.id, c.sub.id)))[0]!.limits!.windows.map(w => w.resetsAt);
    expect(await c.card(c.agent.id)).toMatchObject({ subscription: { id: c.spare.id }, fallback: { home: { id: c.sub.id, label: c.sub.label }, until } });
    expect(await c.planChanges(c.agent.id)).toMatchObject([{ before: c.sub.id, after: c.spare.id, personId: null, byOrchestrator: false }]);
  });

  it('lets a turn that runs on it run on, and moves its employee once that turn ends', async () => {
    const c = await atWork();
    const [hana] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.head.id, kind: 'conversation', prompt: 'Plan the week.', timeoutMs: 60_000, status: 'running', startedAt: new Date() }).returning();
    await c.fail(c.first.id, usageLimit);

    expect(await c.runningOf(c.head.id)).toMatchObject({ id: hana!.id, subscriptionId: c.sub.id });
    expect(await c.agentOf(c.head.id)).toMatchObject({ subscriptionId: c.sub.id });
    await c.done(hana!.id);
    expect(await c.agentOf(c.head.id)).toMatchObject({ subscriptionId: c.spare.id });
  });

  it('brings everyone back between turns once its window starts over, with their own model and effort', async () => {
    const c = await atWork();
    await c.fail(c.first.id, usageLimit);
    const onSpare = (await c.runningOf(c.agent.id))!;

    await vi.advanceTimersByTimeAsync(HOUR + LIMIT_GRACE_MS + MIN);
    for (const id of [c.head.id, c.watcher.id, c.orchestrator.id]) expect(await c.agentOf(id)).toMatchObject({ subscriptionId: c.sub.id });
    /* Bruno's turn on the fallback runs on; he comes back once it ends. */
    expect(await c.agentOf(c.agent.id)).toMatchObject({ subscriptionId: c.spare.id });
    await c.done(onSpare.id);
    expect(await c.agentOf(c.agent.id)).toMatchObject({ subscriptionId: c.sub.id, model: 'claude-opus-5-5', effort: 'high' });
    expect((await c.card(c.agent.id)).fallback).toBeNull();
    expect(await c.planChanges(c.agent.id)).toMatchObject([{ before: c.sub.id, after: c.spare.id }, { before: c.spare.id, after: c.sub.id, personId: null }]);

    /* His next turn goes out on his own plan. */
    await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.spare.id, agentId: c.agent.id, kind: 'conversation', prompt: 'Go on.', timeoutMs: 60_000, status: 'queued' });
    await pump(c.ctx, c.agent.id);
    expect(await c.runningOf(c.agent.id)).toMatchObject({ subscriptionId: c.sub.id });
  });

  it('brings an employee back on the next round of the reconciler after a restart of the server lost its wake', async () => {
    const c = await atWork();
    await c.fail(c.first.id, usageLimit);
    expect(await c.agentOf(c.watcher.id)).toMatchObject({ subscriptionId: c.spare.id });
    vi.clearAllTimers();
    vi.setSystemTime(Date.now() + HOUR + LIMIT_GRACE_MS + MIN);
    const { reconcile } = await import('../src/modules/tasks/reconcile.js');
    await reconcile(c.ctx);
    expect(await c.agentOf(c.watcher.id)).toMatchObject({ subscriptionId: c.sub.id });
  });

  it('tells the orchestrator once, clearly, when no fallback has room, and spends no API key nobody named', async () => {
    const c = await atWork();
    await c.limits(c.spare.id, c.full());
    /* The orchestrator works on a key of its own, which nobody named as a fallback. */
    await c.db.update(agents).set({ subscriptionId: (await c.plan('Orchestrator key')).id }).where(eq(agents.id, c.orchestrator.id));
    await c.fail(c.first.id, usageLimit);
    for (let i = 0; i < 3; i++) for (const id of [c.agent.id, c.head.id, c.watcher.id]) await pump(c.ctx, id);

    for (const id of [c.agent.id, c.head.id, c.watcher.id]) expect(await c.agentOf(id)).toMatchObject({ subscriptionId: c.sub.id });
    const told = (await c.turnsOf(c.orchestrator.id)).filter(turn => turn.prompt.includes('no fallback plan has room'));
    expect(told).toHaveLength(1);
    expect(told[0]!.prompt).toContain(c.sub.label);
    expect(told[0]!.prompt).toMatch(/no fallback/i);
    /* It names those whose work waits: Bruno's task. Hana and Walt have nothing queued. */
    expect(told[0]!.prompt).toContain('so their work waits: Bruno.');
  });

  it('takes the fallbacks named for the plan in their order, with the model named, past one with no room', async () => {
    const c = await atWork();
    const full = await c.plan('Full key', 'anthropic_api');
    const named = await c.plan('Named key');
    await c.limits(full.id, c.full());
    await c.db.update(subscriptions).set({ fallbacks: [{ subscription: full.id, model: null }, { subscription: named.id, model: 'gpt-6-luna' }] }).where(eq(subscriptions.id, c.sub.id));
    await c.fail(c.first.id, usageLimit);

    expect(await c.agentOf(c.agent.id)).toMatchObject({ subscriptionId: named.id, model: 'gpt-6-luna' });
  });

  it('moves the workers past the share set for tasks and keeps the head, who may go on above it', async () => {
    const c = await atWork();
    await c.done(c.first.id);
    await c.db.update(subscriptions).set({ budget: 50 }).where(eq(subscriptions.id, c.sub.id));
    await c.limits(c.sub.id, { status: 'allowed', windows: [{ name: 'seven_day', utilization: 0.6, resetsAt: c.resetsAt() }] });
    for (const id of [c.agent.id, c.head.id]) await pump(c.ctx, id);

    expect(await c.agentOf(c.agent.id)).toMatchObject({ subscriptionId: c.spare.id });
    expect(await c.agentOf(c.head.id)).toMatchObject({ subscriptionId: c.sub.id });
  });

  it('leaves an employee a person moved by hand on the plan they picked', async () => {
    const c = await atWork();
    await c.fail(c.first.id, usageLimit);
    await c.done((await c.runningOf(c.agent.id))!.id);
    const picked = await c.plan('Picked key');
    const moved = await c.app.inject({ method: 'PATCH', url: `/api/agents/${c.watcher.id}`, payload: { subscription: picked.id }, ...c.as(c.ceo) });
    expect(moved.statusCode).toBe(200);
    expect((await c.card(c.watcher.id)).fallback).toBeNull();

    await vi.advanceTimersByTimeAsync(HOUR + LIMIT_GRACE_MS + MIN);
    await pump(c.ctx, c.watcher.id);
    expect(await c.agentOf(c.watcher.id)).toMatchObject({ subscriptionId: picked.id });
    expect(await c.agentOf(c.agent.id)).toMatchObject({ subscriptionId: c.sub.id });
  });
});

describe('the fallbacks of a plan', () => {
  it('are kept in the order a person gives, and shown with the plan', async () => {
    const c = await atWork();
    const key = await c.plan('Other key');
    const fallbacks = [{ subscription: c.spare.id, model: null }, { subscription: key.id, model: 'gpt-6-luna' }];
    const saved = await c.app.inject({ method: 'PATCH', url: `/api/subscriptions/${c.sub.id}`, payload: { fallbacks }, ...c.as(c.ceo) });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().subscription.fallbacks).toEqual(fallbacks);
    const list = (await c.app.inject({ url: '/api/subscriptions', ...c.as(c.ceo) })).json();
    expect(list.subscriptions.find((s: { id: string }) => s.id === c.sub.id).fallbacks).toEqual(fallbacks);
  });

  it.each([
    { name: 'the plan itself', pick: (c: Awaited<ReturnType<typeof atWork>>) => ({ subscription: c.sub.id, model: null }) },
    { name: 'a plan the company does not have', pick: () => ({ subscription: '00000000-0000-4000-8000-000000000000', model: null }) },
    { name: 'a model the plan does not run', pick: async (c: Awaited<ReturnType<typeof atWork>>) => ({ subscription: (await c.plan('Key')).id, model: 'no-such-model' }) },
  ])('refuses $name', async ({ pick }) => {
    const c = await atWork();
    const refused = await c.app.inject({ method: 'PATCH', url: `/api/subscriptions/${c.sub.id}`, payload: { fallbacks: [await pick(c)] }, ...c.as(c.ceo) });
    expect(refused.statusCode).toBe(400);
    expect((await c.db.select().from(subscriptions).where(eq(subscriptions.id, c.sub.id)))[0]!.fallbacks).toEqual([]);
  });
});
