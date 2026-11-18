import { and, eq, sql } from 'drizzle-orm';
import { UNHEARD_MS } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentEvents, agents, jobs, machines, nodes, people, subscriptions } from '../src/db/schema.js';
import { decisionPrincipal, enterPressed } from '../src/modules/conversation/decision-context.js';
import { enqueueTurn, pump } from '../src/modules/conversation/queue.js';
import { appendEvent, messageForJob } from '../src/modules/events/store.js';
import { addressed } from '../src/modules/conversation/prompt.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { BUILTIN } from './builtin.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { disconnectMachines } from '../src/modules/nodes/disconnect.js';
import { failureCompany } from './failure-company.js';
import { until } from './helpers.js';

async function queuedWords(asOrchestrator = false) {
  let c = await failureCompany();
  if (asOrchestrator) {
    const [agent] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    c = { ...c, agent: agent! };
  }
  const [before] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'work', status: 'done', timeoutMs: 1000, finishedAt: new Date() }).returning();
  const event = await appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId: before!.id, kind: 'message', data: { text: 'Keep these words.' } });
  const open = (text = addressed('Keep these words.', event.message!), node = BUILTIN) => handleNodeMessage(c.ctx, node, { type: 'turn.open', agentKey: c.agent.id, text, queuedFrom: before!.id, ref: 'queued' });
  /* The wait for a program's queued words runs out only when a test moves this clock. */
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  return { ...c, before: before!, open };
}

async function waitingWords(asOrchestrator = false) {
  const c = await queuedWords(asOrchestrator);
  await c.db.update(jobs).set({ status: 'running', finishedAt: null }).where(eq(jobs.id, c.before.id));
  const next = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Turn B.', createdBy: null });
  const done = (jobId = c.before.id, wordsWaiting: boolean | undefined = true) => handleNodeMessage(c.ctx, BUILTIN, {
    type: 'job.done', jobId, ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null,
    ...(wordsWaiting === undefined ? {} : { wordsWaiting }),
  });
  return { ...c, next, done };
}

async function personalWaitingWords() {
  const c = await queuedWords();
  await c.db.update(subscriptions).set({ kind: 'personal', provider: 'claude' }).where(eq(subscriptions.id, c.sub.id));
  const makeNode = async (name: string) => {
    const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: name }).returning();
    const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: c.sub.id, status: 'ready', keyHash: name, version: '0.6.0' }).returning();
    return { machine: machine!, node: node!, identity: nodeIdentity(node!.id) };
  };
  const first = await makeNode('first');
  const second = await makeNode('second');
  await c.db.update(agents).set({ nodeId: first.node.id }).where(eq(agents.id, c.agent.id));
  await c.db.update(jobs).set({ status: 'running', finishedAt: null, nodeId: first.node.id }).where(eq(jobs.id, c.before.id));
  const next = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Turn B.', createdBy: null });
  await handleNodeMessage(c.ctx, first.identity, { type: 'job.done', jobId: c.before.id, ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null, wordsWaiting: true });
  return { ...c, first, second, next };
}

