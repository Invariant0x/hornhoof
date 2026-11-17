import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { agentEvents, nodes, programDeliveries, programInstances } from '../src/db/schema.js';
import { listEvents } from '../src/modules/events/store.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { receiveNodeMessage } from '../src/modules/nodes/lifecycle.js';
import { reserveDelivery } from '../src/modules/program-operator/deliveries.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { operatorTransaction } from '../src/modules/program-operator/transactions.js';
import { operatorCompany as fixture } from './program-operator-company.js';

it('stores evidence and delivery state durably before its acknowledgement, then deduplicates reconnect', async () => {
  const c = await fixture();
  let acknowledgements = 0;
  c.sent.mockImplementation((_node, message) => {
    if (message.type === 'program.evidence_ack') acknowledgements++;
    return true;
  });
  await receiveNodeMessage(c.ctx, c.identity, c.fact);
  expect((await c.row()).attemptedAt).toBeInstanceOf(Date);
  expect(acknowledgements).toBe(1);
  expect(await acceptOperatorEvidence(c.ctx, c.identity, c.fact)).toBe(true);
  expect(acknowledgements).toBe(2);
  expect(await c.db.select().from(programInstances)).toHaveLength(1);
  expect((await c.db.select().from(agentEvents).where(eq(agentEvents.agentId, c.agent.id))).filter(event => (event.data as { operatorEvidenceId?: string }).operatorEvidenceId === c.fact.evidenceId)).toHaveLength(1);
});

it('keeps program evidence out of the employee feed while its record stays', async () => {
  const c = await fixture();
  await receiveNodeMessage(c.ctx, c.identity, c.fact);
  const stored = (await c.db.select().from(agentEvents).where(eq(agentEvents.agentId, c.agent.id))).filter(event => (event.data as { operatorEvidenceId?: string }).operatorEvidenceId === c.fact.evidenceId);
  expect(stored).toHaveLength(1);
  const feed = await listEvents(c.db, c.agent.id, 0);
  expect(feed.map(e => e.seq)).not.toContain(stored[0]!.seq);
  expect(JSON.stringify(feed)).not.toContain('Program evidence recorded.');
});

it('refuses another node, mismatched words and ordinal, and a conflicting replay without changing the record', async () => {
  const c = await fixture();
  expect(await acceptOperatorEvidence(c.ctx, nodeIdentity(randomUUID()), c.fact)).toBe(false);
  expect(await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, wordsDigest: 'a'.repeat(64) })).toBe(false);
  expect(await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, deliveryOrdinal: 999 })).toBe(false);
  expect(c.sent).not.toHaveBeenCalled();
  expect((await c.row()).attemptedAt).toBeNull();
  await acceptOperatorEvidence(c.ctx, c.identity, c.fact);
  expect(await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, elapsedMs: 10 })).toBe(false);
});

it('keeps late receipt and first activity even if their evidence arrives before the attempt, and taken wins over not_taken', async () => {
  const c = await fixture();
  await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, evidenceId: randomUUID(), ordinal: 2, phase: 'not_taken', elapsedMs: 100 });
  await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, evidenceId: randomUUID(), ordinal: 1, phase: 'activity', elapsedMs: 10 });
  await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, evidenceId: randomUUID(), ordinal: 3, phase: 'taken', elapsedMs: 110 });
  await acceptOperatorEvidence(c.ctx, c.identity, c.fact);
  expect(await c.row()).toMatchObject({ outcome: 'taken', instance: c.fact.instance, attemptedAt: expect.any(Date), receiptAt: expect.any(Date), firstActivityAt: expect.any(Date) });
});

it('a late actual queue receipt overrides transport-only cancellation while waiting for a final uptake outcome', async () => {
  const c = await fixture();
  await c.db.update(programDeliveries).set({ outcome: 'cancelled', finishedAt: new Date() }).where(eq(programDeliveries.id, c.delivery.id));
  await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, evidenceId: randomUUID(), ordinal: 1, phase: 'queued', elapsedMs: 10 });
  expect(await c.row()).toMatchObject({ outcome: 'pending', receiptAt: expect.any(Date) });
});


