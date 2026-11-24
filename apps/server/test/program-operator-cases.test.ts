import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorEvidence, OperatorReason } from '@hornhoof/protocol/program-operator';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { agentEvents, agents, jobs, machines, nodes, programInstances, programOperatorCases, programOperatorSignals, subscriptions } from '../src/db/schema.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { expireOperatorCases, operatorCaseMode } from '../src/modules/program-operator/cases.js';
import { resumeOperatorProcess } from '../src/modules/program-operator/recovery.js';
import { afterFailure } from '../src/modules/tasks/failures.js';
import { requestNodeDrain } from '../src/modules/updates/node-drain.js';
import { checkOperatorHealth, restoreOperatorNode } from '../src/modules/program-operator/health.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { until } from './helpers.js';
import { operatorCompany } from './program-operator-company.js';
import { reserveDelivery, wordsDigest } from '../src/modules/program-operator/deliveries.js';

async function fixture(withOperator = true, env: NodeJS.ProcessEnv = {}) {
  const c = await operatorCompany(withOperator, env);
  const now = new Date();
  let ordinal = 0;
  const identity = { agentKey: c.fact.agentKey, jobId: c.fact.jobId, instance: c.fact.instance };
  const record = (frame: OperatorEvidence, at = now) => acceptOperatorEvidence(c.ctx, c.identity, { ...frame, evidenceId: randomUUID(), ordinal: ordinal++ }, at);
  const alarm = (reason: OperatorReason, elapsedMs: number) => record({ type: 'program.operator_needed', ...identity, evidenceId: randomUUID(), ordinal: 0, reason, deliveryId: reason === 'startup_exit' ? null : c.delivery.id, evidenceKey: reason === 'startup_exit' ? identity.instance : c.delivery.id, elapsedMs, sinceLaunchMs: elapsedMs, exit: reason === 'startup_exit' ? { code: 0, signal: null } : null });
  const attempt = () => record(c.fact);
  const phase = (phase: 'queued' | 'taken' | 'activity', elapsedMs: number) => record({ ...c.fact, phase, elapsedMs });
  const launch = () => record({ type: 'program.launch', ...identity, evidenceId: randomUUID(), ordinal: 0, phase: 'attempt', elapsedMs: 0 });
  const cases = () => c.db.select().from(programOperatorCases);
  return { ...c, now, record, alarm, attempt, phase, launch, cases };
}

async function liveInput(c: Awaited<ReturnType<typeof fixture>>, instance = c.fact.instance) {
  const words = randomUUID();
  const delivery = await reserveDelivery(c.db, { companyId: c.companyId, agentId: c.agent.id, jobId: c.job.id, nodeId: c.identity.nodeId, kind: 'live', words, reference: randomUUID() });
  const frame = { ...c.fact, instance, deliveryId: delivery.id, deliveryOrdinal: delivery.ordinal, kind: 'live' as const, wordsDigest: wordsDigest(words) };
  await c.record(frame);
  return { delivery, finish: (phase: 'queued' | 'taken' | 'not_taken') => c.record({ ...frame, phase, elapsedMs: 100 }) };
}

it('opens one case and one durable operator wake, consumes supplementary causes and preserves the original deadline', async () => {
  const c = await fixture();
  await c.launch(); await c.attempt(); await c.alarm('assignment_unrecorded', 60000);
  const [opened] = await c.cases();
  expect(opened).toMatchObject({ status: 'open', reason: 'assignment_unrecorded', operatorAgentId: c.operator!.id });
  expect(+opened!.deadlineAt).toBe(+c.now + 600000);
  expect(await c.turnsOf(c.operator!.id)).toHaveLength(1);
  const [message] = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, opened!.operatorJobId!));
  expect(message!.data).toMatchObject({ notification: { source: 'program_operator' }, programOperatorCase: opened!.id });
  await c.alarm('assignment_unrecorded', 60000);
  await c.alarm('startup_exit', 60000);
  const [updated] = await c.cases();
  expect(updated!.id).toBe(opened!.id);
  expect(updated!.deadlineAt).toEqual(opened!.deadlineAt);
  expect(updated!.evidence).toHaveLength(2);
  expect(await c.db.select().from(programOperatorSignals)).toHaveLength(2);
  expect(await c.turnsOf(c.operator!.id)).toHaveLength(1);
});

