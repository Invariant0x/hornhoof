import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { ProgramNodeMessage } from '@hornhoof/protocol/program-operator';
import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, attachments, jobs, people, programDeliveries } from '../src/db/schema.js';
import { deliverLive } from '../src/modules/conversation/decision-context.js';
import { said } from '../src/modules/conversation/live.js';
import { insertOrDeliverTurn, pump } from '../src/modules/conversation/queue.js';
import { unheard } from '../src/modules/conversation/unheard.js';
import { appendEvent } from '../src/modules/events/store.js';
import { reserveDelivery, wordsDigest } from '../src/modules/program-operator/deliveries.js';
import { reconcileOperatorFallbacks, requeueOperatorWords } from '../src/modules/program-operator/requeue.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { checkOperatorHealth } from '../src/modules/program-operator/health.js';
import { incomingEnvelope } from '../src/modules/events/parties.js';
import { addressed } from '../src/modules/conversation/prompt.js';
import { listen, mcp } from './helpers.js';
import { operatorCompany } from './program-operator-company.js';
import { stored } from './files-fixture.js';

it('durably requeues finalized live words before acknowledging evidence even when agent.unheard is lost', async () => {
  const c = await operatorCompany();
  const message = { personId: null, text: 'Preserve this comment.', notification: { source: 'comment' as const, tasks: [] } };
  c.sent.mockImplementation((node, frame) => { if (frame.type === 'agent.say') queueMicrotask(() => said(c.ctx, node, frame.ref, true)); return true; });
  await deliverLive(c.ctx, c.agent.id, message.text, { source: { data: message } }, (jobId, kept) => appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId, kind: 'message', data: message }, kept).then(() => {}));
  const live = c.sent.mock.calls.map(([, frame]) => frame).find(frame => frame.type === 'agent.say');
  if (live?.type !== 'agent.say' || !live.operatorDelivery) throw new Error('No tracked live input.');
  const fact = { type: 'program.delivery' as const, agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, deliveryId: live.operatorDelivery.id, deliveryOrdinal: live.operatorDelivery.ordinal, kind: 'live' as const, wordsDigest: (await c.db.select().from(programDeliveries).where(eq(programDeliveries.id, live.operatorDelivery.id)))[0]!.digest, elapsedMs: 0, ordinal: 0, evidenceId: randomUUID(), phase: 'attempt' as const };
  await acceptOperatorEvidence(c.ctx, c.identity, fact);
  const notTaken = { ...fact, phase: 'not_taken' as const, evidenceId: randomUUID(), ordinal: 1, elapsedMs: 100 };
  await acceptOperatorEvidence(c.ctx, c.identity, notTaken);
  const queued = (await c.turnsOf()).filter(row => row.id !== c.job.id);
  expect(queued).toHaveLength(1);
  expect(queued[0]!.prompt).toBe(live.text);
  await acceptOperatorEvidence({ ...c.ctx }, c.identity, notTaken);
  await checkOperatorHealth({ ...c.ctx });
  expect(await c.turnsOf()).toHaveLength(2);
  await acceptOperatorEvidence(c.ctx, c.identity, { ...fact, phase: 'taken', evidenceId: randomUUID(), ordinal: 2 });
  expect(await c.jobOf(queued[0]!.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
});

it('restores a missing fallback when its source event commits after the durable not-taken fact', async () => {
  const c = await operatorCompany();
  const message = { text: 'Late source.', notification: { source: 'comment' as const, tasks: [] } };
  const text = addressed(message.text, await incomingEnvelope(c.ctx, c.companyId, c.agent.id, null, message));
  const live = await reserveDelivery(c.db, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, nodeId: c.identity.nodeId, kind: 'live', words: text, reference: randomUUID() });
  const fact = { ...c.fact, deliveryId: live.id, deliveryOrdinal: live.ordinal, kind: 'live' as const, wordsDigest: (await c.db.select().from(programDeliveries).where(eq(programDeliveries.id, live.id)))[0]!.digest };
  await acceptOperatorEvidence(c.ctx, c.identity, fact);
  await acceptOperatorEvidence(c.ctx, c.identity, { ...fact, phase: 'not_taken', evidenceId: randomUUID(), ordinal: 1 });
  expect(await c.turnsOf()).toHaveLength(1);
  for (const text of [17, 'Different words.']) await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, kind: 'message', data: { text, operatorDelivery: live } });
  await checkOperatorHealth({ ...c.ctx });
  expect(await c.turnsOf()).toHaveLength(1);
  await appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, kind: 'message', data: { ...message, operatorDelivery: live } });
  await checkOperatorHealth({ ...c.ctx });
  await checkOperatorHealth({ ...c.ctx });
  expect((await c.turnsOf()).map(row => row.prompt)).toEqual(['Words.', text]);
});