it('rejects malformed evidence, revoked node keys and missing operator capability before acknowledgement', async () => {
  const c = await fixture();
  expect(await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, ordinal: -1 })).toBe(false);
  vi.mocked(c.ctx.hub.hasProgramOperator).mockReturnValue(false);
  expect(await acceptOperatorEvidence(c.ctx, c.identity, c.fact)).toBe(false);
  vi.mocked(c.ctx.hub.hasProgramOperator).mockReturnValue(true);
  await c.db.update(nodes).set({ keyHash: randomUUID() }).where(eq(nodes.id, c.identity.nodeId));
  expect(await acceptOperatorEvidence(c.ctx, c.identity, c.fact)).toBe(false);
  expect(c.sent).not.toHaveBeenCalled();
  expect(await c.db.select().from(programInstances)).toEqual([]);
});

it('binds launch state to its agent and refuses instance reuse by another agent', async () => {
  const c = await fixture();
  const launch = { type: 'program.launch' as const, agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 0, phase: 'attempt' as const, elapsedMs: 0 };
  expect(await acceptOperatorEvidence(c.ctx, c.identity, launch)).toBe(true);
  expect((await c.db.select().from(programInstances))[0]).toMatchObject({ launched: true, active: false, exited: false });
  await c.db.update(programInstances).set({ agentId: c.head.id }).where(eq(programInstances.id, launch.instance));
  expect(await acceptOperatorEvidence(c.ctx, c.identity, { ...launch, evidenceId: randomUUID(), ordinal: 1 })).toBe(false);
});

/* A node that starts again starts the agent's program anew under a new identity (fixtures in task 1200: the node of
   2026-11-17 01:39:56 UTC kept four records of the agent's programs from before active, and its new one inactive). */
it('leaves only the program a node started again active, even when a late word of an older one comes after it', async () => {
  const c = await fixture();
  const launch = (instance: string) => ({ type: 'program.launch' as const, agentKey: c.agent.id, jobId: c.job.id, instance, evidenceId: randomUUID(), ordinal: 0, phase: 'started' as const, elapsedMs: 0 });
  const activity = (instance: string, delivery: { id: string; ordinal: number; digest: string }, ordinal: number) => ({ ...c.fact, instance, evidenceId: randomUUID(), ordinal, deliveryId: delivery.id, deliveryOrdinal: delivery.ordinal, wordsDigest: delivery.digest, phase: 'activity' as const, elapsedMs: 10 });
  const words = async () => {
    const reserved = await reserveDelivery(c.db, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, nodeId: c.identity.nodeId, kind: 'assignment', words: 'Words.', reference: `job:${c.job.id}:${randomUUID()}` });
    return (await c.db.select().from(programDeliveries).where(eq(programDeliveries.id, reserved.id)))[0]!;
  };
  const [older, before, after] = [randomUUID(), randomUUID(), randomUUID()];
  for (const instance of [older, before]) {
    expect(await acceptOperatorEvidence(c.ctx, c.identity, launch(instance))).toBe(true);
    expect(await acceptOperatorEvidence(c.ctx, c.identity, activity(instance, await words(), 1))).toBe(true);
  }
  const late = await words();
  expect(await acceptOperatorEvidence(c.ctx, c.identity, launch(after))).toBe(true);
  const state = async () => Object.fromEntries((await c.db.select().from(programInstances)).map(row => [row.id, { launched: row.launched, active: row.active }]));
  expect(await state()).toEqual({ [older]: { launched: true, active: false }, [before]: { launched: true, active: false }, [after]: { launched: true, active: false } });
  /* The node sends again what it had not heard acknowledged before it stopped: the older program's word stays history. */
  expect(await acceptOperatorEvidence(c.ctx, c.identity, activity(before, late, 2))).toBe(true);
  expect(await acceptOperatorEvidence(c.ctx, c.identity, activity(after, await words(), 1))).toBe(true);
  expect(await state()).toEqual({ [older]: { launched: true, active: false }, [before]: { launched: true, active: false }, [after]: { launched: true, active: true } });
});