it('resolves on the actual word receipt and revokes the node capability without cancelling working programs', async () => {
  const c = await fixture();
  await c.attempt(); await c.alarm('assignment_unrecorded', 60000); await c.phase('queued', 60010);
  const [resolved] = await c.cases();
  expect(resolved).toMatchObject({ status: 'resolved', recoveryHold: false });
  expect(c.sent.mock.calls).toContainEqual([expect.anything(), expect.objectContaining({ type: 'program.operator_case', case: resolved!.id, disposition: 'revoke' })]);
  expect(c.sent.mock.calls.some(([, frame]) => frame.type === 'job.cancel')).toBe(false);
  expect(await c.jobOf(c.job.id)).toMatchObject({ status: 'running' });
  await c.alarm('assignment_unrecorded', 120000);
  expect(await c.cases()).toHaveLength(1);
});

it('holds immediately without an operator and gives recovery a chance before calling anyone', async () => {
  const c = await fixture(false);
  await c.attempt(); await c.alarm('assignment_unrecorded', 60000);
  const [incident] = await c.cases();
  expect(incident).toMatchObject({ status: 'escalated', recoveryHold: true, resolution: { outcome: 'operator_unavailable' } });
  expect(incident!.escalationJobId).toBeNull();
  await expireOperatorCases({ ...c.ctx }, new Date(+c.now + 1200000));
  await c.alarm('assignment_unrecorded', 120000);
  expect(await c.cases()).toHaveLength(1);
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  expect((await c.turnsOf(orchestrator!.id)).filter(job => job.prompt.includes(incident!.id))).toEqual([]);
  expect((await c.db.select().from(nodes).where(eq(nodes.id, c.identity.nodeId)))[0]!.status).toBe('ready');
});

it('expires once ten minutes from opening and leaves a computing target running', async () => {
  const c = await fixture();
  await c.attempt(); await c.phase('taken', 10); await c.alarm('recorded_no_activity', 300010);
  const [opened] = await c.cases();
  expect(opened).toMatchObject({ status: 'open', readOnly: true });
  await expireOperatorCases(c.ctx, new Date(+c.now + 599999));
  expect((await c.cases())[0]!.status).toBe('open');
  await expireOperatorCases(c.ctx, new Date(+c.now + 600000));
  await expireOperatorCases({ ...c.ctx }, new Date(+c.now + 1200000));
  const [expired] = await c.cases();
  expect(expired).toMatchObject({ status: 'escalated', recoveryHold: false, resolution: { outcome: 'operator_timeout' } });
  expect(await c.jobOf(c.job.id)).toMatchObject({ status: 'running' });
  expect(c.sent.mock.calls.some(([, frame]) => frame.type === 'job.cancel')).toBe(false);
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  expect((await c.turnsOf(orchestrator!.id)).filter(job => job.id === expired!.escalationJobId)).toHaveLength(1);
});

it('does not call from an unproved threshold or after first own activity for hours', async () => {
  const c = await fixture();
  await c.alarm('assignment_unrecorded', 59999);
  expect(await c.cases()).toEqual([]);
  await c.attempt(); await c.phase('taken', 10); await c.phase('activity', 11);
  await c.alarm('recorded_no_activity', 8 * 3600000);
  expect(await c.cases()).toEqual([]);
});

it('rolls back the case, wake and browser notification together if their transaction fails', async () => {
  const c = await fixture();
  await c.attempt();
  const published = vi.fn();
  c.ctx.bus.subscribe(c.companyId, published);
  const transaction = c.db.transaction.bind(c.db);
  vi.spyOn(c.db, 'transaction').mockImplementation(callback => transaction(async tx => { await callback(tx); throw new Error('Rollback probe.'); }));
  await expect(c.alarm('assignment_unrecorded', 60000)).rejects.toThrow('Rollback probe.');
  expect(await c.cases()).toEqual([]);
  expect(await c.turnsOf(c.operator!.id)).toEqual([]);
  expect(published).not.toHaveBeenCalled();
});

