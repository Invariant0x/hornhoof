import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { expect, it, onTestFinished, vi } from 'vitest';
import { OPERATOR_CASE_MS, type OperatorRecoveryState } from '@hornhoof/protocol/program-operator';
import { agentEvents, agents, departments, jobs, machines, nodes, programDeliveries, programInstances, programOperatorCases, subscriptions, tasks } from '../src/db/schema.js';
import { idOnly, only } from '../src/db/selections.js';
import { instructionsOf } from '../src/modules/agents/instructions.js';
import { enqueueTurn, pump } from '../src/modules/conversation/queue.js';
import { failOpenJobs } from '../src/modules/nodes/messages.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { afterRestart, afterRestartOutsideTask } from '../src/modules/tasks/restarts.js';
import { recordJobProgram } from '../src/modules/tasks/silent.js';
import { reserveDelivery } from '../src/modules/program-operator/deliveries.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { adoptOperatorOwnerTurn, continueRecovery } from '../src/modules/program-operator/recovery.js';
import { checkOperatorHealth } from '../src/modules/program-operator/health.js';
import { releaseRecoveryHold } from '../src/modules/program-operator/release.js';
import { receiveOperatorReply } from '../src/modules/program-operator/rpc.js';
import { hashToken } from '../src/crypto/tokens.js';
import { listen, mcp, until } from './helpers.js';
import { operatorCompany } from './program-operator-company.js';

const MINUTE = 60_000;

/* Whom Hornhoof answers for: the person the words of a turn stand for, who has that turn's rights. */
const principalOf = async (c: { db: Awaited<ReturnType<typeof operatorCompany>>['db'] }, jobId: string) =>
  (await c.db.select(only(agentEvents, 'personId')).from(agentEvents).where(and(eq(agentEvents.jobId, jobId), inArray(agentEvents.kind, ['message', 'typed'])))).map(word => word.personId);

/* Words the program never recorded: their case escalated at once with nobody to take it, and they wait on a hold. */
async function held(options: { before?: (c: Awaited<ReturnType<typeof operatorCompany>>) => Promise<void>; failed?: boolean } = {}) {
  const c = await operatorCompany(false);
  const now = new Date(); let ordinal = 0;
  const record = (input: Parameters<typeof acceptOperatorEvidence>[2]) => acceptOperatorEvidence(c.ctx, c.identity, { ...input, evidenceId: randomUUID(), ordinal: ordinal++ }, now);
  await record(c.fact);
  await options.before?.(c);
  await record({ type: 'program.operator_needed', agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 0, reason: 'assignment_unrecorded', deliveryId: c.delivery.id, evidenceKey: c.delivery.id, elapsedMs: 60000, sinceLaunchMs: 60000, exit: null });
  const [incident] = await c.db.select().from(programOperatorCases);
  if (options.failed !== false) await c.db.update(jobs).set({ status: 'failed', error: 'agent_failed', failure: { kind: 'unknown', text: `Program operator recovery ended: operator_unavailable; case ${incident!.id}.`, retryable: false }, finishedAt: now }).where(eq(jobs.id, c.job.id));
  const program = { agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance };
  const ready = (owner?: boolean) => record({ type: 'program.recovery_ready', ...program, evidenceId: randomUUID(), ordinal: 0, case: incident!.id, ...(owner === undefined ? {} : { owner }) });
  const children = () => c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id));
  const row = async () => (await c.db.select().from(programOperatorCases).where(eq(programOperatorCases.id, incident!.id)))[0]!;
  return { ...c, now, incident: incident!, record, ready, children, row, program };
}
type Held = Awaited<ReturnType<typeof held>>;

const hire = async (c: Held, name: string, kind: 'worker' | 'head', roleKey: string) => {
  const [dept] = await c.db.select().from(departments).where(eq(departments.id, c.watcher.departmentId!));
  return (await c.db.insert(agents).values({ companyId: c.companyId, name, kind, roleKey, departmentId: dept!.id, subscriptionId: c.sub.id, model: '' }).returning())[0]!;
};

it('goes on by itself once from a program at its empty prompt, with the author and session of the original', async () => {
  const c = await held();
  await c.db.update(jobs).set({ createdBy: c.sub.ownerPersonId, sessionId: 'session' }).where(eq(jobs.id, c.job.id));
  await c.ready(false); await c.ready(false);
  const children = await c.children();
  expect(children).toHaveLength(1);
  expect(children[0]).toMatchObject({ createdBy: c.sub.ownerPersonId, prompt: expect.stringContaining('Words.') });
  expect(await c.row()).toMatchObject({ status: 'resolved', recoveryHold: false, continuationJobId: children[0]!.id, resolution: { outcome: 'went_on' } });
  expect(await c.jobOf(c.job.id)).toMatchObject({ status: 'failed', error: 'agent_failed' });
});

it('goes on by itself only once for its words, and then waits for a person or Operations', async () => {
  const c = await held();
  await c.ready(false);
  const [child] = await c.children();
  /* The continuation is lost the same way: its own case and hold. */
  const instance = randomUUID();
  await c.db.insert(programInstances).values({ id: instance, companyId: c.companyId, agentId: c.agent.id, nodeId: c.identity.nodeId });
  await c.db.update(jobs).set({ status: 'failed', error: 'agent_failed', finishedAt: new Date(), nodeId: c.identity.nodeId, subscriptionId: c.sub.id }).where(eq(jobs.id, child!.id));
  const [second] = await c.db.insert(programOperatorCases).values({ companyId: c.companyId, agentId: c.agent.id, jobId: child!.id, nodeId: c.identity.nodeId, instance, reason: 'assignment_unrecorded', evidenceKey: child!.id, deliveryId: c.delivery.id, capability: randomUUID(), evidence: [], status: 'escalated', deadlineAt: new Date(), escalatedAt: new Date(), recoveryHold: true }).returning();
  let said = 0;
  const again = (owner: boolean) => acceptOperatorEvidence(c.ctx, c.identity, { type: 'program.recovery_ready', agentKey: c.agent.id, jobId: child!.id, instance, evidenceId: randomUUID(), ordinal: said++, case: second!.id, owner }, new Date());
  expect(await again(false)).toBe(true);
  expect(await c.db.select().from(jobs).where(eq(jobs.continueOf, child!.id))).toEqual([]);
  expect((await c.db.select().from(programOperatorCases).where(eq(programOperatorCases.id, second!.id)))[0]).toMatchObject({ recoveryHold: true });
  expect(await again(true)).toBe(true);
  expect(await c.db.select().from(jobs).where(eq(jobs.continueOf, child!.id))).toHaveLength(1);
});

