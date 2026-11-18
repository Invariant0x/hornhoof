import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentEvents, agents, jobs, people } from '../src/db/schema.js';
import { decisionPrincipal } from '../src/modules/conversation/decision-context.js';
import { addressed } from '../src/modules/conversation/prompt.js';
import { enqueueTurn, pump } from '../src/modules/conversation/queue.js';
import { appendEvent, messageForJob } from '../src/modules/events/store.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { BUILTIN } from './builtin.js';
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
  it.each(['pending', 'person', 'unknown'] as const)('does not restore an older CEO principal after %s words', async after => {
    const c = await failureCompany();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, prompt: 'Work', createdBy: c.sub.ownerPersonId, answersCeo: true });
    const source = await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: id, kind: 'message', personId: c.sub.ownerPersonId, data: { text: 'Approve it.' } });
    expect(await decisionPrincipal(c.db, id)).toMatchObject({ personId: c.sub.ownerPersonId });
    if (after === 'pending') await c.db.update(jobs).set({ decisionInputPending: true }).where(eq(jobs.id, id));
    if (after === 'person') {
      const [person] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Zed', email: 'zed@acme.com', status: 'active', scopeKind: 'company' }).returning();
      await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: id, kind: 'typed', personId: person!.id, data: {} });
    }
    if (after === 'pending') expect(await decisionPrincipal(c.db, id)).toMatchObject({ personId: c.sub.ownerPersonId });
    const text = after === 'unknown' ? 'Words that were never saved.' : addressed('Approve it.', source.message!);
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.unheard', agentKey: orchestrator!.id, jobId: id, text });
    const next = (await c.turnsOf(orchestrator!.id)).find(j => j.id !== id)!;
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, id));
    await pump(c.ctx, orchestrator!.id);
    expect(await c.jobOf(next.id)).toMatchObject({ status: 'running' });
    expect(await decisionPrincipal(c.db, next.id)).toEqual({ personId: c.sub.ownerPersonId, sourceSeq: null });
  });

  it('keeps the CEO principal for unheard CEO words when an agent message or Hornhoof notice arrived after them', async () => {
    const c = await failureCompany();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, prompt: 'Work', createdBy: c.sub.ownerPersonId, answersCeo: true });
    const source = await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: id, kind: 'message', personId: c.sub.ownerPersonId, data: { text: 'Approve it.' } });
    await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: id, kind: 'message', data: { text: 'Wait for the review.', from: 'agent', by: c.head.id } });
    await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: id, kind: 'message', data: { text: 'Ada took an improvement into work: "Logs".' } });
    expect(await decisionPrincipal(c.db, id)).toMatchObject({ personId: c.sub.ownerPersonId });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.unheard', agentKey: orchestrator!.id, jobId: id, text: addressed('Approve it.', source.message!) });
    const next = (await c.turnsOf(orchestrator!.id)).find(j => j.id !== id)!;
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, id));
    await pump(c.ctx, orchestrator!.id);
    expect(await c.jobOf(next.id)).toMatchObject({ status: 'running' });
    expect(await decisionPrincipal(c.db, next.id)).toMatchObject({ personId: c.sub.ownerPersonId });
  });

  it('keeps the CEO and the envelope of live words without showing them twice', async () => {
    const c = await failureCompany();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, prompt: 'Work', createdBy: null });
    const source = await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: id, kind: 'message', personId: c.sub.ownerPersonId, data: { text: 'Approve it.' } });
    await c.db.update(jobs).set({ answersCeo: true }).where(eq(jobs.id, id));
    const text = addressed('Approve it.', source.message!);
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.unheard', agentKey: orchestrator!.id, jobId: id, text });
    const next = (await c.turnsOf(orchestrator!.id)).find(j => j.id !== id)!;
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, id));
    await pump(c.ctx, orchestrator!.id);
    expect(await decisionPrincipal(c.db, next.id)).toMatchObject({ personId: c.sub.ownerPersonId });
    expect(await c.jobOf(next.id)).toMatchObject({ createdBy: null, answersCeo: true });
    expect(await messageForJob(c.ctx, { id: next.id, companyId: c.companyId, agentId: orchestrator!.id })).toEqual(source.message);
    const messages = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, orchestrator!.id), eq(agentEvents.kind, 'message')));
    expect(messages.filter(e => (e.data as { text: string }).text.includes('Approve it.'))).toHaveLength(1);
  });

  it('keeps an unheard agent letter on its sender lane and in its quota only once', async () => {
    const c = await atWork();
    const source = await appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, kind: 'message', data: { text: 'Read this letter.', from: 'agent', by: c.head.id, name: c.head.name } });
    await c.send(addressed('Read this letter.', source.message!));
    const next = (await c.turnsOf()).find(j => j.id !== c.job.id)!;
    expect(await messageForJob(c.ctx, { id: next.id, companyId: c.companyId, agentId: c.agent.id })).toEqual(source.message);
    expect(await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.head.id), eq(agentEvents.kind, 'message')))).toHaveLength(1);
    expect(await c.db.select().from(agentEvents).where(and(eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->>'by' = ${c.head.id}`))).toHaveLength(1);
  });

  it('queues the exact words for the next turn and logs why in the agent window', async () => {
    const c = await atWork();
    await c.send();
    const turns = await c.turnsOf();
    const next = turns.find(t => t.prompt === TEXT);
    expect(turns.filter(t => t.prompt === TEXT)).toHaveLength(1);
    expect(next?.status).toBe('queued');
    expect((await c.events()).some(e => (e.data as { text?: string }).text === LINE)).toBe(true);
    expect(c.sent.mock.calls.some(([, m]) => m.type === 'agent.say')).toBe(false);
    /* The clock stands still, so the program's short chance to take its words never runs out here: only its word ends it. */
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId: c.job.id, ok: true, sessionId: null, result: '', tail: '', error: null, wordsWaiting: true });
    expect(await c.jobOf(next!.id)).toMatchObject({ status: 'queued' });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.words_settled', agentKey: c.agent.id, jobId: c.job.id });
    expect(await c.jobOf(next!.id)).toMatchObject({ status: 'running' });
  });

  it('ignores words reported by another node', async () => {
    const c = await atWork();
    await c.send(TEXT, new Date(), nodeIdentity('00000000-0000-4000-8000-000000000001'));
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
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.unheard', agentKey: orchestrator!.id, jobId: null, text: TEXT }, new Date());
    const [unlinked] = await c.turnsOf(orchestrator!.id);
    expect(unlinked).toMatchObject({ createdBy: null, answersCeo: false });
    expect(await decisionPrincipal(c.db, unlinked!.id)).toEqual({ personId: c.sub.ownerPersonId, sourceSeq: null });
  });

  it('keeps legacy requeues but does not infer a program operator reason from three log entries', async () => {
    const c = await atWork();
    const at = new Date('2026-11-03T10:10:00Z');
    const times = [0, 10, 20, 30].map(minutes => new Date(+at + minutes * 60_000));
    await c.send(TEXT, times[0]); await c.send(TEXT, times[1]);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
    await c.send(TEXT, times[2]); await c.send(TEXT, times[3]);
    expect(await c.turnsOf(c.watcher.id)).toEqual([]);
    expect((await c.events()).filter(event => (event.data as { text?: string }).text === LINE)).toHaveLength(4);
  });

  it('does not use wall-clock gaps between bare unheard reports as program evidence', async () => {
    const c = await atWork();
    const at = new Date('2026-11-03T10:10:00Z');
    for (const minutes of [0, 61, 62]) await c.send(TEXT, new Date(+at + minutes * 60_000));
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
    await c.send(TEXT, new Date(+at + 63 * 60_000));
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(0);
  });
});
