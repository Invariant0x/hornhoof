import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PROGRAM_OPERATOR_ROLE, type OperatorEvidence } from '@hornhoof/protocol/program-operator';
import { vi } from 'vitest';
import { agents, jobs, machines, nodes, programDeliveries, subscriptions } from '../src/db/schema.js';
import { reserveDelivery } from '../src/modules/program-operator/deliveries.js';
import { failureCompany } from './failure-company.js';

export async function operatorCompany(withOperator = false) {
  const c = await failureCompany();
  await c.db.update(subscriptions).set({ kind: 'personal', provider: 'codex' }).where(eq(subscriptions.id, c.sub.id));
  const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: randomUUID(), hostname: 'Node' }).returning();
  const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: c.sub.id, keyHash: randomUUID(), status: 'ready', version: '0.6.1' }).returning();
  await c.db.update(agents).set({ nodeId: node!.id }).where(eq(agents.id, c.agent.id));
  const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, nodeId: node!.id, kind: 'conversation', prompt: 'Words.', timeoutMs: 1000, status: 'running' }).returning();
  const delivery = await reserveDelivery(c.db, { companyId: c.companyId, agentId: c.agent.id, jobId: job!.id, nodeId: node!.id, kind: 'assignment', words: 'Words.', reference: `job:${job!.id}` });
  const [saved] = await c.db.select().from(programDeliveries).where(eq(programDeliveries.id, delivery.id));
  const fact: OperatorEvidence = { type: 'program.delivery', agentKey: c.agent.id, jobId: job!.id, instance: randomUUID(), evidenceId: randomUUID(), ordinal: 0, deliveryId: delivery.id, deliveryOrdinal: delivery.ordinal, kind: 'assignment', phase: 'attempt', elapsedMs: 0, wordsDigest: saved!.digest };
  vi.spyOn(c.ctx.hub, 'hasProgramOperator').mockReturnValue(true);
  const [operator] = withOperator ? await c.db.insert(agents).values({ companyId: c.companyId, name: 'Operator', kind: 'worker', roleKey: PROGRAM_OPERATOR_ROLE, departmentId: c.watcher.departmentId, subscriptionId: c.sub.id, nodeId: node!.id, model: '' }).returning() : [];
  const identity = { kind: 'node' as const, nodeId: node!.id, keyHash: node!.keyHash! };
  return { ...c, operator, job: job!, identity, fact, delivery, row: async () => (await c.db.select().from(programDeliveries).where(eq(programDeliveries.id, delivery.id)))[0]! };
}