it('goes on by itself once along all the turns its words went on in, also after Operations let them through between', async () => {
  const c = await held();
  await c.ready(false);
  const [child] = await c.children();
  /* Each turn the words go on in is lost the same way, on the same program: its own case and hold. */
  const lost = async (job: string) => {
    await c.db.update(jobs).set({ status: 'failed', error: 'agent_failed', finishedAt: new Date(), nodeId: c.identity.nodeId, subscriptionId: c.sub.id }).where(eq(jobs.id, job));
    return (await c.db.insert(programOperatorCases).values({ companyId: c.companyId, agentId: c.agent.id, jobId: job, nodeId: c.identity.nodeId, instance: c.fact.instance, reason: 'assignment_unrecorded', evidenceKey: job, deliveryId: c.delivery.id, capability: randomUUID(), evidence: [], status: 'escalated', deadlineAt: new Date(), escalatedAt: new Date(), recoveryHold: true }).returning())[0]!;
  };
  const second = await lost(child!.id);
  await continueRecovery(c.ctx, second, { outcome: 'released', text: 'Rob of Operations released the hold; the original words continue once.' });
  const [grandchild] = await c.db.select().from(jobs).where(eq(jobs.continueOf, child!.id));
  const third = await lost(grandchild!.id);
  await acceptOperatorEvidence(c.ctx, c.identity, { type: 'program.recovery_ready', agentKey: c.agent.id, jobId: grandchild!.id, instance: c.fact.instance, evidenceId: randomUUID(), ordinal: 100, case: third.id, owner: false }, new Date());
  expect(await c.db.select().from(jobs).where(eq(jobs.continueOf, grandchild!.id))).toEqual([]);
  expect((await c.db.select().from(programOperatorCases).where(eq(programOperatorCases.id, third.id)))[0]).toMatchObject({ recoveryHold: true });
});

it('still lets an owner through who said so without the new field', async () => {
  const c = await held();
  await c.ready();
  expect(await c.children()).toHaveLength(1);
  expect(await c.row()).toMatchObject({ resolution: { outcome: 'owner_recovered' } });
});

it('goes on without anyone once the program that waited is gone, as after a node restart', async () => {
  const c = await held();
  await c.db.update(jobs).set({ error: 'machine_restarted', failure: null }).where(eq(jobs.id, c.job.id));
  await c.record({ ...c.fact, phase: 'cancelled', elapsedMs: 70000 });
  const children = await c.children();
  expect(children).toHaveLength(1);
  expect(await c.row()).toMatchObject({ recoveryHold: false, continuationJobId: children[0]!.id, resolution: { outcome: 'program_gone' } });
  await checkOperatorHealth(c.ctx); await checkOperatorHealth(c.ctx);
  expect(await c.children()).toHaveLength(1);
});

const retriesOf = (c: Held) => c.db.select().from(jobs).where(eq(jobs.retryOf, c.job.id));
const onATask = async (c: Held) => {
  const { task } = await createTask(c.ctx, { agentId: c.head.id }, { title: 'Checkout', brief: '', body: 'POST /checkout.', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true });
  await c.db.update(jobs).set({ taskId: task.id }).where(eq(jobs.id, c.job.id));
};
const askedByItsOwner = (c: Held) => c.db.update(jobs).set({ createdBy: c.sub.ownerPersonId }).where(eq(jobs.id, c.job.id));

it.each<[string, (c: Held) => Promise<unknown>]>([['on a task', onATask], ['outside any task', askedByItsOwner]])('takes the retry a node restart queued %s for the words going on: they run once', async (_where, how) => {
  const c = await held({ failed: false });
  await how(c);
  await failOpenJobs(c.ctx, eq(jobs.id, c.job.id), 'machine_restarted');
  const retries = await retriesOf(c);
  expect(retries).toHaveLength(1);
  await c.record({ ...c.fact, phase: 'cancelled', elapsedMs: 70000 });
  await checkOperatorHealth(c.ctx); await checkOperatorHealth(c.ctx);
  expect(await c.children()).toEqual([]);
  expect(await retriesOf(c)).toHaveLength(1);
  expect(await c.row()).toMatchObject({ recoveryHold: false, continuationJobId: retries[0]!.id, resolution: { outcome: 'program_gone' } });
});

it.each<[string, (c: Held) => Promise<unknown>, (c: Held) => Promise<unknown>]>([
  ['on a task', onATask, c => afterRestart(c.ctx, c.job.id)],
  ['outside any task', askedByItsOwner, c => afterRestartOutsideTask(c.ctx, c.job.id)],
])('queues no retry %s for words already going on from their hold', async (_where, how, restarted) => {
  const c = await held();
  await how(c);
  await c.db.update(jobs).set({ error: 'machine_restarted', failure: null }).where(eq(jobs.id, c.job.id));
  await c.record({ ...c.fact, phase: 'cancelled', elapsedMs: 70000 });
  expect(await c.children()).toHaveLength(1);
  await restarted(c);
  expect(await retriesOf(c)).toEqual([]);
  expect(await c.children()).toHaveLength(1);
});

it('leaves the retry of a cut turn to run after a late receipt: being recorded does not make it done', async () => {
  const c = await held({ failed: false });
  await askedByItsOwner(c);
  await failOpenJobs(c.ctx, eq(jobs.id, c.job.id), 'machine_restarted');
  const [retry] = await retriesOf(c);
  c.ctx.hub.isReady = () => false;
  await c.ready(true);
  expect(await c.row()).toMatchObject({ recoveryHold: false, continuationJobId: retry!.id });
  await c.record({ ...c.fact, phase: 'taken', elapsedMs: 90000 });
  expect(await c.jobOf(retry!.id)).toMatchObject({ status: 'queued' });
});

it('leaves the retry of a cut turn to run when its owner starts a turn of their own, linked to the hold or not', async () => {
  for (const linked of [false, true]) {
    const c = await held({ failed: false });
    await askedByItsOwner(c);
    await failOpenJobs(c.ctx, eq(jobs.id, c.job.id), 'machine_restarted');
    const [retry] = await retriesOf(c);
    c.ctx.hub.isReady = () => false;
    if (linked) await c.record({ ...c.fact, phase: 'cancelled', elapsedMs: 70000 });
    const [typed] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, nodeId: c.identity.nodeId, kind: 'conversation', prompt: 'Words of its owner.', timeoutMs: 1000, status: 'running' }).returning();
    await adoptOperatorOwnerTurn(c.ctx, c.agent.id, typed!.id, c.identity.nodeId);
    expect(await c.jobOf(retry!.id)).toMatchObject({ status: 'queued' });
    expect(await c.row()).toMatchObject({ recoveryHold: false, resolution: { outcome: 'owner_turn' } });
  }
});

