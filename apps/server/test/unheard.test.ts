import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, jobs } from '../src/db/schema.js';
import { BUILTIN, nodeIdentity } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { failureCompany } from './failure-company.js';

const TEXT = 'From Ada to Bruno:\n\nKeep the exact words.';
const LINE = 'Words sent into the running turn were not taken by the program. They go with its next turn.';

async function atWork() {
  const c = await failureCompany();
  const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'work', status: 'running', timeoutMs: 1000 }).returning();
  const send = (text = TEXT, now = new Date(), node = BUILTIN, jobId: string | null = job!.id) => handleNodeMessage(c.ctx, node, { type: 'agent.unheard', agentKey: c.agent.id, jobId, text }, now);
  const events = () => c.db.select().from(agentEvents).where(eq(agentEvents.agentId, c.agent.id));
  return { ...c, job: job!, send, events };
}

describe('words the program never took', () => {
  it('queues the exact words for the next turn and logs why in the agent window', async () => {
    const c = await atWork();
    await c.send();
    const turns = await c.turnsOf();
    expect(turns.filter(t => t.prompt === TEXT)).toHaveLength(1);
    expect(turns.find(t => t.prompt === TEXT)?.status).toBe('queued');
    expect((await c.events()).some(e => (e.data as { text?: string }).text === LINE)).toBe(true);
    expect(c.sent.mock.calls.some(([, m]) => m.type === 'agent.say')).toBe(false);
  });

  it('ignores words reported by another node', async () => {
    const c = await atWork();
    await c.send(TEXT, new Date(), nodeIdentity('another-node'));
    expect(await c.turnsOf()).toHaveLength(1);
    expect(await c.events()).toEqual([]);
  });

  it('accepts a missing job id and ignores one belonging to another agent', async () => {
    const c = await atWork();
    const [other] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.head.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'other', status: 'done', timeoutMs: 1000 }).returning();
    await c.send('Other words.', new Date(), BUILTIN, other!.id);
    expect(await c.turnsOf()).toHaveLength(1);
    await c.send(TEXT, new Date(), BUILTIN, null);
    expect((await c.turnsOf()).filter(t => t.prompt === TEXT)).toHaveLength(1);
    expect((await c.events()).some(e => (e.data as { text?: string }).text === LINE)).toBe(true);
  });

  it('tells Operations once for three entries within an hour, with the agent, program and three times', async () => {
    const c = await atWork();
    const at = new Date('2026-11-03T10:10:00Z');
    const times = [0, 10, 20, 30].map(minutes => new Date(+at + minutes * 60_000));
    await c.send(TEXT, times[0]); await c.send(TEXT, times[1]);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
    await c.send(TEXT, times[2]); await c.send(TEXT, times[3]);
    const messages = await c.turnsOf(c.watcher.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.prompt).toContain(c.agent.name);
    expect(messages[0]!.prompt).toContain(c.sub.provider);
    for (const time of times.slice(0, 3)) expect(messages[0]!.prompt).toContain(time.toISOString());
  });

  it('does not count entries older than an hour', async () => {
    const c = await atWork();
    const at = new Date('2026-11-03T10:10:00Z');
    for (const minutes of [0, 61, 62]) await c.send(TEXT, new Date(+at + minutes * 60_000));
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
    await c.send(TEXT, new Date(+at + 63 * 60_000));
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
  });
});
