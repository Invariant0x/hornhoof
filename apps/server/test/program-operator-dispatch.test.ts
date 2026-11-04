import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { agentEvents, jobs, programDeliveries, programInstances, programOperatorCases } from '../src/db/schema.js';
import { deliverLive } from '../src/modules/conversation/decision-context.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { said } from '../src/modules/conversation/live.js';
import { appendEvent } from '../src/modules/events/store.js';
import { queuedOperatorAssignment } from '../src/modules/program-operator/recovered-input.js';
import { liveInputOf, rememberLiveInput, sourceDeliveryMetadataForJob } from '../src/modules/program-operator/input.js';
import { wordsDigest } from '../src/modules/program-operator/deliveries.js';
import { operatorCompany } from './program-operator-company.js';

it.each([true, false])('reserves assignment identity only for a capable terminal node (%s)', async capable => {
  const c = await operatorCompany();
  vi.mocked(c.ctx.hub.hasProgramOperator).mockReturnValue(capable);
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Check the checkout.', createdBy: null });
  const sent = c.sent.mock.calls.map(([, frame]) => frame).find(frame => frame.type === 'job.run' && frame.jobId === id);
  expect(sent?.type).toBe('job.run');
  if (sent?.type !== 'job.run') throw new Error('The job was not dispatched.');
  if (!capable) { expect(sent.operatorDelivery).toBeUndefined(); return; }
  expect(sent.operatorDelivery).toEqual({ id: expect.any(String), ordinal: 2 });
  const [saved] = await c.db.select().from(programDeliveries).where(eq(programDeliveries.id, sent.operatorDelivery!.id));
  expect(saved).toMatchObject({ kind: 'assignment', jobId: id, digest: wordsDigest(sent.prompt), attemptedAt: null, receiptAt: null });
});

it('a comment uses the common live path, preserves its source and records metadata without calling transport acceptance a receipt', async () => {
  const c = await operatorCompany();
  const message = { personId: null, text: 'A comment on the checkout.', notification: { source: 'comment' as const, tasks: [] } };
  c.sent.mockImplementation((node, frame) => {
    if (frame.type === 'agent.say') queueMicrotask(() => said(c.ctx, node, frame.ref, true));
    return true;
  });
  const into = await deliverLive(c.ctx, c.agent.id, message.text, { source: { data: message } }, (jobId, kept) => appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId, kind: 'message', data: message }, kept).then(() => {}));
  expect(into).toBe(c.job.id);
  const sent = c.sent.mock.calls.map(([, frame]) => frame).find(frame => frame.type === 'agent.say');
  if (sent?.type !== 'agent.say') throw new Error('No live delivery.');
  expect(sent.operatorDelivery).toEqual({ id: expect.any(String), ordinal: 2 });
  const [saved] = await c.db.select().from(programDeliveries).where(eq(programDeliveries.id, sent.operatorDelivery!.id));
  expect(saved).toMatchObject({ kind: 'live', jobId: c.job.id, digest: wordsDigest(sent.text), receiptAt: null, outcome: 'pending' });
  const [event] = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, c.job.id));
  expect(event!.data).toMatchObject({ notification: message.notification, operatorDelivery: sent.operatorDelivery });
});

it('cancels an explicit live refusal before an attempt so it cannot block the ordered uptake streak', async () => {
  const c = await operatorCompany();
  const message = { text: 'A comment.', personId: null };
  c.sent.mockImplementation((node, frame) => {
    if (frame.type === 'agent.say') queueMicrotask(() => said(c.ctx, node, frame.ref, false));
    return true;
  });
  expect(await deliverLive(c.ctx, c.agent.id, message.text, { source: { data: message } }, async () => { throw new Error('Unaccepted words were kept.'); })).toBeNull();
  const [delivery] = await c.db.select().from(programDeliveries).where(eq(programDeliveries.kind, 'live'));
  expect(delivery).toMatchObject({ outcome: 'cancelled', attemptedAt: null, receiptAt: null });
});


it('retains per-recipient live metadata only for object sources', () => {
  const source = {};
  const attempt = { delivery: { id: 'delivery', ordinal: 1 }, jobId: 'job', digest: wordsDigest('Words.') };
  rememberLiveInput(source, 'first', attempt);
  rememberLiveInput(source, 'second', { ...attempt, jobId: 'other-job' });
  expect(liveInputOf(source, 'first')).toEqual(attempt);
  expect(liveInputOf(source, 'second')?.jobId).toBe('other-job');
  for (const value of [null, undefined, 1, 'text']) {
    rememberLiveInput(value, 'first', attempt);
    expect(liveInputOf(value, 'first')).toBeUndefined();
  }
  expect(liveInputOf({}, 'first')).toBeUndefined();
});

it('uses a retained assignment only for exact taken words with a source that no queued event consumed', async () => {
  const c = await operatorCompany();
  await c.db.insert(programInstances).values({ id: c.fact.instance, companyId: c.companyId, agentId: c.agent.id, nodeId: c.identity.nodeId });
  await c.db.insert(programOperatorCases).values({ companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, nodeId: c.identity.nodeId, instance: c.fact.instance, deliveryId: c.delivery.id, reason: 'assignment_unrecorded', evidenceKey: c.delivery.id, capability: 'test', deadlineAt: new Date() });
  expect(await queuedOperatorAssignment(c.ctx, c.agent.id, c.job.id, 'Words.')).toBeNull();
  await c.db.update(programDeliveries).set({ outcome: 'taken' }).where(eq(programDeliveries.id, c.delivery.id));
  expect(await queuedOperatorAssignment(c.ctx, c.agent.id, c.job.id, 'Words.')).toBeNull();
  await appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, personId: c.sub.ownerPersonId, kind: 'message', data: { text: 'Words.', from: 'person' } });
  expect(await queuedOperatorAssignment(c.ctx, c.agent.id, c.job.id, 'Other words.')).toBeNull();
  const source = await queuedOperatorAssignment(c.ctx, c.agent.id, c.job.id, 'Words.');
  expect(source).toMatchObject({ source: { personId: c.sub.ownerPersonId, data: { text: 'Words.', operatorDelivery: c.delivery } }, job: { id: c.job.id } });
  await appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, kind: 'typed', data: { queuedEvent: source!.seq, turnFact: true } });
  expect(await queuedOperatorAssignment(c.ctx, c.agent.id, c.job.id, 'Words.')).toBeNull();
  for (const error of ['cancelled', 'stale'] as const) {
    await c.db.update(jobs).set({ error }).where(eq(jobs.id, c.job.id));
    expect(await queuedOperatorAssignment(c.ctx, c.agent.id, c.job.id, 'Words.')).toBeNull();
  }
});

it('ignores malformed or foreign persisted source delivery metadata', async () => {
  const c = await operatorCompany();
  await appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, kind: 'typed', data: { operatorDelivery: { id: 'invalid' } } });
  expect(await sourceDeliveryMetadataForJob(c.ctx.db, c.agent.id, c.job.id)).toBeUndefined();
  await c.db.update(agentEvents).set({ data: { operatorDelivery: { ...c.delivery, ordinal: c.delivery.ordinal + 1 } } }).where(eq(agentEvents.jobId, c.job.id));
  expect(await sourceDeliveryMetadataForJob(c.ctx.db, c.agent.id, c.job.id)).toBeUndefined();
});