it('ends the hold as stopped when somebody stopped the turn its words went on in, with no second turn', async () => {
  const c = await held({ failed: false });
  await askedByItsOwner(c);
  await failOpenJobs(c.ctx, eq(jobs.id, c.job.id), 'machine_restarted');
  const [retry] = await retriesOf(c);
  await c.db.update(jobs).set({ status: 'failed', error: 'cancelled', finishedAt: new Date() }).where(eq(jobs.id, retry!.id));
  await c.record({ ...c.fact, phase: 'cancelled', elapsedMs: 70000 });
  expect(await c.children()).toEqual([]);
  expect(await c.row()).toMatchObject({ recoveryHold: false, continuationJobId: null, resolution: { outcome: 'stopped' } });
});

it('ends the hold of an agent that was removed, runs nothing for it and calls nobody about it', async () => {
  const c = await held();
  const rob = await hire(c, 'Rob', 'worker', 'OPS-PROGRAM');
  await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.agent.id));
  await c.ready(true);
  expect(await c.children()).toEqual([]);
  await checkOperatorHealth(c.ctx, new Date(Date.now() + 6 * MINUTE));
  expect(await c.row()).toMatchObject({ recoveryHold: false, continuationJobId: null, resolution: { outcome: 'stopped' } });
  expect(await turnsWith(c, rob.id, c.incident.id)).toEqual([]);
  expect(await c.children()).toEqual([]);
});

it.each(['removed', 'switched_off'])('does not send again the words of a turn that ended as %s', async error => {
  const c = await held();
  await c.db.update(jobs).set({ error, failure: null }).where(eq(jobs.id, c.job.id));
  await c.record({ ...c.fact, phase: 'cancelled', elapsedMs: 70000 });
  await checkOperatorHealth(c.ctx);
  expect(await c.children()).toEqual([]);
  expect(await c.row()).toMatchObject({ recoveryHold: false, continuationJobId: null, resolution: { outcome: 'stopped' } });
});

it('keeps the hold while the agent has no plan to run the words, with the round going on, and goes on once it has one', async () => {
  const c = await held();
  await c.db.update(jobs).set({ error: 'machine_restarted', failure: null }).where(eq(jobs.id, c.job.id));
  await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, c.agent.id));
  await c.record({ ...c.fact, phase: 'cancelled', elapsedMs: 70000 });
  await checkOperatorHealth(c.ctx);
  expect(await c.children()).toEqual([]);
  expect((await c.row()).recoveryHold).toBe(true);
  await c.db.update(agents).set({ subscriptionId: c.sub.id }).where(eq(agents.id, c.agent.id));
  await checkOperatorHealth(c.ctx);
  expect(await c.children()).toHaveLength(1);
});

it('ends the hold when the task no longer waits for the words, which nothing else would ever end', async () => {
  const c = await held();
  const { task } = await createTask(c.ctx, { agentId: c.head.id }, { title: 'Checkout', brief: '', body: 'POST /checkout.', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true });
  await c.db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, task.id));
  await c.db.update(jobs).set({ taskId: task.id, error: 'machine_restarted', failure: null }).where(eq(jobs.id, c.job.id));
  await c.record({ ...c.fact, phase: 'cancelled', elapsedMs: 70000 });
  await checkOperatorHealth(c.ctx);
  expect(await c.children()).toEqual([]);
  expect(await c.row()).toMatchObject({ status: 'resolved', recoveryHold: false, continuationJobId: null, resolution: { outcome: 'not_awaited' } });
});

it('goes on from the minute round when the node said so before its turn failed', async () => {
  const c = await held({ failed: false });
  await c.record({ ...c.fact, phase: 'cancelled', elapsedMs: 70000 });
  expect(await c.children()).toEqual([]);
  expect((await c.row()).recoveryHold).toBe(true);
  await c.db.update(jobs).set({ status: 'failed', error: 'machine_restarted', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  await checkOperatorHealth(c.ctx);
  expect(await c.children()).toHaveLength(1);
});

it('does not go on over a program that still has the words pending and no sign it left', async () => {
  const c = await held();
  await checkOperatorHealth(c.ctx);
  expect(await c.children()).toEqual([]);
  expect((await c.row()).recoveryHold).toBe(true);
});

it('ends the hold of a turn a person stopped, and the queue goes on', async () => {
  const c = await held();
  await c.db.update(jobs).set({ error: 'cancelled' }).where(eq(jobs.id, c.job.id));
  const later = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Later words.', createdBy: null });
  expect(await c.jobOf(later)).toMatchObject({ status: 'queued' });
  await checkOperatorHealth(c.ctx);
  expect(await c.children()).toEqual([]);
  expect(await c.row()).toMatchObject({ recoveryHold: false, continuationJobId: null, resolution: { outcome: 'stopped' } });
  await pump(c.ctx, c.agent.id);
  expect(await c.jobOf(later)).toMatchObject({ status: 'running' });
});

it('ends the hold of a turn that finished after all, with no second run of its words', async () => {
  const c = await held({ failed: false });
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  await checkOperatorHealth(c.ctx);
  expect(await c.children()).toEqual([]);
  expect(await c.row()).toMatchObject({ recoveryHold: false, continuationJobId: null, resolution: { outcome: 'finished' } });
});

it('names a recorded receipt for what it is: no continuation and no recovery claimed', async () => {
  const c = await held();
  await c.record({ ...c.fact, phase: 'taken', elapsedMs: 70000 });
  expect(await c.children()).toEqual([]);
  expect(await c.row()).toMatchObject({ recoveryHold: false, continuationJobId: null, resolution: { outcome: 'recorded' } });
});

it('holds words of a program that goes on its session, whatever it did before them', async () => {
  const c = await held({ before: async c => { await c.db.update(programInstances).set({ active: true }).where(eq(programInstances.id, c.fact.instance)); } });
  expect((await c.row()).recoveryHold).toBe(true);
});

it('does not hold words whose own delivery showed the program at work', async () => {
  const c = await held({ before: async c => {
    await acceptOperatorEvidence(c.ctx, c.identity, { ...c.fact, evidenceId: randomUUID(), ordinal: 90, phase: 'activity', elapsedMs: 1000 }, new Date());
  } });
  expect((await c.row()).recoveryHold).toBe(false);
});

const turnsWith = async (c: Held, agentId: string, word: string) =>
  (await c.db.select().from(jobs).where(eq(jobs.agentId, agentId)).orderBy(asc(jobs.createdAt))).filter(job => job.prompt.includes(word) && job.prompt.includes('program_recovery_release'));

it('calls the program operator once for a hold of more than five minutes, with the way to see the program and release it', async () => {
  const c = await held();
  const rob = await hire(c, 'Rob', 'worker', 'OPS-PROGRAM');
  const since = +(await c.row()).escalatedAt!;
  await checkOperatorHealth(c.ctx, new Date(since + 5 * MINUTE));
  expect(await turnsWith(c, rob.id, c.incident.id)).toEqual([]);
  await checkOperatorHealth(c.ctx, new Date(since + 5 * MINUTE + 1));
  await checkOperatorHealth(c.ctx, new Date(since + 6 * MINUTE));
  const calls = await turnsWith(c, rob.id, c.incident.id);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.prompt).toContain('program_recovery_release');
  expect(calls[0]!.prompt).toContain('Never free a hold any other way');
  expect(calls[0]!.prompt).toContain(`program_screen for employee ${c.agent.id}`);
  expect((await c.row()).recoveryHold).toBe(true);
});

it('calls the head of Operations when the program operator is off, and never the reliability engineer', async () => {
  const c = await held();
  const fixer = await hire(c, 'Fay', 'worker', 'OPS-FIX');
  const rob = await hire(c, 'Rob', 'worker', 'OPS-PROGRAM'), olga = await hire(c, 'Olga', 'head', 'OPS-HEAD');
  await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, rob.id));
  await checkOperatorHealth(c.ctx, new Date(Date.now() + 6 * MINUTE));
  expect(await turnsWith(c, rob.id, c.incident.id)).toEqual([]);
  expect(await turnsWith(c, fixer.id, c.incident.id)).toEqual([]);
  expect(await turnsWith(c, olga.id, c.incident.id)).toHaveLength(1);
});

