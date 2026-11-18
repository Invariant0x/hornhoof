import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agents, companies, jobs, machines, nodes, people, programDeliveries, programInstances, subscriptions } from '../src/db/schema.js';
import { cancelUnattemptedLive, cancelUnsentDelivery, reserveDelivery } from '../src/modules/program-operator/deliveries.js';
import { createTestDb } from './helpers-db.js';

async function fixture() {
  const db = await createTestDb();
  const [company] = await db.insert(companies).values({ name: 'Operator test' }).returning();
  const companyId = company!.id;
  const [owner] = await db.insert(people).values({ companyId, name: 'Owner', email: 'owner@example.com', status: 'active', scopeKind: 'company' }).returning();
  const [sub] = await db.insert(subscriptions).values({ companyId, provider: 'codex', kind: 'personal', label: 'Plan', ownerPersonId: owner!.id, status: 'ready' }).returning();
  const [machine] = await db.insert(machines).values({ companyId, personId: owner!.id, machineKey: 'operator-tests', hostname: 'Node' }).returning();
  const [node] = await db.insert(nodes).values({ companyId, machineId: machine!.id, subscriptionId: sub!.id, keyHash: randomUUID(), status: 'ready' }).returning();
  const [agent] = await db.insert(agents).values({ companyId, name: 'Worker', kind: 'worker', model: '', subscriptionId: sub!.id, nodeId: node!.id }).returning();
  const [job] = await db.insert(jobs).values({ companyId, agentId: agent!.id, subscriptionId: sub!.id, nodeId: node!.id, kind: 'conversation', prompt: 'Exact words.', timeoutMs: 1000, status: 'running' }).returning();
  return { db, input: { companyId, agentId: agent!.id, jobId: job!.id, nodeId: node!.id, kind: 'assignment' as const, words: job!.prompt, reference: `job:${job!.id}` } };
}

it('reserves stable identities and agent-wide ordinals before a node attempts any input', async () => {
  const { db, input } = await fixture();
  const first = await reserveDelivery(db, input);
  expect(await reserveDelivery(db, input)).toEqual(first);
  const next = await reserveDelivery(db, { ...input, kind: 'live', reference: randomUUID(), words: 'Live words.' });
  expect(next.ordinal).toBe(first.ordinal + 1);
  const rows = await db.select().from(programDeliveries).where(eq(programDeliveries.agentId, input.agentId));
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.attemptedAt === null && row.instance === null)).toBe(true);
  expect(rows[0]!.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(rows)).not.toContain('Exact words.');
});

it('does not reuse a delivery identity for different words or another target', async () => {
  const { db, input } = await fixture();
  await reserveDelivery(db, input);
  await expect(reserveDelivery(db, { ...input, words: 'Different words.' })).rejects.toThrow(/different words/i);
  await expect(reserveDelivery(db, { ...input, companyId: randomUUID() })).rejects.toThrow(/target/i);
});

it.each(['missing agent', 'removed agent', 'wrong node'] as const)('identifies a permanent target mismatch: %s', async reason => {
  const { db, input } = await fixture();
  if (reason === 'missing agent') input.agentId = randomUUID();
  if (reason === 'removed agent') await db.update(agents).set({ removedAt: new Date('2026-11-17T00:38:00Z') }).where(eq(agents.id, input.agentId));
  if (reason === 'wrong node') input.nodeId = randomUUID();
  await expect(reserveDelivery(db, input)).rejects.toMatchObject({ name: 'DeliveryTargetMismatch' });
  expect(await db.select().from(programDeliveries)).toEqual([]);
});


it('releases an unsent reference but preserves attempted or instance-bound delivery identities', async () => {
  const { db, input } = await fixture();
  const unsent = await reserveDelivery(db, input);
  await cancelUnsentDelivery(db, unsent);
  const replacement = await reserveDelivery(db, { ...input, words: 'Fresh words.' });
  expect(replacement.id).not.toBe(unsent.id);
  expect(replacement.ordinal).toBe(unsent.ordinal + 1);
  const instance = randomUUID();
  await db.insert(programInstances).values({ id: instance, companyId: input.companyId, agentId: input.agentId, nodeId: input.nodeId });
  for (const update of [{ attemptedAt: new Date() }, { attemptedAt: null, instance }]) {
    await db.update(programDeliveries).set(update).where(eq(programDeliveries.id, replacement.id));
    await cancelUnsentDelivery(db, replacement);
    expect(await reserveDelivery(db, { ...input, words: 'Fresh words.' })).toEqual(replacement);
    expect((await db.select().from(programDeliveries).where(eq(programDeliveries.id, replacement.id)))[0]!.outcome).toBe('pending');
  }
});

it('cancels only unattempted live deliveries without releasing their reference', async () => {
  const { db, input } = await fixture();
  const assignment = await reserveDelivery(db, input);
  await cancelUnattemptedLive(db, assignment);
  const live = await reserveDelivery(db, { ...input, kind: 'live', reference: 'live' });
  await cancelUnattemptedLive(db, live);
  const rows = await db.select().from(programDeliveries);
  expect(rows.find(row => row.id === assignment.id)).toMatchObject({ outcome: 'pending' });
  expect(rows.find(row => row.id === live.id)).toMatchObject({ outcome: 'cancelled', reference: 'live', attemptedAt: null, receiptAt: null });
});
