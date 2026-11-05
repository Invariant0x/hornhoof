import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorEvidence } from '@hornhoof/protocol/program-operator';
import { and, eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { agents, jobs, machines, nodes, programOperatorCases, subscriptions } from '../src/db/schema.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { checkOperatorHealth } from '../src/modules/program-operator/health.js';
import { placeOperator } from '../src/modules/operations/ensure.js';
import { requestNodeDrain } from '../src/modules/updates/node-drain.js';
import { operatorCompany } from './program-operator-company.js';

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const c = await operatorCompany(true, env);
  await c.db.update(agents).set({ nodeId: null }).where(eq(agents.id, c.operator!.id));
  let ordinal = 0;
  const now = new Date();
  const record = (frame: OperatorEvidence) => acceptOperatorEvidence(c.ctx, c.identity, { ...frame, evidenceId: randomUUID(), ordinal: ordinal++ }, now);
  const signal = async () => {
    await record(c.fact);
    await record({ type: 'program.operator_needed', agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 0, reason: 'assignment_unrecorded', deliveryId: c.delivery.id, evidenceKey: c.delivery.id, elapsedMs: 60000, sinceLaunchMs: 60000, exit: null });
  };
  const incident = async () => (await c.db.select().from(programOperatorCases))[0]!;
  const operatorRow = async () => (await c.db.select().from(agents).where(eq(agents.id, c.operator!.id)))[0]!;
  const plan = async (label: string) => (await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'codex', kind: 'personal', label, ownerPersonId: c.sub.ownerPersonId, status: 'ready' }).returning())[0]!;
  const machineOf = async (subscriptionId: string, values: Partial<typeof nodes.$inferInsert> = {}) => {
    const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: randomUUID(), hostname: 'Machine' }).returning();
    return (await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId, keyHash: randomUUID(), status: 'ready', version: '0.6.1', ...values }).returning())[0]!;
  };
  const onOwnPlan = async (values: Partial<typeof nodes.$inferInsert> = {}) => {
    const own = await plan('Operator plan');
    const node = await machineOf(own.id, values);
    await c.db.update(agents).set({ subscriptionId: own.id, nodeId: null }).where(eq(agents.id, c.operator!.id));
    return { own, node };
  };
  return { ...c, now, signal, incident, operatorRow, plan, machineOf, onOwnPlan };
}

it('an operator with no turn yet and no node takes the first signal on a live machine of its plan', async () => {
  const c = await fixture();
  await c.signal();
  expect(await c.incident()).toMatchObject({ status: 'open', operatorAgentId: c.operator!.id });
  const [turn] = await c.turnsOf(c.operator!.id);
  expect(turn).toMatchObject({ status: 'running', nodeId: c.identity.nodeId });
  expect(c.sent.mock.calls.some(([to, frame]) => frame.type === 'job.run' && frame.jobId === turn!.id && to.kind === 'node' && to.nodeId === c.identity.nodeId)).toBe(true);
  expect((await c.operatorRow()).nodeId).toBe(c.identity.nodeId);
});

/* The health check does not ask after a node: an operator's turn may wait out a short outage of its machine. */
it('keeps that case with its operator through the health check', async () => {
  const c = await fixture();
  await c.signal();
  await c.db.update(agents).set({ nodeId: null }).where(eq(agents.id, c.operator!.id));
  await checkOperatorHealth(c.ctx, c.now);
  expect(await c.incident()).toMatchObject({ status: 'open', operatorAgentId: c.operator!.id });
});

it('calls the operator unavailable when no machine of its plan is connected', async () => {
  const c = await fixture();
  const { node } = await c.onOwnPlan();
  vi.mocked(c.ctx.hub.isReady).mockImplementation(id => id.kind !== 'node' || id.nodeId !== node.id);
  await c.signal();
  expect(await c.incident()).toMatchObject({ status: 'escalated', operatorAgentId: null, resolution: { outcome: 'operator_unavailable' } });
});

it.each([
  ['signed out', { status: 'needs_login' as const }],
  ['too old to take a turn', { version: '0.2.0' }],
  ['without its key any more', { keyHash: null }],
])('does not take a machine of its plan that is %s, as a first turn would not', async (_why, values) => {
  const c = await fixture();
  await c.onOwnPlan(values);
  await c.signal();
  expect(await c.incident()).toMatchObject({ status: 'escalated', operatorAgentId: null });
});

it('does not take a live machine of another plan, even the one the operator was last on', async () => {
  const c = await fixture();
  const { own, node } = await c.onOwnPlan();
  await c.db.update(nodes).set({ keyHash: null }).where(eq(nodes.id, node.id));
  await c.db.update(agents).set({ subscriptionId: own.id, nodeId: c.identity.nodeId }).where(eq(agents.id, c.operator!.id));
  await c.signal();
  expect(await c.incident()).toMatchObject({ status: 'escalated', operatorAgentId: null });
  expect(await c.turnsOf(c.operator!.id)).toEqual([]);
});

it('takes another machine of its plan when the one it was on is gone, as its next turn would', async () => {
  const c = await fixture();
  const { own, node } = await c.onOwnPlan();
  const left = await c.machineOf(own.id);
  await c.db.update(agents).set({ nodeId: left.id }).where(eq(agents.id, c.operator!.id));
  vi.mocked(c.ctx.hub.isReady).mockImplementation(id => id.kind !== 'node' || id.nodeId !== left.id);
  await c.signal();
  expect(await c.incident()).toMatchObject({ status: 'open', operatorAgentId: c.operator!.id });
  expect((await c.turnsOf(c.operator!.id))[0]).toMatchObject({ nodeId: node.id });
});

it('waits for the only machine of its plan while that one restarts for an update', async () => {
  const c = await fixture({ HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-first-signal-')) });
  const { node } = await c.onOwnPlan();
  vi.mocked(c.ctx.hub.isReady).mockImplementation(id => id.kind !== 'node' || id.nodeId !== node.id);
  expect(await requestNodeDrain(c.ctx, { kind: 'node', nodeId: node.id })).toMatchObject({ state: 'restarting' });
  await c.signal();
  expect(await c.incident()).toMatchObject({ status: 'open', operatorAgentId: c.operator!.id });
  expect(await c.turnsOf(c.operator!.id)).toMatchObject([{ status: 'queued' }]);
});

it('never takes an operator that is switched off', async () => {
  const c = await fixture();
  await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.operator!.id));
  await c.signal();
  expect(await c.incident()).toMatchObject({ status: 'escalated', operatorAgentId: null });
});

it('gives an operator a machine of its plan as soon as it is placed, with no turn', async () => {
  const c = await fixture();
  await c.onOwnPlan();
  await c.db.update(agents).set({ subscriptionId: null, nodeId: null }).where(eq(agents.id, c.operator!.id));
  await placeOperator(c.ctx, c.companyId);
  const row = await c.operatorRow();
  const [placed] = await c.db.select().from(nodes).where(and(eq(nodes.id, row.nodeId!), eq(nodes.subscriptionId, row.subscriptionId!)));
  expect(placed).toBeDefined();
  expect(await c.db.select().from(jobs).where(eq(jobs.agentId, c.operator!.id))).toEqual([]);
});