it('never calls the agent that is on hold about itself, nor one that waits on a hold of its own', async () => {
  const c = await held();
  await c.db.update(agents).set({ roleKey: 'OPS-PROGRAM', departmentId: c.watcher.departmentId }).where(eq(agents.id, c.agent.id));
  const olga = await hire(c, 'Olga', 'head', 'OPS-HEAD');
  await checkOperatorHealth(c.ctx, new Date(Date.now() + 6 * MINUTE));
  expect(await turnsWith(c, c.agent.id, c.incident.id)).toEqual([]);
  expect(await turnsWith(c, olga.id, c.incident.id)).toHaveLength(1);
});

it('calls the orchestrator when all of Operations is off, and only once', async () => {
  const c = await held();
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  await checkOperatorHealth(c.ctx, new Date(Date.now() + 6 * MINUTE));
  await checkOperatorHealth(c.ctx, new Date(Date.now() + 7 * MINUTE));
  expect(await turnsWith(c, orchestrator!.id, c.incident.id)).toHaveLength(1);
});

it('tells the orchestrator to see the program and release it itself, and still calls Operations once it can take it', async () => {
  const c = await held();
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  await checkOperatorHealth(c.ctx, new Date(Date.now() + 6 * MINUTE));
  const [told] = await turnsWith(c, orchestrator!.id, c.incident.id);
  expect(told!.prompt).toContain('Neither the program operator nor the head of Operations can take this now');
  expect(told!.prompt).toContain(`program_screen for employee ${c.agent.id}`);
  expect(told!.prompt).toContain('release the hold with program_recovery_release');
  const rob = await hire(c, 'Rob', 'worker', 'OPS-PROGRAM');
  await checkOperatorHealth(c.ctx, new Date(Date.now() + 7 * MINUTE));
  await checkOperatorHealth(c.ctx, new Date(Date.now() + 8 * MINUTE));
  expect(await turnsWith(c, rob.id, c.incident.id)).toHaveLength(1);
  expect(await turnsWith(c, orchestrator!.id, c.incident.id)).toHaveLength(1);
});

it('calls only who can release it: never the head of a part of Operations in place of its head', async () => {
  const c = await held();
  const [part] = await c.db.insert(departments).values({ companyId: c.companyId, name: 'Watch', roleCode: 'WATCH', parentId: c.watcher.departmentId }).returning();
  const [sam] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Sam', kind: 'head', roleKey: 'WATCH-HEAD', departmentId: part!.id, subscriptionId: c.sub.id, model: '' }).returning();
  const olga = await hire(c, 'Olga', 'head', 'OPS-HEAD');
  await checkOperatorHealth(c.ctx, new Date(Date.now() + 6 * MINUTE));
  expect(await turnsWith(c, sam!.id, c.incident.id)).toEqual([]);
  expect(await turnsWith(c, olga.id, c.incident.id)).toHaveLength(1);
});

const FREE: Omit<OperatorRecoveryState, 'type' | 'agentKey' | 'jobId' | 'instance' | 'request'> = { program: 'here', current: null, generation: 7, input: 'empty', wait: null, runningTool: false, retrying: false, busy: false };

function showRecoveryState(c: Held, facts: Partial<typeof FREE> | null): void {
  c.sent.mockImplementation((_node, frame) => {
    if (frame.type === 'program.recovery_state_get' && facts) queueMicrotask(() => receiveOperatorReply(c.ctx, c.identity, { type: 'program.recovery_state', ...c.program, request: frame.request, ...FREE, current: c.program.instance, ...facts }));
    return true;
  });
}

it.each<[string, Partial<typeof FREE>]>([
  ['an idle program', {}],
  ['no program', { program: 'gone', current: null, input: 'unknown' }],
])('automatically releases the unavailable operator hold with %s and restarts the queue', async (_screen, facts) => {
  const c = await held();
  const head = await hire(c, 'Operations lead', 'head', 'OPS-HEAD');
  showRecoveryState(c, facts);
  const waiting = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Later words.', createdBy: null });
  expect(await c.jobOf(waiting)).toMatchObject({ status: 'queued' });
  expect(await c.row()).toMatchObject({ recoveryHold: true, resolution: { outcome: 'operator_unavailable' } });

  await checkOperatorHealth(c.ctx, new Date(+c.now + 6 * MINUTE));
  await checkOperatorHealth(c.ctx, new Date(+c.now + 7 * MINUTE));

  const children = await c.children();
  expect(children).toHaveLength(1);
  expect(children[0]).toMatchObject({ status: 'running' });
  expect(await c.row()).toMatchObject({ status: 'resolved', recoveryHold: false, continuationJobId: children[0]!.id });
  expect(await turnsWith(c, head.id, c.incident.id)).toEqual([]);
});

