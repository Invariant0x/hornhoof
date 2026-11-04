import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { jobs, programDeliveries, programOperatorCases } from '../src/db/schema.js';
import { enqueueTurn, startProgram } from '../src/modules/conversation/queue.js';
import { adoptOperatorOwnerTurn, resumeOperatorProcess } from '../src/modules/program-operator/recovery.js';
import { queuedOperatorAssignment } from '../src/modules/program-operator/recovered-input.js';
import { appendEvent } from '../src/modules/events/store.js';
import { checkOperatorHealth } from '../src/modules/program-operator/health.js';
import { afterFailure } from '../src/modules/tasks/failures.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { operatorCompany } from './program-operator-company.js';

async function fixture() {
  const c = await operatorCompany(false);
  const now = new Date(); let ordinal = 0;
  const record = (input: Parameters<typeof acceptOperatorEvidence>[2]) => acceptOperatorEvidence(c.ctx, c.identity, { ...input, evidenceId: randomUUID(), ordinal: ordinal++ }, now);
  await record(c.fact);
  await record({ type: 'program.operator_needed', agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 0, reason: 'assignment_unrecorded', deliveryId: c.delivery.id, evidenceKey: c.delivery.id, elapsedMs: 60000, sinceLaunchMs: 60000, exit: null });
  const [incident] = await c.db.select().from(programOperatorCases);
  await c.db.update(jobs).set({ status: 'failed', error: 'agent_failed', failure: { kind: 'unknown', text: `Program operator recovery ended: operator_unavailable; case ${incident!.id}.`, retryable: false }, finishedAt: now }).where(eq(jobs.id, c.job.id));
  const ready = () => record({ type: 'program.recovery_ready', agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 0, case: incident!.id });
  return { ...c, incident: incident!, record, ready };
}

it('holds automatic words and suppresses generic retry and duplicate failure notices while owner recovery waits', async () => {
  const c = await fixture();
  expect(await afterFailure(c.ctx, c.job.id)).toBe(true);
  const queued = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Another task.', createdBy: null });
  expect(await c.jobOf(queued)).toMatchObject({ status: 'queued' });
  expect(c.sent.mock.calls.some(([, f]) => f.type === 'job.run' && f.jobId === queued)).toBe(false);
  expect(await c.turnsOf(c.watcher.id)).toEqual([]);
});

it('creates one continuation from durable owner readiness without reopening the old failed job', async () => {
  const c = await fixture();
  await c.ready(); await c.ready();
  const children = await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id));
  expect(children).toHaveLength(1);
  expect(await c.jobOf(c.job.id)).toMatchObject({ status: 'failed', error: 'agent_failed' });
  const [incident] = await c.db.select().from(programOperatorCases).where(eq(programOperatorCases.id, c.incident.id));
  expect(incident).toMatchObject({ status: 'resolved', recoveryHold: false, continuationJobId: children[0]!.id });
  const [delivery] = await c.db.select().from(programDeliveries).where(eq(programDeliveries.jobId, children[0]!.id));
  expect(delivery).toMatchObject({ sourceDeliveryId: c.delivery.id });
  const sent = c.sent.mock.calls.map(([, frame]) => frame).find(frame => frame.type === 'job.run' && frame.jobId === children[0]!.id);
  expect(sent).toMatchObject({ operatorSourceDelivery: c.delivery });
});

it('a late exact-word receipt cancels an unsent continuation and cannot make another one', async () => {
  const c = await fixture();
  c.ctx.hub.isReady = () => false;
  await c.ready();
  const [child] = await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id));
  expect(child).toMatchObject({ status: 'queued' });
  await c.record({ ...c.fact, phase: 'taken', elapsedMs: 70000 });
  expect(await c.jobOf(child!.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
  await c.ready();
  expect(await c.db.select().from(jobs).where(and(eq(jobs.continueOf, c.job.id), eq(jobs.status, 'queued')))).toEqual([]);
});

it('adopts the owner turn already running instead of injecting another assignment', async () => {
  const c = await fixture();
  const [typed] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, nodeId: c.identity.nodeId, kind: 'conversation', prompt: 'Continue the checkout.', createdBy: c.sub.ownerPersonId, status: 'running', startedAt: new Date(), timeoutMs: 10000 }).returning();
  await adoptOperatorOwnerTurn(c.ctx, c.agent.id, typed!.id, c.identity.nodeId);
  await adoptOperatorOwnerTurn(c.ctx, c.agent.id, typed!.id, c.identity.nodeId);
  expect(await c.jobOf(typed!.id)).toMatchObject({ continueOf: c.job.id, prompt: 'Continue the checkout.', createdBy: c.sub.ownerPersonId });
  expect(await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id))).toHaveLength(1);
  expect((await c.db.select().from(programOperatorCases))[0]).toMatchObject({ status: 'resolved', recoveryHold: false, continuationJobId: typed!.id });
  expect(c.sent.mock.calls.some(([, f]) => f.type === 'job.run' && f.jobId === typed!.id)).toBe(false);
});