it('calls once for three finalized live failures, not for queued or fourth/fifth, and taken resets the same program for another streak', async () => {
  const c = await fixture();
  for (let i = 0; i < 2; i++) await (await liveInput(c)).finish('not_taken');
  const third = await liveInput(c); await third.finish('queued');
  expect(await c.cases()).toEqual([]);
  await third.finish('not_taken');
  for (let i = 0; i < 2; i++) await (await liveInput(c)).finish('not_taken');
  expect(await c.cases()).toHaveLength(1);
  expect(await c.turnsOf(c.operator!.id)).toHaveLength(1);
  await (await liveInput(c)).finish('taken');
  expect((await c.cases())[0]!.status).toBe('resolved');
  for (let i = 0; i < 3; i++) await (await liveInput(c)).finish('not_taken');
  expect(await c.cases()).toHaveLength(2);
  expect(await c.turnsOf(c.operator!.id)).toHaveLength(2);
});

it('a later taken receipt resets older pending words; a stale third instance gets a read-only case', async () => {
  const c = await fixture();
  await liveInput(c);
  await (await liveInput(c)).finish('taken');
  const failures = [await liveInput(c, randomUUID()), await liveInput(c, randomUUID()), await liveInput(c, randomUUID())];
  await liveInput(c, randomUUID());
  for (const input of failures) await input.finish('not_taken');
  const [incident] = await c.cases();
  expect(incident).toMatchObject({ reason: 'live_words_not_taken', deliveryId: failures[2]!.delivery.id, readOnly: true });
});

it('opens and revokes exactly one question capability, preserving its event identity on replay', async () => {
  const c = await fixture();
  await c.launch();
  const question = { id: randomUUID(), kind: 'permission' as const, tool: 'Bash', text: 'Remove ./tmp/mine?', callId: 'q' };
  const asked: OperatorEvidence = { type: 'program.question', agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 0, question, questionOrdinal: 1, phase: 'asked', elapsedMs: 0 };
  const needed: OperatorEvidence = { type: 'program.operator_needed', agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 0, reason: 'question_waiting', questionId: question.id, deliveryId: null, evidenceKey: question.id, elapsedMs: 30000, sinceLaunchMs: 30000, exit: null };
  await c.record(asked); await c.record({ ...needed, elapsedMs: 29999 });
  expect(await c.cases()).toEqual([]);
  await c.record(needed); await c.record(needed);
  const [incident] = await c.cases();
  expect(incident).toMatchObject({ reason: 'question_waiting', evidenceKey: question.id, readOnly: false });
  expect(await c.turnsOf(c.operator!.id)).toHaveLength(1);
  expect(c.sent.mock.calls).toContainEqual([expect.anything(), expect.objectContaining({ type: 'program.operator_case', disposition: 'open', reason: 'question_waiting', questionId: question.id })]);
  await c.record({ ...asked, phase: 'cleared', elapsedMs: 30001 });
  expect((await c.cases())[0]!.status).toBe('resolved');
  await c.record(needed);
  expect(await c.cases()).toHaveLength(1);
});

it('restores capabilities after reconnect and escalates once if the assigned operator loses its role', async () => {
  const c = await fixture();
  await c.attempt(); await c.alarm('assignment_unrecorded', 60000);
  c.sent.mockClear();
  await restoreOperatorNode(c.ctx, c.identity);
  expect(c.sent.mock.calls).toContainEqual([expect.anything(), expect.objectContaining({ type: 'program.operator_case', disposition: 'open' })]);
  await c.db.update(agents).set({ roleKey: 'OPS-WATCH' }).where(eq(agents.id, c.operator!.id));
  await checkOperatorHealth(c.ctx, c.now); await checkOperatorHealth(c.ctx, c.now);
  const [incident] = await c.cases();
  expect(incident).toMatchObject({ status: 'escalated', resolution: { outcome: 'operator_unavailable' } });
  expect(incident!.escalationJobId).toBeNull();
  expect(c.sent.mock.calls.filter(([, f]) => f.type === 'job.cancel' && f.jobId === c.job.id)).toEqual([]);
});