it.each<[string, Partial<typeof FREE>]>([
  ['a question', { wait: 'permission' }],
  ['a person’s unsent words', { input: 'text' }],
])('keeps the unavailable operator hold with %s and writes each responder once', async (_screen, facts) => {
  const c = await held();
  const head = await hire(c, 'Operations lead', 'head', 'OPS-HEAD');
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const waiting = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Later words.', createdBy: null });
  showRecoveryState(c, facts);
  await checkOperatorHealth(c.ctx, new Date(+c.now + 6 * MINUTE));
  await checkOperatorHealth(c.ctx, new Date(+c.now + 7 * MINUTE));

  expect(await c.row()).toMatchObject({ recoveryHold: true });
  expect(await c.jobOf(waiting)).toMatchObject({ status: 'queued' });
  const heldSince = c.incident.escalatedAt!.toISOString();
  for (const responder of [orchestrator!, head]) {
    const calls = await turnsWith(c, responder.id, c.incident.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain(c.agent.name);
    expect(calls[0]!.prompt).toContain(heldSince);
  }

  showRecoveryState(c, {});
  await checkOperatorHealth(c.ctx, new Date(+c.now + 8 * MINUTE));
  expect(await c.row()).toMatchObject({ recoveryHold: false });
});

/* The tool of Operations, with the node answering what it sees right now. */
async function release(facts: Partial<typeof FREE> | null = {}, roleKey = 'OPS-PROGRAM', kind: 'worker' | 'head' = 'worker') {
  const c = await held();
  const rob = await hire(c, 'Rob', kind, roleKey);
  const [turn] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: rob.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Look at the hold.', timeoutMs: 1000, status: 'running' }).returning();
  showRecoveryState(c, facts);
  const caller = { id: turn!.id, companyId: c.companyId, agentId: rob.id };
  const call = (reason = 'The program stands ready and the words wait.') => releaseRecoveryHold(c.ctx, caller, { case: c.incident.id, reason });
  const audits = async () => (await c.db.select().from(agentEvents).where(sql`${agentEvents.data}->'recoveryRelease' is not null`)).map(event => (event.data as { recoveryRelease: unknown }).recoveryRelease);
  return { ...c, rob, turn: turn!, caller, call, audits };
}

it('lets Operations release a hold and deliver its saved words once, and records who, when, why and what', async () => {
  const c = await release();
  expect(await c.call()).toMatchObject({ result: 'released', continuation: expect.any(String) });
  const children = await c.children();
  expect(children).toHaveLength(1);
  expect(await c.row()).toMatchObject({ recoveryHold: false, continuationJobId: children[0]!.id, resolution: { outcome: 'released', actor: { id: c.rob.id, name: 'Rob' } } });
  expect(await c.audits()).toEqual([expect.objectContaining({ actor: { id: c.rob.id, name: 'Rob', role: 'OPS-PROGRAM' }, reason: 'The program stands ready and the words wait.', at: expect.any(String), result: 'released', action: 'release_and_deliver', job: c.job.id, instance: c.program.instance, generation: 7, input: 'empty', continuation: children[0]!.id })]);
  expect(await c.call()).toMatchObject({ result: 'no_hold', continuation: children[0]!.id });
  expect(await c.children()).toHaveLength(1);
});

it.each<[string, string, 'worker' | 'head', boolean]>([
  ['a program operator', 'OPS-PROGRAM', 'worker', true],
  ['the head of Operations', 'OPS-HEAD', 'head', true],
  ['the reliability engineer', 'OPS-FIX', 'worker', false],
  ['a developer', 'DEV-BE', 'worker', false],
])('offers the tool to %s: %s', async (_name, roleKey, kind, offered) => {
  const c = await held();
  const someone = await hire(c, 'Rob', kind, roleKey);
  const token = randomUUID();
  await c.db.insert(jobs).values({ companyId: c.companyId, agentId: someone.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Look.', timeoutMs: 1000, status: 'running', toolTokenHash: hashToken(token) });
  await listen(c.app);
  const { tools } = await (await mcp(c.app, token)).listTools();
  expect(tools.some(tool => tool.name === 'program_recovery_release')).toBe(offered);
});

it('lets the head of Operations do the same', async () => {
  const c = await release({}, 'OPS-HEAD', 'head');
  expect(await c.call()).toMatchObject({ result: 'released' });
});

it('lets the orchestrator do the same, and writes its name', async () => {
  const c = await release();
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [turn] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: orchestrator!.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Look at the hold.', timeoutMs: 1000, status: 'running' }).returning();
  expect(await releaseRecoveryHold(c.ctx, { id: turn!.id, companyId: c.companyId, agentId: orchestrator!.id }, { case: c.incident.id, reason: 'Nothing may stand still.' })).toMatchObject({ result: 'released' });
  expect(await c.audits()).toEqual([expect.objectContaining({ actor: { id: orchestrator!.id, name: orchestrator!.name, role: null }, result: 'released' })]);
});

it('refuses the reliability engineer, who is no longer the one to release', async () => {
  const c = await release({}, 'OPS-FIX');
  await expect(c.call()).rejects.toMatchObject({ status: 403 });
  expect(await c.children()).toEqual([]);
});

it("releases a hold whose input holds only Hornhoof's own words that never went: the saved words take their place once", async () => {
  const c = await release({ input: 'hornhoof' });
  expect(await c.call()).toMatchObject({ result: 'released', continuation: expect.any(String) });
  expect(await c.children()).toHaveLength(1);
  expect(await c.audits()).toEqual([expect.objectContaining({ result: 'released', input: 'hornhoof' })]);
});

it('releases a hold whose program is gone', async () => {
  const c = await release({ program: 'gone', input: 'unknown' });
  expect(await c.call()).toMatchObject({ result: 'released' });
  expect(await c.children()).toHaveLength(1);
});

it.each<[string, Partial<typeof FREE>, string]>([
  ['words in the input', { input: 'words' }, 'input_not_proven'],
  ['an input it cannot read', { input: 'unknown' }, 'input_not_proven'],
  ['a protected question', { wait: 'protected' }, 'protected_screen'],
  ['a permission question', { wait: 'permission' }, 'input_not_proven'],
  ['a tool at work', { runningTool: true }, 'program_busy'],
  ['a retry at work', { retrying: true }, 'program_busy'],
  ['a program at work', { busy: true }, 'program_busy'],
])('refuses to pass %s, keeps the hold and records the try', async (_name, facts, reason) => {
  const c = await release(facts);
  expect(await c.call()).toMatchObject({ result: 'refused', reason });
  expect(await c.children()).toEqual([]);
  expect((await c.row()).recoveryHold).toBe(true);
  expect(await c.audits()).toEqual([expect.objectContaining({ result: 'refused', refusal: reason, actor: expect.objectContaining({ id: c.rob.id }) })]);
});

it('refuses when the node does not answer, with no guess about its program', async () => {
  const c = await release(null);
  /* The server waits three seconds for the node's answer: on the test's clock. */
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => { vi.useRealTimers(); });
  let ended = false;
  const answer = c.call().finally(() => { ended = true; });
  await until(() => c.sent.mock.calls.some(([, frame]) => frame.type === 'program.recovery_state_get'));
  await vi.advanceTimersByTimeAsync(2999);
  expect(ended).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await answer).toMatchObject({ result: 'refused', reason: 'node_unavailable' });
  expect(await c.children()).toEqual([]);
});

/* What a person of Operations gets from the tool itself. */
async function throughItsTool(c: Awaited<ReturnType<typeof release>>) {
  const token = randomUUID();
  await c.db.update(jobs).set({ toolTokenHash: hashToken(token) }).where(eq(jobs.id, c.turn.id));
  await listen(c.app);
  const client = await mcp(c.app, token);
  return async (input: { case: string; reason: string }) => await client.callTool({ name: 'program_recovery_release', arguments: input }) as { content: { text: string }[]; isError?: boolean };
}

it('answers through its tool with what came of it, and says so when it is no release at all', async () => {
  const c = await release();
  const tool = await throughItsTool(c);
  const released = await tool({ case: c.incident.id, reason: 'Ready.' });
  const children = await c.children();
  expect(released.isError).toBeUndefined();
  expect(JSON.parse(released.content[0]!.text)).toEqual({ result: 'released', continuation: children[0]!.id });
  expect(JSON.parse((await tool({ case: c.incident.id, reason: 'Ready.' })).content[0]!.text)).toMatchObject({ result: 'no_hold', continuation: children[0]!.id });
  const refused = await tool({ case: randomUUID(), reason: 'Another case.' });
  expect(refused.isError).toBe(true);
  expect(refused.content[0]!.text).not.toContain('released');
  expect(await c.children()).toHaveLength(1);
});

it('asks for a reason through its tool', async () => {
  const c = await release();
  const tool = await throughItsTool(c);
  const answer = await tool({ case: c.incident.id, reason: '  ' });
  expect(answer.isError).toBe(true);
  expect((await c.row()).recoveryHold).toBe(true);
});

it('changes nothing when the hold ended while the node answered', async () => {
  const c = await release();
  const answer = c.sent.getMockImplementation()!;
  c.sent.mockImplementation((node, frame) => {
    void c.db.update(programOperatorCases).set({ recoveryHold: false, status: 'resolved' }).where(eq(programOperatorCases.id, c.incident.id)).then(() => answer(node, frame));
    return true;
  });
  expect(await c.call()).toEqual({ result: 'no_hold', status: 'resolved', continuation: null });
  expect(await c.children()).toEqual([]);
  expect(await c.audits()).toEqual([]);
});

it('keeps the hold and says so when the words have nowhere to go on from', async () => {
  const c = await release();
  await c.db.update(programOperatorCases).set({ deliveryId: null }).where(eq(programOperatorCases.id, c.incident.id));
  expect(await c.call()).toEqual({ result: 'refused', reason: 'program_busy' });
  expect((await c.row()).recoveryHold).toBe(true);
  expect(await c.children()).toEqual([]);
});

it('refuses when the agent has no plan to run the words, saying so, and the hold stays', async () => {
  const c = await release();
  await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, c.agent.id));
  expect(await c.call()).toEqual({ result: 'refused', reason: 'no_plan' });
  expect((await c.row()).recoveryHold).toBe(true);
});