it('keeps cancelled outcomes until a taken receipt and preserves the first receipt clock', async () => {
  const c = await fixture();
  const first = new Date('2026-11-04T10:00:00Z');
  await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, phase: 'cancelled' }, first);
  expect(await c.row()).toMatchObject({ outcome: 'cancelled', finishedAt: first });
  await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, phase: 'queued', ordinal: 1, evidenceId: randomUUID() }, first);
  await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, phase: 'taken', ordinal: 2, evidenceId: randomUUID() }, new Date(first.getTime() + 1000));
  expect(await c.row()).toMatchObject({ outcome: 'taken', receiptAt: first, finishedAt: first });
});

it('publishes buffered notifications only after commit and discards them after rollback', async () => {
  const c = await fixture();
  const publish = vi.spyOn(c.ctx.bus, 'publish');
  await expect(operatorTransaction(c.ctx, async (tx, inside) => {
    inside.bus.publish(c.companyId, { type: 'org' });
    await tx.update(programDeliveries).set({ outcome: 'taken' }).where(eq(programDeliveries.id, c.delivery.id));
    expect(publish).not.toHaveBeenCalled();
    throw new Error('Rollback');
  })).rejects.toThrow('Rollback');
  expect(publish).not.toHaveBeenCalled();
  expect((await c.row()).outcome).toBe('pending');
  await operatorTransaction(c.ctx, async (_tx, inside) => {
    inside.bus.publish(c.companyId, { type: 'org' });
    expect(publish).not.toHaveBeenCalled();
  });
  expect(publish).toHaveBeenCalledExactlyOnceWith(c.companyId, { type: 'org' });
});


it('updates instance exit only for a startup exit with an actual exit and leaves question evidence neutral', async () => {
  const c = await fixture();
  const identity = { agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance };
  const needed = { type: 'program.operator_needed' as const, ...identity, evidenceId: randomUUID(), ordinal: 0, reason: 'startup_exit' as const, deliveryId: null, evidenceKey: c.fact.instance, elapsedMs: 100, sinceLaunchMs: 100, exit: null };
  expect(await acceptOperatorEvidence(c.ctx, c.identity, needed)).toBe(true);
  expect((await c.db.select().from(programInstances))[0]!.exited).toBe(false);
  expect(await acceptOperatorEvidence(c.ctx, c.identity, { ...needed, evidenceId: randomUUID(), ordinal: 1, exit: { code: 0, signal: null } })).toBe(true);
  expect((await c.db.select().from(programInstances))[0]!.exited).toBe(true);
  expect(await acceptOperatorEvidence(c.ctx, c.identity, { type: 'program.question', ...identity, evidenceId: randomUUID(), ordinal: 2, phase: 'asked', questionOrdinal: 1, question: { id: randomUUID(), kind: 'permission', text: 'Continue?', tool: 'Bash', callId: null }, elapsedMs: 100 })).toBe(true);
  expect((await c.db.select().from(programInstances))[0]).toMatchObject({ launched: false, active: false, exited: true });
});

it('rejects evidence ordinal collisions and missing jobs without acknowledging a different fact', async () => {
  const c = await fixture();
  await acceptOperatorEvidence(c.ctx, c.identity, c.fact);
  c.sent.mockClear();
  expect(await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, evidenceId: randomUUID(), phase: 'queued' })).toBe(false);
  expect(await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, evidenceId: randomUUID(), jobId: null })).toBe(false);
  expect(await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, evidenceId: randomUUID(), jobId: randomUUID() })).toBe(false);
  expect(c.sent).not.toHaveBeenCalled();
  expect((await c.row()).receiptAt).toBeNull();
});