it('recognizes a late native uptake of the retained assignment without restoring unrelated words or authors', async () => {
  const c = await fixture();
  await appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, kind: 'message', data: { text: 'Words.', personId: null } });
  await c.db.update(jobs).set({ finishedAt: new Date(Date.now() - 3600000) }).where(eq(jobs.id, c.job.id));
  expect(await queuedOperatorAssignment(c.ctx, c.agent.id, c.job.id, 'Words.')).toBeNull();
  await c.record({ ...c.fact, phase: 'taken', elapsedMs: 3600000 });
  expect(await queuedOperatorAssignment(c.ctx, c.agent.id, c.job.id, 'Other words.')).toBeNull();
  const source = await queuedOperatorAssignment(c.ctx, c.agent.id, c.job.id, 'Words.');
  expect(source).toMatchObject({ job: { id: c.job.id }, source: { data: expect.objectContaining({ text: 'Words.' }) } });
});

it('restores readiness recorded just before the old failed job result or a server restart', async () => {
  const c = await fixture();
  await c.db.update(jobs).set({ status: 'running' }).where(eq(jobs.id, c.job.id));
  await c.ready();
  expect(await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id))).toEqual([]);
  await c.db.update(jobs).set({ status: 'failed' }).where(eq(jobs.id, c.job.id));
  await checkOperatorHealth({ ...c.ctx }); await checkOperatorHealth({ ...c.ctx });
  expect(await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id))).toHaveLength(1);
});

it('the owner opening a lost process resumes pending work once ahead of ordinary queued words', async () => {
  const c = await fixture();
  const waiting = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Later words.', createdBy: null });
  await startProgram(c.ctx, c.identity, c.agent.id); await startProgram(c.ctx, c.identity, c.agent.id);
  const children = await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id));
  expect(children).toHaveLength(1);
  expect(children[0]).toMatchObject({ status: 'running' });
  expect(await c.jobOf(waiting)).toMatchObject({ status: 'queued' });
  expect((await c.db.select().from(programOperatorCases))[0]).toMatchObject({ recoveryHold: false, continuationJobId: children[0]!.id });
});


it('reuses an existing continuation rather than queueing another copy of recovered words', async () => {
  const c = await fixture();
  const [previous] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, nodeId: c.identity.nodeId, kind: 'conversation', prompt: 'Retained words.', continueOf: c.job.id, status: 'queued', timeoutMs: 1000 }).returning();
  await c.ready();
  expect(await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id))).toHaveLength(1);
  expect((await c.db.select().from(programOperatorCases))[0]).toMatchObject({ status: 'resolved', continuationJobId: previous!.id });
});

it('finishes readiness without another assignment when the original already has a durable receipt', async () => {
  const c = await fixture();
  await c.db.update(programDeliveries).set({ receiptAt: new Date() }).where(eq(programDeliveries.id, c.delivery.id));
  await c.ready();
  expect(await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id))).toEqual([]);
  expect((await c.db.select().from(programOperatorCases))[0]).toMatchObject({ status: 'resolved', recoveryHold: false, continuationJobId: null });
});

it.each(['cancelled', 'missing-delivery', 'another-running'])('retains the recovery hold without injecting words for %s', async state => {
  const c = await fixture();
  if (state === 'cancelled') await c.db.update(jobs).set({ error: 'cancelled' }).where(eq(jobs.id, c.job.id));
  if (state === 'missing-delivery') await c.db.update(programOperatorCases).set({ deliveryId: null }).where(eq(programOperatorCases.id, c.incident.id));
  if (state === 'another-running') await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, nodeId: c.identity.nodeId, kind: 'conversation', prompt: 'Working.', status: 'running', timeoutMs: 1000 });
  await c.ready();
  expect(await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id))).toEqual([]);
  expect((await c.db.select().from(programOperatorCases))[0]!.recoveryHold).toBe(true);
});

it('replaces an unsent recovery continuation with the owner turn already running', async () => {
  const c = await fixture();
  c.ctx.hub.isReady = () => false;
  await c.ready();
  const [child] = await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id));
  const [typed] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, nodeId: c.identity.nodeId, kind: 'conversation', prompt: 'Owner continues.', status: 'running', timeoutMs: 1000 }).returning();
  await adoptOperatorOwnerTurn(c.ctx, c.agent.id, typed!.id, randomUUID());
  expect(await c.jobOf(child!.id)).toMatchObject({ status: 'queued' });
  await adoptOperatorOwnerTurn(c.ctx, c.agent.id, typed!.id, c.identity.nodeId);
  expect(await c.jobOf(child!.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
  expect(await c.jobOf(typed!.id)).toMatchObject({ continueOf: c.job.id });
  expect(await resumeOperatorProcess(c.ctx, c.agent.id, c.identity.nodeId)).toBe(false);
});