it('retains the original live identity on fallback, requeues once after reconnect and gives its assignment a separate receipt clock', async () => {
  const c = await operatorCompany();
  const message = { personId: null, text: 'Keep these exact words.', from: 'agent' as const, by: c.head.id, name: c.head.name };
  c.sent.mockImplementation((node, frame) => { if (frame.type === 'agent.say') queueMicrotask(() => said(c.ctx, node, frame.ref, true)); return true; });
  await deliverLive(c.ctx, c.agent.id, message.text, { source: { data: message } }, (jobId, kept) => appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId, kind: 'message', data: message }, kept).then(() => {}));
  const live = c.sent.mock.calls.map(([, frame]) => frame).find(frame => frame.type === 'agent.say');
  if (live?.type !== 'agent.say' || !live.operatorDelivery) throw new Error('No tracked live input.');
  const [delivery] = await c.db.select().from(programDeliveries).where(eq(programDeliveries.id, live.operatorDelivery.id));
  const fact = { type: 'program.delivery' as const, agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, deliveryId: delivery!.id, deliveryOrdinal: delivery!.ordinal, kind: 'live' as const, wordsDigest: delivery!.digest, elapsedMs: 100, ordinal: 0, evidenceId: randomUUID(), phase: 'attempt' as const };
  await acceptOperatorEvidence(c.ctx, c.identity, fact);
  await acceptOperatorEvidence(c.ctx, c.identity, { ...fact, evidenceId: randomUUID(), ordinal: 1, phase: 'not_taken', elapsedMs: 200 });
  const report: Extract<ProgramNodeMessage, { type: 'agent.unheard' }> = { type: 'agent.unheard', agentKey: c.agent.id, jobId: c.job.id, text: live.text, operatorDelivery: live.operatorDelivery };
  await unheard(c.ctx, c.identity, report, new Date());
  await unheard({ ...c.ctx }, c.identity, report, new Date());
  const queued = (await c.turnsOf()).filter(job => job.id !== c.job.id);
  expect(queued).toHaveLength(1);
  expect(queued[0]!.prompt).toBe(live.text);
  const [hidden] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, queued[0]!.id), eq(agentEvents.kind, 'typed')));
  expect(hidden!.data).toMatchObject({ operatorDelivery: live.operatorDelivery });
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  await pump(c.ctx, c.agent.id);
  const assignments = await c.db.select().from(programDeliveries).where(eq(programDeliveries.jobId, queued[0]!.id));
  expect(assignments).toHaveLength(1);
  expect(assignments[0]).toMatchObject({ kind: 'assignment', sourceDeliveryId: delivery!.id, attemptedAt: null });
  expect(assignments[0]!.id).not.toBe(delivery!.id);
});

it('does not turn three bare unheard reports into a second Operations alarm', async () => {
  const c = await operatorCompany();
  for (let i = 0; i < 3; i++) await unheard(c.ctx, c.identity, { type: 'agent.unheard', agentKey: c.agent.id, jobId: c.job.id, text: `Words ${i}.` }, new Date());
  expect(await c.turnsOf(c.watcher.id)).toEqual([]);
});


it('handles invalid tracked fallback reports without creating words for another delivery or recipient', async () => {
  const c = await operatorCompany();
  const report = { type: 'agent.unheard' as const, agentKey: c.agent.id, jobId: c.job.id, text: 'Words.', operatorDelivery: c.delivery };
  expect(await requeueOperatorWords(c.ctx, c.identity, { ...report, operatorDelivery: undefined }, new Date())).toBe(false);
  expect(await requeueOperatorWords(c.ctx, c.identity, { ...report, operatorDelivery: { id: 'invalid', ordinal: 0 } }, new Date())).toBe(true);
  const live = await reserveDelivery(c.ctx.db, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, nodeId: c.identity.nodeId, kind: 'live', words: report.text, reference: randomUUID() });
  for (const altered of [{ ...report }, { ...report, operatorDelivery: { ...live, ordinal: 999 } }, { ...report, operatorDelivery: live, text: 'Other words.' }, { ...report, operatorDelivery: live, agentKey: c.head.id }]) {
    expect(await requeueOperatorWords(c.ctx, c.identity, altered, new Date())).toBe(true);
  }
  expect(await c.turnsOf()).toHaveLength(1);
});

