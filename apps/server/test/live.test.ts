import type { ServerMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agents, jobs, subscriptions } from '../src/db/schema.js';
import { sayLive, said } from '../src/modules/conversation/live.js';
import { BUILTIN, nodeIdentity } from '../src/modules/nodes/hub.js';
import { setUpCompany, testApp } from './helpers.js';

type Say = Extract<ServerMessage, { type: 'agent.say' }>;

async function atWork() {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [agent] = await db.select().from(agents);
  const [sub] = await db.select().from(subscriptions);
  const [run] = await db.insert(jobs).values({ companyId: agent!.companyId, subscriptionId: sub!.id, agentId: agent!.id, kind: 'conversation', prompt: 'work', timeoutMs: 1000, status: 'running' }).returning();
  vi.spyOn(app.ctx.hub, 'hasTerminals').mockReturnValue(true);
  let sent!: (message: Say) => void;
  const message = new Promise<Say>(done => (sent = done));
  const send = vi.spyOn(app.ctx.hub, 'send').mockImplementation((_node, m) => {
    if (m.type === 'agent.say') sent(m);
    return true;
  });
  return { ctx: app.ctx, agent: agent!, run: run!, send, message };
}

describe('words for a live turn', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('gives the node a relative budget independent of the server clock', async () => {
    const c = await atWork();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
    const pending = sayLive(c.ctx, c.agent.id, 'Use the new schema.');
    const message = await c.message;
    said(c.ctx, BUILTIN, message.ref, true);
    expect(await pending).toBe(c.run.id);
    expect(message).toMatchObject({ within: 10_000 });
    expect(message).not.toHaveProperty('deadline');
  });

  it('leaves at least five seconds between the node budget and the server timeout', async () => {
    const c = await atWork();
    vi.useFakeTimers();
    const done = vi.fn();
    const pending = sayLive(c.ctx, c.agent.id, 'Use the new schema.').then(done);
    const message = await c.message;
    await vi.advanceTimersByTimeAsync(14_999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toHaveBeenCalledWith(null);
    expect(15_000 - message.within).toBeGreaterThanOrEqual(5_000);
  });

  it('returns no turn on timeout and ignores a late answer for that ref', async () => {
    const c = await atWork();
    vi.useFakeTimers();
    const pending = sayLive(c.ctx, c.agent.id, 'Use the new schema.');
    const message = await c.message;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBeNull();
    said(c.ctx, BUILTIN, message.ref, true);
    expect(await pending).toBeNull();
  });

  it('rejects an answer past the deadline even before the timeout callback runs', async () => {
    const c = await atWork();
    vi.useFakeTimers();
    const pending = sayLive(c.ctx, c.agent.id, 'Use the new schema.');
    const message = await c.message;
    vi.setSystemTime(Date.now() + 15_000);
    said(c.ctx, BUILTIN, message.ref, true);
    expect(await pending).toBeNull();
  });

  it('takes only the expected node and ref, and returns no turn when it says no', async () => {
    const c = await atWork();
    const pending = sayLive(c.ctx, c.agent.id, 'Use the new schema.');
    const message = await c.message;
    said(c.ctx, nodeIdentity('another-node'), message.ref, true);
    said(c.ctx, BUILTIN, 'another-ref', true);
    said(c.ctx, BUILTIN, message.ref, false);
    expect(await pending).toBeNull();
  });

  it('returns no turn when the node could not be sent the words', async () => {
    const c = await atWork();
    c.send.mockReturnValue(false);
    expect(await sayLive(c.ctx, c.agent.id, 'Use the new schema.')).toBeNull();
  });

  it('returns no turn when sending the words throws', async () => {
    const c = await atWork();
    c.send.mockImplementation(() => { throw new Error('Socket closed.'); });
    await expect(sayLive(c.ctx, c.agent.id, 'Use the new schema.')).resolves.toBeNull();
  });
});