it('keeps a missing escalation recipient pending and sends one notice when its plan becomes available', async () => {
  const c = await fixture(false);
  await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.kind, 'orchestrator'));
  await c.attempt(); await c.phase('taken', 10); await c.alarm('recorded_no_activity', 300010);
  expect((await c.cases())[0]!.escalationJobId).toBeNull();
  await c.db.update(agents).set({ subscriptionId: c.sub.id }).where(eq(agents.kind, 'orchestrator'));
  await checkOperatorHealth(c.ctx, c.now); await checkOperatorHealth(c.ctx, c.now);
  const [incident] = await c.cases();
  expect(incident!.escalationJobId).not.toBeNull();
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  expect((await c.turnsOf(orchestrator!.id)).filter(j => j.id === incident!.escalationJobId)).toHaveLength(1);
});

it('allows a current question in a new physical program without requiring a new assignment attempt', async () => {
  const c = await fixture();
  await c.attempt(); await c.phase('taken', 10); await c.phase('activity', 11);
  const identity = { agentKey: c.agent.id, jobId: c.job.id, instance: randomUUID() };
  await c.record({ type: 'program.launch', ...identity, evidenceId: randomUUID(), ordinal: 0, phase: 'attempt', elapsedMs: 0 });
  const question = { id: randomUUID(), kind: 'permission' as const, tool: 'Bash', text: 'Read the checkout?', callId: 'q' };
  await c.record({ type: 'program.question', ...identity, evidenceId: randomUUID(), ordinal: 0, question, questionOrdinal: 1, phase: 'asked', elapsedMs: 0 });
  await c.record({ type: 'program.operator_needed', ...identity, evidenceId: randomUUID(), ordinal: 0, reason: 'question_waiting', questionId: question.id, deliveryId: null, evidenceKey: question.id, elapsedMs: 30000, sinceLaunchMs: 30000, exit: null });
  expect((await c.cases())[0]).toMatchObject({ reason: 'question_waiting', instance: identity.instance, readOnly: false });
  expect(c.sent.mock.calls).toContainEqual([expect.anything(), expect.objectContaining({ type: 'program.operator_case', instance: identity.instance, readOnly: false, questionId: question.id })]);
});

it('escalates when the assigned operator leaves Operations despite retaining the advertised role', async () => {
  const c = await fixture();
  await c.attempt(); await c.alarm('assignment_unrecorded', 60000);
  await c.db.update(agents).set({ departmentId: c.dev.id }).where(eq(agents.id, c.operator!.id));
  await checkOperatorHealth(c.ctx, c.now);
  expect((await c.cases())[0]).toMatchObject({ status: 'escalated', resolution: { outcome: 'operator_unavailable' } });
});

it('keeps an assigned running operator and its target alive during a short node outage', async () => {
  const c = await fixture();
  await c.attempt(); await c.alarm('assignment_unrecorded', 60000);
  const [incident] = await c.cases();
  await c.db.update(jobs).set({ status: 'running' }).where(eq(jobs.id, incident!.operatorJobId!));
  vi.mocked(c.ctx.hub.isReady).mockReturnValue(false);
  vi.mocked(c.ctx.hub.isOnline).mockReturnValue(false);
  await checkOperatorHealth(c.ctx, c.now);
  expect((await c.cases())[0]).toMatchObject({ status: 'open', escalationJobId: null });
  expect(await c.jobOf(c.job.id)).toMatchObject({ status: 'running' });
});

it.each(['removed', 'off', 'job-ended', 'plan-not-ready', 'plan-removed'])('escalates an unavailable assigned operator (%s)', async unavailable => {
  const c = await fixture();
  const [operatorPlan] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'codex', kind: 'personal', label: 'Operator plan', ownerPersonId: c.sub.ownerPersonId, status: 'ready' }).returning();
  await c.db.update(agents).set({ subscriptionId: operatorPlan!.id }).where(eq(agents.id, c.operator!.id));
  await c.attempt(); await c.alarm('assignment_unrecorded', 60000);
  const [incident] = await c.cases();
  if (unavailable === 'removed') await c.db.update(agents).set({ removedAt: c.now }).where(eq(agents.id, c.operator!.id));
  if (unavailable === 'off') await c.db.update(agents).set({ switchedOffAt: c.now }).where(eq(agents.id, c.operator!.id));
  if (unavailable === 'job-ended') await c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, incident!.operatorJobId!));
  if (unavailable === 'plan-not-ready') await c.db.update(subscriptions).set({ status: 'needs_login' }).where(eq(subscriptions.id, operatorPlan!.id));
  if (unavailable === 'plan-removed') await c.db.update(subscriptions).set({ removedAt: c.now }).where(eq(subscriptions.id, operatorPlan!.id));
  await checkOperatorHealth(c.ctx, c.now);
  expect((await c.cases())[0]).toMatchObject({ status: 'escalated', resolution: { outcome: 'operator_unavailable' } });
});

