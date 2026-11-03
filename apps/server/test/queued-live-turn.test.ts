import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs } from '../src/db/schema.js';
import { appendEvent } from '../src/modules/events/store.js';
import { addressed } from '../src/modules/conversation/prompt.js';
import { BUILTIN, nodeIdentity } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { failureCompany } from './failure-company.js';

async function queuedWords() {
  const c = await failureCompany();
  const [before] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'work', status: 'done', timeoutMs: 1000, finishedAt: new Date() }).returning();
  const event = await appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId: before!.id, kind: 'message', data: { text: 'Keep these words.' } });
  const open = (text = addressed('Keep these words.', event.message!), node = BUILTIN) => handleNodeMessage(c.ctx, node, { type: 'turn.open', agentKey: c.agent.id, text, queuedFrom: before!.id, ref: 'queued' });
  return { ...c, before: before!, open };
}

describe('a program starts a turn with its queued live words', () => {
  it('opens known words without another person keystroke and accepts its Stop', async () => {
    const c = await queuedWords();
    await c.open();
    const opened = c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'turn.opened');
    expect(opened).toMatchObject({ type: 'turn.opened', ref: 'queued', jobId: expect.any(String), toolToken: expect.any(String) });
    if (opened?.type !== 'turn.opened' || !opened.jobId) throw new Error('No queued turn opened.');
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId: opened.jobId, ok: true, result: 'Done.', tail: '', sessionId: null, error: null });
    expect((await c.db.select().from(jobs).where(eq(jobs.id, opened.jobId)))[0]!.status).toBe('done');
  });

  it('rejects unknown words and a different node', async () => {
    const c = await queuedWords();
    await c.open('Words never sent live.');
    await c.open(undefined, nodeIdentity('other-node'));
    expect((await c.turnsOf()).length).toBe(1);
    expect(c.sent.mock.calls.map(([, m]) => m).filter(m => m.type === 'turn.opened').every(m => m.jobId === null)).toBe(true);
  });

  it('opens queued words while the original job is still reporting its end, before another turn can be sent', async () => {
    const c = await queuedWords();
    await c.db.update(jobs).set({ status: 'running', finishedAt: null }).where(eq(jobs.id, c.before.id));
    await c.open();
    const opened = c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'turn.opened');
    expect(opened).toMatchObject({ jobId: expect.any(String) });
  });
});