describe('a program starts a turn with its queued live words', () => {
  afterEach(() => vi.useRealTimers());

  it('sends B when pumping past the word deadline', async () => {
    const c = await waitingWords();
    await c.done();
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    try {
      await pump(c.ctx, c.agent.id);
      expect(await c.jobOf(c.next)).toMatchObject({ status: 'running' });
      await c.open();
      const opened = c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'turn.opened');
      expect(opened).toMatchObject({ jobId: null });
    } finally { clock.mockRestore(); }
  });

  it('releases B only when its node settles the original job words', async () => {
    const c = await waitingWords();
    await c.done();
    const settled = { type: 'agent.words_settled' as const, agentKey: c.agent.id, jobId: c.before.id };
    await handleNodeMessage(c.ctx, nodeIdentity('00000000-0000-4000-8000-000000000001'), settled);
    await handleNodeMessage(c.ctx, BUILTIN, { ...settled, jobId: c.next });
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
    await handleNodeMessage(c.ctx, BUILTIN, settled);
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'running' });
    await handleNodeMessage(c.ctx, BUILTIN, settled);
    expect(c.sent.mock.calls.filter(([, m]) => m.type === 'job.run' && m.jobId === c.next)).toHaveLength(1);
  });

  it('does not settle a running job before its later words arrive', async () => {
    const c = await waitingWords();
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.words_settled', agentKey: c.agent.id, jobId: c.before.id });
    await c.done();
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
  });

  it.each(['opened', 'unheard'])('keeps B waiting when only the first of two words is %s', async first => {
    const c = await waitingWords();
    await appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId: c.before.id, kind: 'message', data: { text: 'More waiting words.' } });
    await c.done();
    if (first === 'opened') {
      await c.open();
      const opened = c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'turn.opened');
      if (opened?.type !== 'turn.opened' || !opened.jobId) throw new Error('No queued turn opened.');
      await c.done(opened.jobId, false);
    } else {
      await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.unheard', agentKey: c.agent.id, jobId: c.before.id, text: 'Keep these words.' });
    }
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.words_settled', agentKey: c.agent.id, jobId: c.before.id });
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'running' });
  });

  it('holds B after the old job ends, opens queued words, then sends B after their answer', async () => {
    const c = await waitingWords();
    await c.done();
    expect(await c.jobOf(c.before.id)).toMatchObject({ status: 'done' });
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
    await pump(c.ctx, c.agent.id);
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
    await c.open();
    const opened = c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'turn.opened');
    if (opened?.type !== 'turn.opened' || !opened.jobId) throw new Error('No queued turn opened.');
    expect(await c.jobOf(opened.jobId)).toMatchObject({ status: 'running' });
    await c.done(opened.jobId, false);
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.words_settled', agentKey: c.agent.id, jobId: c.before.id });
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'running' });
    expect(c.sent.mock.calls.filter(([, m]) => m.type === 'job.run' && m.jobId === c.next)).toHaveLength(1);
  });

  it('releases B at the grace deadline without a settlement message', async () => {
    const c = await waitingWords();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await c.done();
    await vi.advanceTimersByTimeAsync(UNHEARD_MS - 1);
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
    await vi.advanceTimersByTimeAsync(1);
    await until(async () => (await c.jobOf(c.next)).status === 'running');
    await vi.advanceTimersByTimeAsync(UNHEARD_MS);
    expect(c.sent.mock.calls.filter(([, m]) => m.type === 'job.run' && m.jobId === c.next)).toHaveLength(1);
  });

  it('clears the word wait when the node says hello again', async () => {
    const c = await waitingWords();
    await c.done();
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'hello', version: '0.6.0', loggedIn: true, running: [] });
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'running' });
  });

  it.each(['disconnect', 'move'] as const)('clears the old node word wait after %s', async action => {
    const c = await personalWaitingWords();
    if (action === 'disconnect') await disconnectMachines(c.ctx, [c.first.machine.id]);
    else {
      await c.db.update(agents).set({ nodeId: c.second.node.id }).where(eq(agents.id, c.agent.id));
      await pump(c.ctx, c.agent.id);
    }
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'running', nodeId: c.second.node.id });
  });

  it('ignores malformed settlement job ids without querying a uuid column', async () => {
    const c = await waitingWords();
    await c.done();
    await expect(handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.words_settled', agentKey: c.agent.id, jobId: 'not-a-uuid' })).resolves.toBeUndefined();
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
  });

  it('accepts settlement only from the node that ran the job', async () => {
    const c = await personalWaitingWords();
    await c.db.update(jobs).set({ nodeId: c.second.node.id }).where(eq(jobs.id, c.before.id));
    await handleNodeMessage(c.ctx, c.first.identity, { type: 'agent.words_settled', agentKey: c.agent.id, jobId: c.before.id });
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
    await handleNodeMessage(c.ctx, c.second.identity, { type: 'agent.words_settled', agentKey: c.agent.id, jobId: c.before.id });
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'running' });
  });

  it('accepts unheard words from their original node after the agent moves', async () => {
    const c = await personalWaitingWords();
    await c.db.update(agents).set({ nodeId: c.second.node.id }).where(eq(agents.id, c.agent.id));
    await handleNodeMessage(c.ctx, c.first.identity, { type: 'agent.unheard', agentKey: c.agent.id, jobId: c.before.id, text: 'Returned after moving.' });
    expect((await c.turnsOf()).filter(j => j.prompt.includes('Returned after moving.'))).toHaveLength(1);
  });

  it('ignores malformed unheard job ids without querying a uuid column', async () => {
    const c = await waitingWords();
    await expect(handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.unheard', agentKey: c.agent.id, jobId: 'not-a-uuid', text: 'Ignore this.' })).resolves.toBeUndefined();
    expect(await c.turnsOf()).toHaveLength(2);
  });

  it('keeps repeated words after B and releases B on complete settlement', async () => {
    const c = await waitingWords();
    await c.done();
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.unheard', agentKey: c.agent.id, jobId: c.before.id, text: 'Keep these words.' });
    const repeated = (await c.turnsOf()).find(j => j.id !== c.before.id && j.id !== c.next)!;
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.words_settled', agentKey: c.agent.id, jobId: c.before.id });
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'running' });
    expect(repeated).toMatchObject({ status: 'queued', prompt: 'Keep these words.' });
    await c.done(c.next, false);
    expect(await c.jobOf(repeated.id)).toMatchObject({ status: 'running' });
  });

  it('waits for complete settlement when queued words open before the old end arrives', async () => {
    const c = await waitingWords();
    await c.open();
    const opened = c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'turn.opened');
    if (opened?.type !== 'turn.opened' || !opened.jobId) throw new Error('No queued turn opened.');
    await c.done();
    await c.done(opened.jobId, false);
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'agent.words_settled', agentKey: c.agent.id, jobId: c.before.id });
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'running' });
  });

  it('does not extend the wait when a node repeats job.done', async () => {
    const c = await waitingWords();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await c.done();
    await vi.advanceTimersByTimeAsync(UNHEARD_MS - 1);
    await c.done();
    await vi.advanceTimersByTimeAsync(1);
    await until(async () => (await c.jobOf(c.next)).status === 'running');
  });

  it('opens a human turn during the wait and keeps its author and answer', async () => {
    const c = await waitingWords(true);
    await c.done();
    await enterPressed(c.ctx, c.agent.id, c.sub.ownerPersonId, BUILTIN);
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'turn.open', agentKey: c.agent.id, text: 'A separate question.', ref: 'human' });
    const opened = c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'turn.opened');
    if (opened?.type !== 'turn.opened' || !opened.jobId) throw new Error('No human turn opened.');
    expect(await c.jobOf(opened.jobId)).toMatchObject({ status: 'running', createdBy: c.sub.ownerPersonId });
    expect(await decisionPrincipal(c.db, opened.jobId)).toMatchObject({ personId: c.sub.ownerPersonId });
    await c.done(opened.jobId, false);
    expect(await c.jobOf(opened.jobId)).toMatchObject({ status: 'done', result: 'Done.' });
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'queued' });
  });

  it.each([undefined, false])('sends B immediately when the old end has wordsWaiting: %s', async flag => {
    const c = await waitingWords();
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'job.done', jobId: c.before.id, ok: true, sessionId: null, result: '', tail: '', error: null, ...(flag === undefined ? {} : { wordsWaiting: flag }) });
    expect(await c.jobOf(c.next)).toMatchObject({ status: 'running' });
  });

  it.each(['pending', 'person'] as const)('does not restore an older CEO principal after %s words', async after => {
    const c = await failureCompany();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [before] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: orchestrator!.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'work', status: 'running', timeoutMs: 1000, createdBy: c.sub.ownerPersonId, answersCeo: true }).returning();
    const source = await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: before!.id, kind: 'message', personId: c.sub.ownerPersonId, data: { text: 'Approve it.' } });
    expect(await decisionPrincipal(c.db, before!.id)).toMatchObject({ personId: c.sub.ownerPersonId });
    if (after === 'pending') await c.db.update(jobs).set({ decisionInputPending: true }).where(eq(jobs.id, before!.id));
    if (after === 'person') {
      const [person] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Zed', email: 'zed@acme.com', status: 'active', scopeKind: 'company' }).returning();
      await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: before!.id, kind: 'typed', personId: person!.id, data: {} });
    }
    if (after === 'pending') expect(await decisionPrincipal(c.db, before!.id)).toMatchObject({ personId: c.sub.ownerPersonId });
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, before!.id));
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'turn.open', agentKey: orchestrator!.id, text: addressed('Approve it.', source.message!), queuedFrom: before!.id, ref: 'queued' });
    const next = (await c.turnsOf(orchestrator!.id)).find(j => j.id !== before!.id)!;
    expect(await c.jobOf(next.id)).toMatchObject({ status: 'running' });
    expect(await decisionPrincipal(c.db, next.id)).toEqual({ personId: c.sub.ownerPersonId, sourceSeq: null });
    expect(await messageForJob(c.ctx, { id: next.id, companyId: c.companyId, agentId: orchestrator!.id })).toEqual(source.message);
  });

  it('keeps the CEO principal for queued CEO words when an agent message or Hornhoof notice arrived after them', async () => {
    const c = await failureCompany();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [before] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: orchestrator!.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'work', status: 'running', timeoutMs: 1000, createdBy: c.sub.ownerPersonId, answersCeo: true }).returning();
    const source = await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: before!.id, kind: 'message', personId: c.sub.ownerPersonId, data: { text: 'Approve it.' } });
    await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: before!.id, kind: 'message', data: { text: 'Wait for the review.', from: 'agent', by: c.head.id } });
    await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: before!.id, kind: 'message', data: { text: 'Ada took an improvement into work: "Logs".' } });
    expect(await decisionPrincipal(c.db, before!.id)).toMatchObject({ personId: c.sub.ownerPersonId });
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, before!.id));
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'turn.open', agentKey: orchestrator!.id, text: addressed('Approve it.', source.message!), queuedFrom: before!.id, ref: 'queued' });
    const next = (await c.turnsOf(orchestrator!.id)).find(j => j.id !== before!.id)!;
    expect(await c.jobOf(next.id)).toMatchObject({ status: 'running' });
    expect(await decisionPrincipal(c.db, next.id)).toMatchObject({ personId: c.sub.ownerPersonId });
  });

  it.each(['person', 'agent'] as const)('keeps the queued %s author without another message or sent copy', async author => {
    const c = await failureCompany();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [before] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: orchestrator!.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'work', status: 'done', timeoutMs: 1000, finishedAt: new Date(), answersCeo: true }).returning();
    const source = await appendEvent(c.ctx, { companyId: c.companyId, agentId: orchestrator!.id, jobId: before!.id, kind: 'message', personId: author === 'person' ? c.sub.ownerPersonId : null, data: { text: 'Keep these words.', ...(author === 'agent' ? { from: 'agent', by: c.head.id } : {}) } });
    await handleNodeMessage(c.ctx, BUILTIN, { type: 'turn.open', agentKey: orchestrator!.id, text: addressed('Keep these words.', source.message!), queuedFrom: before!.id, ref: 'queued' });
    const next = (await c.turnsOf(orchestrator!.id)).find(j => j.id !== before!.id)!;
    /* Words of the person the turn answered open a turn in their name; an agent's go on as the turn they came into. */
    expect(await c.jobOf(next.id)).toMatchObject({ createdBy: author === 'person' ? c.sub.ownerPersonId : null, answersCeo: true });
    expect(await decisionPrincipal(c.db, next.id)).toEqual({ personId: c.sub.ownerPersonId, sourceSeq: null });
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

  it('opens confirmed queue entries even when the program waits past the grace period', async () => {
    const c = await queuedWords();
    await c.db.update(jobs).set({ status: 'queued', finishedAt: null }).where(eq(jobs.id, c.before.id));
    await c.open();
    expect(c.sent.mock.calls.map(([, m]) => m).at(-1)).toMatchObject({ type: 'turn.opened', jobId: null });
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.before.id));
    c.sent.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + UNHEARD_MS + 1);
    await c.open();
    const opened = c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'turn.opened');
    expect(opened).toMatchObject({ jobId: expect.any(String), toolToken: expect.any(String) });
    await c.open();
    expect(await c.turnsOf()).toHaveLength(2);
    expect(c.sent.mock.calls.map(([, m]) => m).filter(m => m.type === 'turn.opened').at(-1)).toMatchObject({ jobId: null });
  });


  it('rejects unknown words and a different node', async () => {
    const c = await queuedWords();
    await c.open('Words never sent live.');
    await c.open(undefined, nodeIdentity('other-node'));
    expect((await c.turnsOf()).length).toBe(1);
    expect(c.sent.mock.calls.map(([, m]) => m).filter(m => m.type === 'turn.opened').every(m => m.jobId === null)).toBe(true);
  });

  it('opens queued words once while the original job is still reporting its end, before another turn can be sent', async () => {
    const c = await queuedWords();
    await c.db.update(jobs).set({ status: 'running', finishedAt: null }).where(eq(jobs.id, c.before.id));
    await Promise.all([c.open(), c.open()]);
    const opened = c.sent.mock.calls.map(([, m]) => m).filter(m => m.type === 'turn.opened');
    expect(opened.filter(m => m.jobId !== null)).toHaveLength(1);
    expect(opened.filter(m => m.jobId === null)).toHaveLength(1);
  });
});