it('does not assign a case to a worker outside Operations', async () => {
  const c = await fixture();
  await c.db.update(agents).set({ departmentId: c.dev.id }).where(eq(agents.id, c.operator!.id));
  await c.attempt(); await c.alarm('assignment_unrecorded', 60000);
  expect((await c.cases())[0]).toMatchObject({ status: 'escalated', operatorAgentId: null });
});

/* The operator on a plan and a machine of its own; only that machine goes down. */
async function operatorOnItsOwnMachine(c: Awaited<ReturnType<typeof fixture>>) {
  const [plan] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'codex', kind: 'personal', label: 'Operator plan', ownerPersonId: c.sub.ownerPersonId, status: 'ready' }).returning();
  const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: randomUUID(), hostname: 'Operator machine' }).returning();
  const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: plan!.id, keyHash: randomUUID(), status: 'ready', version: '0.6.1' }).returning();
  await c.db.update(agents).set({ subscriptionId: plan!.id, nodeId: node!.id }).where(eq(agents.id, c.operator!.id));
  vi.mocked(c.ctx.hub.isReady).mockImplementation(id => id.kind !== 'node' || id.nodeId !== node!.id);
  return { kind: 'node' as const, nodeId: node!.id };
}

it('keeps a case with an operator whose machine restarts for an update: its turn waits for the machine', async () => {
  const c = await fixture(true, { HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-operator-drain-')) });
  expect(await requestNodeDrain(c.ctx, await operatorOnItsOwnMachine(c))).toMatchObject({ state: 'restarting' });
  await c.attempt(); await c.alarm('assignment_unrecorded', 60000);
  expect((await c.cases())[0]).toMatchObject({ status: 'open', operatorAgentId: c.operator!.id });
  expect(await c.turnsOf(c.operator!.id)).toMatchObject([{ status: 'queued' }]);
  await checkOperatorHealth(c.ctx, c.now);
  expect((await c.cases())[0]).toMatchObject({ status: 'open', operatorAgentId: c.operator!.id });
});

it('calls an operator unavailable whose machine went away for no update', async () => {
  const c = await fixture(true, { HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-operator-drain-')) });
  await operatorOnItsOwnMachine(c);
  await c.attempt(); await c.alarm('assignment_unrecorded', 60000);
  expect((await c.cases())[0]).toMatchObject({ status: 'escalated', operatorAgentId: null, resolution: { outcome: 'operator_unavailable' } });
});

it('lets the operator answer a program on a machine that waits for an update, and the machine then goes on to it', async () => {
  const c = await fixture(true, { HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-operator-drain-')) });
  const machine = { kind: 'node' as const, nodeId: c.identity.nodeId };
  await c.db.update(agents).set({ nodeId: machine.nodeId }).where(eq(agents.id, c.operator!.id));
  expect(await requestNodeDrain(c.ctx, machine)).toMatchObject({ state: 'waiting', turnsLeft: 1 });
  await c.launch();
  const question = { id: randomUUID(), kind: 'permission' as const, tool: 'Bash', text: 'Remove ./tmp/mine?', callId: 'q' };
  const asked: OperatorEvidence = { type: 'program.question', agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 0, question, questionOrdinal: 1, phase: 'asked', elapsedMs: 0 };
  await c.record(asked);
  await c.record({ type: 'program.operator_needed', agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 0, reason: 'question_waiting', questionId: question.id, deliveryId: null, evidenceKey: question.id, elapsedMs: 30000, sinceLaunchMs: 30000, exit: null });
  await until(async () => (await c.turnsOf(c.operator!.id))[0]?.status === 'running');
  const [turn] = await c.turnsOf(c.operator!.id);
  expect(turn).toMatchObject({ status: 'running', nodeId: machine.nodeId });
  expect(await requestNodeDrain(c.ctx, machine)).toMatchObject({ state: 'waiting', turnsLeft: 2 });
  await c.record({ ...asked, phase: 'cleared', elapsedMs: 30001 });
  expect((await c.cases())[0]!.status).toBe('resolved');
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, turn!.id));
  expect(await requestNodeDrain(c.ctx, machine)).toMatchObject({ state: 'restarting' });
});

it('keeps a program operator off a machine that restarts for an update, and other turns off one that waits', async () => {
  const c = await fixture(true, { HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-operator-drain-')) });
  const machine = { kind: 'node' as const, nodeId: c.identity.nodeId };
  await c.db.update(agents).set({ nodeId: machine.nodeId }).where(eq(agents.id, c.operator!.id));
  await c.db.update(agents).set({ nodeId: machine.nodeId }).where(eq(agents.id, c.head.id));
  expect(await requestNodeDrain(c.ctx, machine)).toMatchObject({ state: 'waiting' });
  await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.head.id, prompt: 'A head stays out while the machine waits.', createdBy: null });
  await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.operator!.id, prompt: 'An operator goes in.', createdBy: null });
  await until(async () => (await c.turnsOf(c.operator!.id))[0]?.status === 'running');
  expect((await c.turnsOf(c.head.id))[0]).toMatchObject({ status: 'queued' });
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, c.operator!.id));
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  expect(await requestNodeDrain(c.ctx, machine)).toMatchObject({ state: 'restarting' });
  await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.operator!.id, prompt: 'Not while it restarts.', createdBy: null });
  expect((await c.turnsOf(c.operator!.id)).at(-1)).toMatchObject({ status: 'queued' });
});