it('refuses while another turn of that agent runs', async () => {
  const c = await release();
  await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Other.', timeoutMs: 1000, status: 'running' });
  expect(await c.call()).toMatchObject({ result: 'refused', reason: 'program_busy' });
  expect(await c.children()).toEqual([]);
});

it.each<[string, (c: Awaited<ReturnType<typeof release>>) => Promise<unknown>]>([
  ['an employee in another role', c => c.db.update(agents).set({ roleKey: 'OPS-WATCH' }).where(eq(agents.id, c.rob.id))],
  ['a head of another department', async c => {
    const [other] = await c.db.insert(departments).values({ companyId: c.companyId, templateKey: 'development', roleCode: 'DV2' }).returning();
    await c.db.update(agents).set({ kind: 'head', roleKey: 'OPS-HEAD', departmentId: other!.id }).where(eq(agents.id, c.rob.id));
  }],
  ['an engineer switched off', c => c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.rob.id))],
  ['an engineer whose turn is over', c => c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, c.turn.id))],
])('refuses %s', async (_name, change) => {
  const c = await release();
  await change(c);
  await expect(c.call()).rejects.toMatchObject({ status: 403 });
  expect((await c.row()).recoveryHold).toBe(true);
  expect(await c.children()).toEqual([]);
});

it('refuses to release the hold of an agent that was removed, and sends it nothing', async () => {
  const c = await release();
  await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.agent.id));
  await expect(c.call()).rejects.toMatchObject({ status: 403 });
  expect(await c.children()).toEqual([]);
});

it('refuses a program operator who is the one on hold', async () => {
  const c = await release();
  const own = { id: c.turn.id, companyId: c.companyId, agentId: c.agent.id };
  await c.db.update(agents).set({ roleKey: 'OPS-PROGRAM', departmentId: c.watcher.departmentId }).where(eq(agents.id, c.agent.id));
  await c.db.update(jobs).set({ agentId: c.agent.id }).where(eq(jobs.id, c.turn.id));
  await expect(releaseRecoveryHold(c.ctx, own, { case: c.incident.id, reason: 'Me.' })).rejects.toMatchObject({ status: 403 });
});

/* A second machine with a node of another plan, whose program lost its words too, while the operator handles another node's case. */
async function anotherNode(c: Awaited<ReturnType<typeof operatorCompany>>) {
  const [sub] = await c.db.insert(subscriptions).values({ ...c.sub, id: randomUUID(), kind: 'personal', provider: 'kimi', status: 'ready' }).returning();
  const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: randomUUID(), hostname: 'Another node' }).returning();
  const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: sub!.id, keyHash: randomUUID(), status: 'ready', version: '0.7.1' }).returning();
  const [agent] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Dana', kind: 'worker', roleKey: 'DEV-FE', departmentId: c.agent.departmentId, subscriptionId: sub!.id, nodeId: node!.id, model: '' }).returning();
  const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: agent!.id, subscriptionId: sub!.id, nodeId: node!.id, kind: 'conversation', prompt: 'Words of the other node.', timeoutMs: 1000, status: 'running' }).returning();
  const delivery = await reserveDelivery(c.db, { companyId: c.companyId, agentId: agent!.id, jobId: job!.id, nodeId: node!.id, kind: 'assignment', words: job!.prompt, reference: `job:${job!.id}` });
  const [saved] = await c.db.select().from(programDeliveries).where(eq(programDeliveries.id, delivery.id));
  const fact = { ...c.fact, agentKey: agent!.id, jobId: job!.id, instance: randomUUID(), deliveryId: delivery.id, deliveryOrdinal: delivery.ordinal, wordsDigest: saved!.digest };
  return { agent: agent!, job: job!, node: node!, fact, identity: { kind: 'node' as const, nodeId: node!.id, keyHash: node!.keyHash! } };
}