it('cancels an unsent fallback when the original live delivery was taken and never queues it again', async () => {
  const c = await operatorCompany();
  const live = await reserveDelivery(c.ctx.db, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, nodeId: c.identity.nodeId, kind: 'live', words: 'Words.', reference: randomUUID() });
  const [fallback] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, nodeId: c.identity.nodeId, kind: 'conversation', prompt: 'Words.', timeoutMs: 1000, status: 'queued' }).returning();
  await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.agent.id, jobId: fallback!.id, kind: 'typed', data: { operatorFallback: live.id } });
  await c.db.update(programDeliveries).set({ outcome: 'taken' }).where(eq(programDeliveries.id, live.id));
  const report = { type: 'agent.unheard' as const, agentKey: c.agent.id, jobId: c.job.id, text: 'Words.', operatorDelivery: live };
  await requeueOperatorWords(c.ctx, c.identity, report, new Date());
  await requeueOperatorWords(c.ctx, c.identity, report, new Date());
  expect(await c.jobOf(fallback!.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
  expect(await c.turnsOf()).toHaveLength(2);
});

describe('words of a message that went into a running turn', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

  /* A message as each sender writes it, through the way each one writes. Each says what it adds to the words it shows. */
  async function sent(c: Awaited<ReturnType<typeof operatorCompany>>, how: 'person' | 'picture' | 'employee') {
    c.sent.mockImplementation((node, frame) => { if (frame.type === 'agent.say') queueMicrotask(() => said(c.ctx, node, frame.ref, true)); return true; });
    if (how === 'employee') {
      const token = 'tool-token-requeue-0123456789abcdef';
      await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.head.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Lead.', status: 'running', startedAt: new Date(), timeoutMs: 1000, toolTokenHash: hashToken(token) });
      await listen(c.app);
      const answer = await (await mcp(c.app, token)).callTool({ name: 'message_employee', arguments: { employee: c.agent.id, text: 'Look at the login.' } });
      expect(answer.isError).toBeFalsy();
    } else {
      const [ceo] = await c.db.select().from(people);
      const [picture] = how === 'picture' ? await c.db.insert(attachments).values({ companyId: c.companyId, agentId: c.agent.id, personId: ceo!.id, name: 'shot.png', mediaType: 'image/png', sha256: await stored(c.db, PNG, c.app.ctx.config), size: PNG.length }).returning() : [];
      const answer = await c.app.inject({ method: 'POST', url: `/api/agents/${c.agent.id}/messages`, payload: { text: 'Look at the login.', ...(picture ? { pictures: [picture.id] } : {}) }, ...c.as(c.ceo) });
      expect(answer.statusCode).toBe(202);
    }
    const live = c.sent.mock.calls.map(([, frame]) => frame).find(frame => frame.type === 'agent.say');
    if (live?.type !== 'agent.say' || !live.operatorDelivery) throw new Error('No tracked live input.');
    if (how === 'picture') expect(live.text).toContain('hh-fetch message');
    const [delivery] = await c.db.select().from(programDeliveries).where(eq(programDeliveries.id, live.operatorDelivery.id));
    return { live: { text: live.text, delivery: live.operatorDelivery }, row: delivery! };
  }

  const fallbackOf = async (c: Awaited<ReturnType<typeof operatorCompany>>) => {
    const queued = (await c.turnsOf()).filter(job => job.id !== c.job.id);
    expect(queued).toHaveLength(1);
    const [typed] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, queued[0]!.id), eq(agentEvents.kind, 'typed')));
    return { job: queued[0]!, typed: typed! };
  };

  const HOW = [{ how: 'person' as const, signed: true }, { how: 'picture' as const, signed: true }, { how: 'employee' as const, signed: false }];

  it.each(HOW)('comes back whole in the next turn once the program did not take them, sent by $how', async ({ how, signed }) => {
    const c = await operatorCompany();
    const { live, row } = await sent(c, how);
    const fact = { type: 'program.delivery' as const, agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, deliveryId: row.id, deliveryOrdinal: row.ordinal, kind: 'live' as const, wordsDigest: row.digest, elapsedMs: 0, ordinal: 0, evidenceId: randomUUID(), phase: 'attempt' as const };
    await acceptOperatorEvidence(c.ctx, c.identity, fact);
    await acceptOperatorEvidence(c.ctx, c.identity, { ...fact, phase: 'not_taken', evidenceId: randomUUID(), ordinal: 1, elapsedMs: 100 });
    const { job, typed } = await fallbackOf(c);
    expect(job.prompt).toBe(live.text);
    expect(wordsDigest(job.prompt)).toBe(row.digest);
    expect(typed.data).toMatchObject({ operatorDelivery: live.delivery, operatorFallback: row.id, text: 'Look at the login.' });
    if (signed) expect(typed.personId).toBe((await c.db.select().from(people))[0]!.id);
    else expect(typed.personId).toBeNull();
  });

  it.each(HOW)('comes back whole from the durable fact alone after a restart, sent by $how', async ({ how }) => {
    const c = await operatorCompany();
    const { live, row } = await sent(c, how);
    await c.db.update(programDeliveries).set({ outcome: 'not_taken', finishedAt: new Date() }).where(eq(programDeliveries.id, row.id));
    await reconcileOperatorFallbacks(c.ctx);
    const { job, typed } = await fallbackOf(c);
    expect(job.prompt).toBe(live.text);
    expect(typed.data).toMatchObject({ operatorDelivery: live.delivery, operatorFallback: row.id });
    await reconcileOperatorFallbacks(c.ctx);
    await fallbackOf(c);
  });

  it('keeps who said them when the node reports them unheard on its own, without a delivery', async () => {
    const c = await operatorCompany();
    const { live } = await sent(c, 'person');
    await unheard(c.ctx, c.identity, { type: 'agent.unheard', agentKey: c.agent.id, jobId: c.job.id, text: live.text }, new Date());
    const { job, typed } = await fallbackOf(c);
    expect(job.prompt).toBe(live.text);
    expect(typed.personId).toBe((await c.db.select().from(people))[0]!.id);
    expect(typed.data).toMatchObject({ text: 'Look at the login.' });
  });

  it('keeps nothing more than the message when the program got just that', async () => {
    const c = await operatorCompany();
    c.sent.mockImplementation((node, frame) => { if (frame.type === 'agent.say') queueMicrotask(() => said(c.ctx, node, frame.ref, true)); return true; });
    await insertOrDeliverTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Just this.', createdBy: null, message: { personId: null, text: 'Just this.' } });
    const [event] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, c.job.id), eq(agentEvents.kind, 'message')));
    expect(event!.data).toMatchObject({ text: 'Just this.' });
    expect(event!.data).not.toHaveProperty('livePrompt');
  });

  it('keeps nothing more for a message that waits for its turn, whose prompt the turn holds', async () => {
    const c = await operatorCompany();
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
    vi.spyOn(c.ctx.hub, 'isReady').mockReturnValue(false);
    const id = await insertOrDeliverTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Ivan (CEO): Later.', createdBy: null, message: { personId: null, text: 'Later.' } });
    const [event] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, id), eq(agentEvents.kind, 'message')));
    expect(event!.data).toMatchObject({ text: 'Later.' });
    expect(event!.data).not.toHaveProperty('livePrompt');
  });

  it('still reads an event from before words were kept with it by the words it shows', async () => {
    const c = await operatorCompany();
    const message = { personId: null, text: 'Plain words.', notification: { source: 'comment' as const, tasks: [] } };
    const text = addressed(message.text, await incomingEnvelope(c.ctx, c.companyId, c.agent.id, null, message));
    const live = await reserveDelivery(c.db, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, nodeId: c.identity.nodeId, kind: 'live', words: text, reference: randomUUID() });
    await appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, kind: 'message', data: { ...message, operatorDelivery: live } });
    await c.db.update(programDeliveries).set({ outcome: 'not_taken', finishedAt: new Date() }).where(eq(programDeliveries.id, live.id));
    await reconcileOperatorFallbacks(c.ctx);
    expect((await fallbackOf(c)).job.prompt).toBe(text);
  });

  it('never repeats words kept with another delivery, whatever the event says', async () => {
    const c = await operatorCompany();
    const live = await reserveDelivery(c.db, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, nodeId: c.identity.nodeId, kind: 'live', words: 'The real words.', reference: randomUUID() });
    await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, kind: 'message', data: { text: 'Other words.', livePrompt: 'Other words.', operatorDelivery: live } });
    await c.db.update(programDeliveries).set({ outcome: 'not_taken', finishedAt: new Date() }).where(eq(programDeliveries.id, live.id));
    await reconcileOperatorFallbacks(c.ctx);
    expect((await c.turnsOf()).map(job => job.id)).toEqual([c.job.id]);
  });
});