it.each(['offline', 'already-stuck', 'self'])('does not assign recovery to an operator that is %s', async state => {
  const c = await fixture();
  await c.attempt();
  if (state === 'offline') vi.mocked(c.ctx.hub.isReady).mockReturnValue(false);
  if (state === 'self') await c.db.update(agents).set({ roleKey: 'OPS-PROGRAM' }).where(eq(agents.id, c.agent.id));
  if (state === 'already-stuck') {
    const instance = randomUUID();
    await c.db.insert(programInstances).values({ id: instance, companyId: c.companyId, agentId: c.operator!.id, nodeId: c.identity.nodeId });
    const [operatorJob] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.operator!.id, subscriptionId: c.sub.id, nodeId: c.identity.nodeId, kind: 'conversation', prompt: 'Stuck operator.', status: 'failed', timeoutMs: 1000 }).returning();
    await c.db.insert(programOperatorCases).values({ companyId: c.companyId, agentId: c.operator!.id, jobId: operatorJob!.id, nodeId: c.identity.nodeId, instance, reason: 'startup_exit', evidenceKey: instance, capability: randomUUID(), status: 'escalated', recoveryHold: true, deadlineAt: c.now });
  }
  await c.alarm('assignment_unrecorded', 60000);
  expect((await c.cases()).find(row => row.agentId === c.agent.id)).toMatchObject({ status: 'escalated', operatorAgentId: null });
  expect(await c.turnsOf(c.operator!.id)).toHaveLength(state === 'already-stuck' ? 1 : 0);
});


it.each([
  { status: 'open', recoveryHold: false, selected: false },
  { status: 'escalated', recoveryHold: false, selected: true },
  { status: 'escalated', recoveryHold: true, selected: false },
] as const)('selects an operator with own $status case and hold=$recoveryHold only when available=$selected', async ({ status, recoveryHold, selected }) => {
  const c = await fixture();
  const instance = randomUUID();
  await c.db.insert(programInstances).values({ id: instance, companyId: c.companyId, agentId: c.operator!.id, nodeId: c.identity.nodeId });
  const [operatorJob] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.operator!.id, subscriptionId: c.sub.id, nodeId: c.identity.nodeId, kind: 'conversation', prompt: 'Previous operator turn.', status: 'failed', timeoutMs: 1000 }).returning();
  await c.db.insert(programOperatorCases).values({ companyId: c.companyId, agentId: c.operator!.id, jobId: operatorJob!.id, nodeId: c.identity.nodeId, instance, reason: 'startup_exit', evidenceKey: instance, capability: randomUUID(), status, recoveryHold, deadlineAt: new Date(+c.now + 600000) });
  await c.attempt(); await c.alarm('assignment_unrecorded', 60000);
  const target = (await c.cases()).find(row => row.agentId === c.agent.id)!;
  expect(target).toMatchObject({ status: selected ? 'open' : 'escalated', operatorAgentId: selected ? c.operator!.id : null });
  expect((await c.turnsOf(c.operator!.id)).filter(job => job.id !== operatorJob!.id)).toHaveLength(selected ? 1 : 0);
  await checkOperatorHealth(c.ctx, c.now);
  expect((await c.cases()).find(row => row.id === target.id)).toMatchObject({ status: target.status, operatorAgentId: target.operatorAgentId });
});