it('keeps queue, start and deadline apart for one operator of two nodes: no action on the old case, and one delivery of the saved words on each', async () => {
  const c = await operatorCompany(true);
  const b = await anotherNode(c);
  const a = { agent: c.agent, job: c.job, fact: c.fact, identity: c.identity };
  /* Turns that ran with the instructions their agents have now, so going on in their sessions is up to the node alone. */
  const ran = async (side: typeof a | typeof b, sessionId: string) => c.db.update(jobs).set({ sessionId, createdBy: c.sub.ownerPersonId, instructionsHash: (await instructionsOf(c.ctx, side.agent)).hash }).where(eq(jobs.id, side.job.id));
  await ran(a, 'session-a');
  await ran(b, 'session-b');
  const now = new Date(); let ordinal = 0;
  const record = (side: typeof a | typeof b, input: Parameters<typeof acceptOperatorEvidence>[2]) => acceptOperatorEvidence(c.ctx, side.identity, { ...input, evidenceId: randomUUID(), ordinal: ordinal++ }, now);
  const lostWords = async (side: typeof a | typeof b) => {
    await record(side, side.fact);
    await record(side, { type: 'program.operator_needed', agentKey: side.agent.id, jobId: side.job.id, instance: side.fact.instance, evidenceId: randomUUID(), ordinal: 0, reason: 'assignment_unrecorded', deliveryId: side.fact.deliveryId, evidenceKey: side.fact.deliveryId, elapsedMs: 60000, sinceLaunchMs: 60000, exit: null });
    return (await c.db.select().from(programOperatorCases).where(eq(programOperatorCases.agentId, side.agent.id)))[0]!;
  };

  /* The other node's case comes first, and the operator works on it when this node's case opens behind it. */
  const caseB = await lostWords(b);
  const noticeB = await c.jobOf(caseB.operatorJobId!);
  expect(noticeB.status).toBe('running');
  const caseA = await lostWords(a);
  expect(caseB.nodeId).toBe(b.node.id);
  expect(caseA.nodeId).toBe(a.identity.nodeId);
  expect(caseA.nodeId).not.toBe(caseB.nodeId);
  const notice = await c.jobOf(caseA.operatorJobId!);
  expect(notice).toMatchObject({ status: 'queued', startedAt: null });
  expect(notice.agentId).toBe(noticeB.agentId);
  expect(+notice.createdAt).toBeLessThan(+caseA.deadlineAt);
  expect(+caseA.deadlineAt - +caseA.openedAt).toBe(OPERATOR_CASE_MS);

  /* The deadline comes while the notice still waits in the line: the timeout is not the operator's work. */
  const late = new Date(Math.max(+caseA.deadlineAt, +caseB.deadlineAt) + 1);
  await checkOperatorHealth(c.ctx, late);
  const expired = async (id: string) => (await c.db.select().from(programOperatorCases).where(eq(programOperatorCases.id, id)))[0]!;
  expect(await expired(caseA.id)).toMatchObject({ status: 'escalated', recoveryHold: true, resolution: { outcome: 'operator_timeout' } });
  expect(await c.jobOf(notice.id)).toMatchObject({ status: 'queued' });

  /* The work on the other node's case ends, and only now the notice starts, 158 s after the deadline. */
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date(+late + 158_000) }).where(eq(jobs.id, noticeB.id));
  await pump(c.ctx, c.operator!.id);
  const started = await c.jobOf(notice.id);
  expect(started.status).toBe('running');
  expect(c.sent.mock.calls.filter(([, frame]) => frame.type === 'program.input_send' || frame.type === 'program.view_get')).toEqual([]);

  /* The words stay and go once on each node, however the late answers come in, and no node answers for the other. */
  const endWithTimeout = (side: typeof a | typeof b, id: string) => c.db.update(jobs).set({ status: 'failed', error: 'agent_failed', failure: { kind: 'unknown', text: `Program operator recovery ended: operator_timeout; case ${id}.`, retryable: false }, finishedAt: late }).where(eq(jobs.id, side.job.id));
  await endWithTimeout(a, caseA.id);
  await endWithTimeout(b, caseB.id);
  const ready = (from: typeof a | typeof b, side: typeof a | typeof b, id: string, owner: boolean) => record(from, { type: 'program.recovery_ready', agentKey: side.agent.id, jobId: side.job.id, instance: side.fact.instance, evidenceId: randomUUID(), ordinal: 0, case: id, owner });
  const childrenOf = (side: typeof a | typeof b) => c.db.select().from(jobs).where(eq(jobs.continueOf, side.job.id));
  expect(await ready(b, a, caseA.id, false)).toBe(false);
  expect(await childrenOf(a)).toEqual([]);
  await ready(a, a, caseA.id, false); await ready(a, a, caseA.id, false); await ready(a, a, caseA.id, true);
  await checkOperatorHealth(c.ctx, new Date(+late + 200_000));
  const children = await childrenOf(a);
  expect(children).toHaveLength(1);
  expect(children[0]).toMatchObject({ createdBy: c.sub.ownerPersonId, prompt: expect.stringContaining('Words.') });
  expect(await principalOf(c, children[0]!.id)).toEqual([c.sub.ownerPersonId]);
  expect(await childrenOf(b)).toEqual([]);
  await ready(b, b, caseB.id, false);
  const others = await childrenOf(b);
  expect(others).toHaveLength(1);
  expect(others[0]).toMatchObject({ createdBy: c.sub.ownerPersonId, prompt: expect.stringContaining('Words of the other node.') });
  expect(await childrenOf(a)).toHaveLength(1);

  /* Each goes on where its words were: on its own node, in its own session, one at a time. */
  await pump(c.ctx, a.agent.id);
  await pump(c.ctx, b.agent.id);
  expect(await c.jobOf(children[0]!.id)).toMatchObject({ nodeId: a.identity.nodeId, sessionId: 'session-a' });
  expect(await c.jobOf(others[0]!.id)).toMatchObject({ nodeId: b.node.id, sessionId: 'session-b' });
  for (const side of [a, b]) {
    const running = await c.db.select(idOnly(jobs)).from(jobs).where(sql`${jobs.agentId} = ${side.agent.id} and ${jobs.status} = 'running'`);
    expect(running.length).toBeLessThanOrEqual(1);
  }
});

