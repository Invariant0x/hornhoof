import type { BudgetView, Limits, UsageObservation } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { jobs, subscriptions } from '../src/db/schema.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { as, setUpCompany, testApp } from './helpers.js';

const at = Date.parse('2030-01-01T00:00:00Z');
const epoch = '00000000-0000-4000-8000-000000000066';
const limits: Limits = { status: 'allowed', complete: true, windows: [{ name: 'five_hour', utilization: 0.89, resetsAt: null }, { name: 'seven_day', utilization: 0.2, resetsAt: null }] };

async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  onTestFinished(() => { vi.useRealTimers(); });
  const { app, db } = await testApp();
  const owner = await setUpCompany(app);
  const [api] = await db.select().from(subscriptions);
  const [sub] = await db.insert(subscriptions).values({ companyId: api!.companyId, ownerPersonId: api!.ownerPersonId, kind: 'personal', provider: 'kimi', status: 'ready', label: 'Usage evidence' }).returning();
  expect((await app.inject({ method: 'PATCH', url: `/api/subscriptions/${sub!.id}/budget`, payload: { budgetPercent: 90 }, ...as(owner) })).statusCode).toBe(200);
  const connection = { epoch, issuedAt: at, current: () => true };
  const observation = (seq: number, sample = limits): UsageObservation => ({ epoch, seq, sampledAt: new Date().toISOString(), source: 'usage_fetch', delivery: 'live', outcome: 'success', status: sample.status, windows: sample.windows, complete: sample.complete === true });
  const receive = (usageObservation: UsageObservation, sample = limits) => handleNodeMessage(app.ctx, { kind: 'node', subscriptionId: sub!.id }, { type: 'status', loggedIn: true, limits: sample, usageObservation }, connection);
  const view = async (id = sub!.id): Promise<BudgetView> => (await app.inject({ url: '/api/subscriptions', ...as(owner) })).json().subscriptions.find((s: { id: string }) => s.id === id).budget;
  return { app, db, sub: sub!, api: api!, receive, observation, connection, view };
}

describe('budget projection of canonical quota evidence', () => {
  it('preserves sample and receipt times per window through partial updates and restores only from complete evidence', async () => {
    const c = await fixture();
    const first = c.observation(1);
    vi.setSystemTime(at + 1000);
    await c.receive(first);
    expect(await c.view()).toMatchObject({ control: 'unavailable', freshUntil: '2030-01-01T00:10:00.000Z', decision: { reason: 'control_unavailable', quality: 'complete', sampledAt: '2030-01-01T00:00:00.000Z', receivedAt: '2030-01-01T00:00:01.000Z' } });
    vi.setSystemTime(at + 500000);
    const partial: Limits = { status: 'allowed', complete: false, windows: [{ name: 'five_hour', utilization: 0.91, resetsAt: null }] };
    await c.receive(c.observation(2, partial), partial);
    expect(await c.view()).toMatchObject({ freshUntil: '2030-01-01T00:10:00.000Z', decision: { reason: 'budget_reached', blockingWindows: [{ name: 'five_hour', sampledAt: '2030-01-01T00:08:20.000Z' }] } });
    const lower: Limits = { ...partial, windows: [{ name: 'five_hour', utilization: 0.1, resetsAt: null }] };
    await c.receive(c.observation(3, lower), lower);
    expect((await c.view()).decision.reason).toBe('budget_reached');
    vi.setSystemTime(at + 600000);
    expect(await c.view()).toMatchObject({ freshUntil: null, decision: { quality: 'stale' } });
    await c.receive(c.observation(4));
    expect((await c.view()).decision).toMatchObject({ quality: 'complete', reason: 'control_unavailable' });
  });

  it('does not refresh a custom-budget view from cached legacy data or an offline sample', async () => {
    const c = await fixture();
    const breached: Limits = { ...limits, windows: [{ name: 'five_hour', utilization: 0.91, resetsAt: null }] };
    await c.receive(c.observation(1, breached), breached);
    const before = await c.view();
    vi.setSystemTime(at + 1000);
    await c.receive({ ...c.observation(2), delivery: 'outbox' });
    await handleNodeMessage(c.app.ctx, { kind: 'node', subscriptionId: c.sub.id }, { type: 'status', loggedIn: true, limits }, c.connection);
    const after = await c.view();
    expect(after.decision).toEqual(before.decision);
    expect(after.freshUntil).toBe(before.freshUntil);
    expect(JSON.stringify(after)).not.toMatch(/epoch|seq|admissionEligible|delivery|quotaState/);
    await c.receive(c.observation(3));
    expect((await c.view()).decision).toMatchObject({ reason: 'control_unavailable', quality: 'complete', sampledAt: '2030-01-01T00:00:01.000Z' });
  });

  it('projects only checked builtin job evidence and keeps an offline completion result independently', async () => {
    const c = await fixture();
    const [job] = await c.db.insert(jobs).values({ companyId: c.api.companyId, subscriptionId: c.api.id, prompt: 'Synthetic check', timeoutMs: 1000, status: 'running', startedAt: new Date() }).returning();
    await handleNodeMessage(c.app.ctx, { kind: 'builtin' }, { type: 'job.done', jobId: job!.id, ok: false, error: 'agent_failed', sessionId: 'saved', result: 'Saved progress', tail: 'Saved diagnostic', usageObservation: { ...c.observation(1), delivery: 'outbox' } }, c.connection);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]).toMatchObject({ status: 'failed', result: 'Saved progress', sessionId: 'saved', error: 'agent_failed' });
    expect((await c.view(c.api.id)).decision).toMatchObject({ quality: 'missing', allowed: true });
    const [next] = await c.db.insert(jobs).values({ companyId: c.api.companyId, subscriptionId: c.api.id, prompt: 'Synthetic check', timeoutMs: 1000, status: 'running', startedAt: new Date() }).returning();
    await handleNodeMessage(c.app.ctx, { kind: 'builtin' }, { type: 'job.done', jobId: next!.id, ok: true, error: null, sessionId: 'saved', result: 'Saved answer', tail: '', usageObservation: c.observation(2) }, c.connection);
    expect((await c.view(c.api.id)).decision).toMatchObject({ quality: 'complete', allowed: true });
    expect((await c.view()).decision.quality).toBe('missing');
  });
});