it('binds a new turn question to a fresh case when the same physical program retains an old live-failure case', async () => {
  const c = await fixture();
  await c.launch();
  for (let i = 0; i < 3; i++) await (await liveInput(c)).finish('not_taken');
  const [old] = await c.cases();
  expect(old).toMatchObject({ jobId: c.job.id, reason: 'live_words_not_taken', status: 'open' });
  await c.db.update(jobs).set({ status: 'done', finishedAt: c.now }).where(eq(jobs.id, c.job.id));
  const later = new Date(+c.now + 100000);
  const [currentJob] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, nodeId: c.identity.nodeId, kind: 'conversation', prompt: 'The next turn.', status: 'running', startedAt: later, timeoutMs: 1000 }).returning();
  const question = { id: randomUUID(), kind: 'permission' as const, tool: 'Bash', text: 'Read the next checkout?', callId: 'new-job' };
  const identity = { agentKey: c.agent.id, jobId: currentJob!.id, instance: c.fact.instance };
  await c.record({ type: 'program.question', ...identity, evidenceId: randomUUID(), ordinal: 0, phase: 'asked', question, questionOrdinal: 1, elapsedMs: 0 }, later);
  const needed: OperatorEvidence = { type: 'program.operator_needed', ...identity, evidenceId: randomUUID(), ordinal: 0, reason: 'question_waiting', questionId: question.id, deliveryId: null, evidenceKey: question.id, elapsedMs: 30000, sinceLaunchMs: 30000, exit: null };
  await c.record(needed, later);
  const rows = await c.cases();
  const current = rows.find(row => row.status === 'open');
  expect(current).toMatchObject({ jobId: currentJob!.id, reason: 'question_waiting', evidenceKey: question.id });
  expect(current!.id).not.toBe(old!.id);
  expect(current!.capability).not.toBe(old!.capability);
  expect(+current!.deadlineAt).toBe(+later + 600000);
  expect(rows.find(row => row.id === old!.id)).toMatchObject({ status: 'resolved', deadlineAt: old!.deadlineAt, evidence: old!.evidence });
  expect(await operatorCaseMode(c.ctx, current!)).toMatchObject({ reason: 'question_waiting', question, questionId: question.id, readOnly: false });
  expect(c.sent.mock.calls).toContainEqual([expect.anything(), expect.objectContaining({ type: 'program.operator_case', case: old!.id, jobId: c.job.id, disposition: 'revoke' })]);
  expect(c.sent.mock.calls).toContainEqual([expect.anything(), expect.objectContaining({ type: 'program.operator_case', case: current!.id, jobId: currentJob!.id, disposition: 'open', questionId: question.id })]);
  await c.alarm('startup_exit', 60000);
  await c.record(needed, new Date(+later + 1000));
  expect(await c.cases()).toHaveLength(2);
  expect((await c.cases()).find(row => row.id === current!.id)).toMatchObject({ status: 'open', deadlineAt: current!.deadlineAt, evidence: current!.evidence });
  expect(await c.turnsOf(c.operator!.id)).toHaveLength(2);
});