it('a late receipt after an update wins over the delivery waiting to go, with no second run', async () => {
  const c = await held();
  c.ctx.hub.isReady = () => false;
  await c.ready(false);
  const [child] = await c.children();
  expect(child).toMatchObject({ status: 'queued' });
  await c.record({ ...c.fact, phase: 'taken', elapsedMs: 90000 });
  expect(await c.jobOf(child!.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
  await c.ready(false);
  await checkOperatorHealth(c.ctx);
  expect((await c.children()).filter(job => job.status !== 'failed')).toEqual([]);
});

/* A turn someone asked for, outside any task. */
async function asked(c: Awaited<ReturnType<typeof operatorCompany>>, text = 'Please look at the invoice.') {
  const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.head.id, prompt: text, createdBy: c.sub.ownerPersonId, message: { personId: c.sub.ownerPersonId, text } });
  await pump(c.ctx, c.head.id);
  await c.db.update(jobs).set({ status: 'running', nodeId: c.identity.nodeId, startedAt: new Date(), sessionId: 'session' }).where(eq(jobs.id, id));
  return id;
}

it('runs a turn someone asked for once more after a node restart, outside any task', async () => {
  const c = await operatorCompany(false);
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  const first = await asked(c);
  await failOpenJobs(c.ctx, eq(jobs.id, first), 'machine_restarted');
  const again = await c.db.select().from(jobs).where(eq(jobs.retryOf, first));
  expect(again).toHaveLength(1);
  expect(again[0]).toMatchObject({ createdBy: c.sub.ownerPersonId, prompt: expect.stringContaining('Please look at the invoice.'), continueOf: null });
  expect(await principalOf(c, again[0]!.id)).toEqual([c.sub.ownerPersonId]);
  await failOpenJobs(c.ctx, eq(jobs.id, first), 'machine_restarted');
  expect(await c.db.select().from(jobs).where(eq(jobs.retryOf, first))).toHaveLength(1);
});

it('runs once more a turn the orchestrator asked for through the window, as for anyone who asked', async () => {
  const c = await operatorCompany(false);
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.head.id, prompt: 'Look at the invoice.', createdBy: null, message: { personId: null, text: 'Look at the invoice.', from: 'orchestrator' } });
  await pump(c.ctx, c.head.id);
  await c.db.update(jobs).set({ status: 'running', nodeId: c.identity.nodeId, startedAt: new Date() }).where(eq(jobs.id, id));
  await failOpenJobs(c.ctx, eq(jobs.id, id), 'machine_restarted');
  expect(await c.db.select().from(jobs).where(eq(jobs.retryOf, id))).toHaveLength(1);
});

it('runs nothing again for a cut turn whose agent has no plan any more, and what comes after it still happens', async () => {
  const c = await operatorCompany(false);
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  const first = await asked(c);
  await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, c.head.id));
  await failOpenJobs(c.ctx, eq(jobs.id, first), 'machine_restarted');
  expect(await c.db.select().from(jobs).where(eq(jobs.retryOf, first))).toEqual([]);
  expect(await c.jobOf(first)).toMatchObject({ status: 'failed', error: 'machine_restarted' });
  expect(JSON.stringify(await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, first)))).toContain('no plan');
});

it('goes on in the session the turn had when the node restarted, known only from what the node said meanwhile', async () => {
  const c = await operatorCompany(false);
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  const first = await asked(c);
  await c.db.update(jobs).set({ sessionId: null }).where(eq(jobs.id, first));
  await recordJobProgram(c.ctx, { type: 'job.program', jobId: first, state: 'thinking', since: 0, screenAt: 0, session: 'session-of-the-cut-turn' }, new Date(), sql`true`);
  expect((await c.jobOf(first)).sessionId).toBe('session-of-the-cut-turn');
  await failOpenJobs(c.ctx, eq(jobs.id, first), 'machine_restarted');
  const [again] = await c.db.select().from(jobs).where(eq(jobs.retryOf, first));
  await pump(c.ctx, c.head.id);
  expect((await c.jobOf(again!.id)).sessionId).toBe('session-of-the-cut-turn');
});

it('keeps the session a report says only for its own running turn', async () => {
  const c = await operatorCompany(false);
  await recordJobProgram(c.ctx, { type: 'job.program', jobId: c.job.id, state: 'thinking', since: 0, screenAt: 0, session: 'other' }, new Date(), sql`false`);
  expect((await c.jobOf(c.job.id)).sessionId).not.toBe('other');
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date(), sessionId: 'kept' }).where(eq(jobs.id, c.job.id));
  await recordJobProgram(c.ctx, { type: 'job.program', jobId: c.job.id, state: 'thinking', since: 0, screenAt: 0, session: 'late' }, new Date(), sql`true`);
  expect((await c.jobOf(c.job.id)).sessionId).toBe('kept');
});

it('runs it no third time, and Operations hears of it', async () => {
  const c = await operatorCompany(false);
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  const [dept] = await c.db.select().from(departments).where(eq(departments.id, c.watcher.departmentId!));
  const [rob] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Rob', kind: 'worker', roleKey: 'OPS-FIX', departmentId: dept!.id, subscriptionId: c.sub.id, model: '' }).returning();
  const first = await asked(c);
  await failOpenJobs(c.ctx, eq(jobs.id, first), 'machine_restarted');
  const [second] = await c.db.select().from(jobs).where(eq(jobs.retryOf, first));
  await c.db.update(jobs).set({ status: 'running', nodeId: c.identity.nodeId, startedAt: new Date() }).where(eq(jobs.id, second!.id));
  await failOpenJobs(c.ctx, eq(jobs.id, second!.id), 'machine_restarted');
  expect(await c.db.select().from(jobs).where(eq(jobs.retryOf, second!.id))).toEqual([]);
  const calls = (await c.db.select().from(jobs).where(eq(jobs.agentId, rob!.id))).filter(job => job.prompt.includes(second!.id));
  expect(calls).toHaveLength(1);
});

it('leaves a timer round to its next round', async () => {
  const c = await operatorCompany(false);
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  const [round] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.watcher.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Your round.', timeoutMs: 1000, status: 'running', startedAt: new Date() }).returning();
  await failOpenJobs(c.ctx, eq(jobs.id, round!.id), 'machine_restarted');
  expect(await c.db.select().from(jobs).where(eq(jobs.retryOf, round!.id))).toEqual([]);
});
