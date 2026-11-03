import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, jobs, people } from '../src/db/schema.js';
import { decisionPrincipal } from '../src/modules/conversation/decision-context.js';
import { appendEvent, messageForJob } from '../src/modules/events/store.js';
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
  it.each(['pending', 'agent', 'person'] as const)('does not restore an older CEO principal after %s words', async after => {
    const c = await failureCompany();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [before] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: orchestrator!.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'work', status: 'running', timeoutMs: 1000, createdBy: c.sub.ownerPersonId, answersCeo: true }).returning();
    const source = await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: before!.id, kind: 'message', personId: c.sub.ownerPersonId, data: { text: 'Approve it.' } });
    expect(await decisionPrincipal(c.db, before!.id)).toMatchObject({ personId: c.sub.ownerPersonId });
    if (after === 'pending') await c.db.update(jobs).set({ decisionInputPending: true }).where(eq(jobs.id, before!.id));
    if (after === 'agent') await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: before!.id, kind: 'message', data: { text: 'Wait for the review.', from: 'agent', by: c.head.id } });
    if (after === 'person') {
      const [person] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Zed', email: 'zed@acme.com', status: 'active', scopeKind: 'company' }).returning();
      await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: before!.id, kind: 'typed', personId: person!.id, data: {} });
    }
    if (after === 'pending' || after === 'agent') expect(await decisionPrincipal(c.db, before!.id)).toBeNull();
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, before!.id));
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'turn.open', agentKey: orchestrator!.id, text: addressed('Approve it.', source.message!), queuedFrom: before!.id, ref: 'queued' });
    const next = (await c.turnsOf(orchestrator!.id)).find(j => j.id !== before!.id)!;
    expect(await c.jobOf(next.id)).toMatchObject({ status: 'running' });
    expect(await decisionPrincipal(c.db, next.id)).toBeNull();
    expect(await messageForJob(c.ctx, { id: next.id, companyId: c.companyId, agentId: orchestrator!.id })).toEqual(source.message);
  });

  it.each(['person', 'agent'] as const)('keeps the queued %s author without another message or sent copy', async author => {
    const c = await failureCompany();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [before] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: orchestrator!.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'work', status: 'done', timeoutMs: 1000, finishedAt: new Date(), answersCeo: true }).returning();
    const source = await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: before!.id, kind: 'message', personId: author === 'person' ? c.sub.ownerPersonId : null, data: { text: 'Keep these words.', ...(author === 'agent' ? { from: 'agent', by: c.head.id } : {}) } });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'turn.open', agentKey: orchestrator!.id, text: addressed('Keep these words.', source.message!), queuedFrom: before!.id, ref: 'queued' });
    const next = (await c.turnsOf(orchestrator!.id)).find(j => j.id !== before!.id)!;
    expect(await c.jobOf(next.id)).toMatchObject({ createdBy: null, answersCeo: true });
    expect(await decisionPrincipal(c.db, next.id)).toEqual(author === 'person' ? { personId: c.sub.ownerPersonId, sourceSeq: expect.any(Number) } : null);
    expect(await messageForJob(c.ctx, { id: next.id, companyId: c.companyId, agentId: orchestrator!.id })).toEqual(source.message);
    const messages = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, orchestrator!.id), eq(agentEvents.kind, 'message')));
    expect(messages.filter(e => (e.data as { text?: string }).text === 'Keep these words.')).toHaveLength(1);
    expect(messages.filter(e => (e.data as { text?: string }).text === 'Words sent into the running turn were not taken by the program. They go with its next turn.')).toHaveLength(1);
    if (author === 'agent') {
      expect(await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.head.id), eq(agentEvents.kind, 'message')))).toHaveLength(1);
      expect(await c.db.select().from(agentEvents).where(and(eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->>'by' = ${c.head.id}`))).toHaveLength(1);
    }
  });

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