it('retains assignment recovery when the matching node operator timeout fails the job before server expiry', async () => {
  const c = await fixture();
  await c.attempt(); await c.alarm('assignment_unrecorded', 60000);
  const [incident] = await c.cases();
  const expired = new Date(+incident!.deadlineAt);
  await c.db.update(jobs).set({ status: 'failed', error: 'agent_failed', finishedAt: expired, failure: { kind: 'unknown', text: `Program operator recovery ended: operator_timeout; case ${incident!.id}.`, retryable: false } }).where(eq(jobs.id, c.job.id));
  expect(await afterFailure(c.ctx, c.job.id)).toBe(true);
  await expireOperatorCases(c.ctx, expired);
  expect((await c.cases())[0]).toMatchObject({ status: 'escalated', recoveryHold: true, resolution: { outcome: 'operator_timeout' } });
  expect(await resumeOperatorProcess(c.ctx, c.agent.id, c.identity.nodeId)).toBe(true);
  expect(await resumeOperatorProcess(c.ctx, c.agent.id, c.identity.nodeId)).toBe(false);
  expect(await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id))).toHaveLength(1);
  expect(await c.jobOf(c.job.id)).toMatchObject({ status: 'failed', error: 'agent_failed' });
});

it.each(['another-case', 'ordinary-failure', 'cancelled', 'stale'])('does not retain operator recovery for a prior %s job failure', async failure => {
  const c = await fixture();
  await c.attempt(); await c.alarm('assignment_unrecorded', 60000);
  const [incident] = await c.cases();
  const text = failure === 'ordinary-failure' ? 'The program failed elsewhere.' : `Program operator recovery ended: operator_timeout; case ${failure === 'another-case' ? randomUUID() : incident!.id}.`;
  await c.db.update(jobs).set({ status: 'failed', error: failure === 'cancelled' || failure === 'stale' ? failure : 'agent_failed', failure: { kind: 'unknown', text, retryable: false } }).where(eq(jobs.id, c.job.id));
  await expireOperatorCases(c.ctx, new Date(+incident!.deadlineAt));
  expect((await c.cases())[0]).toMatchObject({ status: 'escalated', recoveryHold: false });
  expect(await resumeOperatorProcess(c.ctx, c.agent.id, c.identity.nodeId)).toBe(false);
  expect(await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id))).toEqual([]);
});

it('keeps the running job question current when a prior job instance first reports after it', async () => {
  const c = await fixture();
  await c.launch();
  const question = { id: randomUUID(), kind: 'permission' as const, tool: 'Bash', text: 'Read this checkout?', callId: 'current' };
  const identity = { agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance };
  await c.record({ type: 'program.question', ...identity, evidenceId: randomUUID(), ordinal: 0, phase: 'asked', question, questionOrdinal: 1, elapsedMs: 0 });
  await c.record({ type: 'program.operator_needed', ...identity, evidenceId: randomUUID(), ordinal: 0, reason: 'question_waiting', questionId: question.id, deliveryId: null, evidenceKey: question.id, elapsedMs: 30000, sinceLaunchMs: 30000, exit: null });
  const [oldJob] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, nodeId: c.identity.nodeId, kind: 'conversation', prompt: 'Earlier turn.', status: 'done', createdAt: new Date(+c.now - 600000), finishedAt: new Date(+c.now - 300000), timeoutMs: 1000 }).returning();
  await c.record({ type: 'program.launch', agentKey: c.agent.id, jobId: oldJob!.id, instance: randomUUID(), evidenceId: randomUUID(), ordinal: 0, phase: 'attempt', elapsedMs: 0 });
  const [current] = await c.cases();
  expect(current).toMatchObject({ instance: c.fact.instance, jobId: c.job.id, status: 'open', readOnly: false });
  expect(await operatorCaseMode(c.ctx, current!)).toMatchObject({ questionId: question.id, question, readOnly: false });
});

it('retains one canonical live-failure case when a late pending prefix moves the computed third receipt', async () => {
  const c = await fixture();
  const pending = await liveInput(c);
  const failures = [await liveInput(c), await liveInput(c), await liveInput(c)];
  for (const input of failures) await input.finish('not_taken');
  const [incident] = await c.cases();
  expect(incident).toMatchObject({ status: 'open', evidenceKey: failures[2]!.delivery.id });
  await pending.finish('not_taken');
  expect(await c.cases()).toHaveLength(1);
  expect((await c.cases())[0]).toMatchObject({ id: incident!.id, status: 'open', evidence: incident!.evidence, deadlineAt: incident!.deadlineAt });
  expect(await c.turnsOf(c.operator!.id)).toHaveLength(1);
});
