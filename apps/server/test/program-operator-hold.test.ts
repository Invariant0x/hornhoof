import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { OPERATOR_CASE_MS, type OperatorRecoveryState } from '@hornhoof/protocol/program-operator';
import { agentEvents, agents, departments, jobs, programInstances, programOperatorActions, programOperatorCases } from '../src/db/schema.js';
import { enqueueTurn, pump } from '../src/modules/conversation/queue.js';
import { failOpenJobs } from '../src/modules/nodes/messages.js';
import { recordJobProgram } from '../src/modules/tasks/silent.js';
import { acceptOperatorEvidence } from '../src/modules/program-operator/evidence.js';
import { checkOperatorHealth } from '../src/modules/program-operator/health.js';
import { releaseRecoveryHold } from '../src/modules/program-operator/release.js';
import { receiveOperatorReply } from '../src/modules/program-operator/rpc.js';
import { readProgramScreen, sendProgramKey } from '../src/modules/program-operator/tools.js';
import { operatorCompany } from './program-operator-company.js';

const MINUTE = 60_000;

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

it('calls the reliability engineer once for a hold of more than five minutes', async () => {
  const c = await held();
  const rob = await hire(c, 'Rob', 'worker', 'OPS-FIX');
  const since = +(await c.row()).escalatedAt!;
  await checkOperatorHealth(c.ctx, new Date(since + 5 * MINUTE));
  expect(await turnsWith(c, rob.id, c.incident.id)).toEqual([]);
  await checkOperatorHealth(c.ctx, new Date(since + 5 * MINUTE + 1));
  await checkOperatorHealth(c.ctx, new Date(since + 6 * MINUTE));
  const calls = await turnsWith(c, rob.id, c.incident.id);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.prompt).toContain('program_recovery_release');
  expect((await c.row()).recoveryHold).toBe(true);
});

it('calls the head of Operations when the reliability engineer is off', async () => {
  const c = await held();
  const rob = await hire(c, 'Rob', 'worker', 'OPS-FIX'), olga = await hire(c, 'Olga', 'head', 'OPS-HEAD');
  await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, rob.id));
  await checkOperatorHealth(c.ctx, new Date(Date.now() + 6 * MINUTE));
  expect(await turnsWith(c, rob.id, c.incident.id)).toEqual([]);
  expect(await turnsWith(c, olga.id, c.incident.id)).toHaveLength(1);
});

it('never calls the agent that is on hold about itself, nor one that waits on a hold of its own', async () => {
  const c = await held();
  await c.db.update(agents).set({ roleKey: 'OPS-FIX', departmentId: c.watcher.departmentId }).where(eq(agents.id, c.agent.id));
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

const FREE: Omit<OperatorRecoveryState, 'type' | 'agentKey' | 'jobId' | 'instance' | 'request'> = { program: 'here', current: null, generation: 7, input: 'empty', wait: null, runningTool: false, retrying: false, busy: false };

/* The tool of Operations, with the node answering what it sees right now. */
async function release(facts: Partial<typeof FREE> | null = {}, roleKey = 'OPS-FIX', kind: 'worker' | 'head' = 'worker') {
  const c = await held();
  const rob = await hire(c, 'Rob', kind, roleKey);
  const [turn] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: rob.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'Look at the hold.', timeoutMs: 1000, status: 'running' }).returning();
  c.sent.mockImplementation((_node, frame) => {
    if (frame.type === 'program.recovery_state_get' && facts) queueMicrotask(() => receiveOperatorReply(c.ctx, c.identity, { type: 'program.recovery_state', ...c.program, request: frame.request, ...FREE, current: c.program.instance, ...facts }));
    return true;
  });
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
  expect(await c.audits()).toEqual([expect.objectContaining({ actor: { id: c.rob.id, name: 'Rob', role: 'OPS-FIX' }, reason: 'The program stands ready and the words wait.', at: expect.any(String), result: 'released', action: 'release_and_deliver', job: c.job.id, instance: c.program.instance, generation: 7, input: 'empty', continuation: children[0]!.id })]);
  expect(await c.call()).toMatchObject({ result: 'no_hold', continuation: children[0]!.id });
  expect(await c.children()).toHaveLength(1);
});

it('lets the head of Operations do the same', async () => {
  const c = await release({}, 'OPS-HEAD', 'head');
  expect(await c.call()).toMatchObject({ result: 'released' });
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
  ['a menu', { wait: 'menu' }, 'input_not_proven'],
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
  expect(await c.call()).toMatchObject({ result: 'refused', reason: 'node_unavailable' });
  expect(await c.children()).toEqual([]);
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

it('refuses a reliability engineer who is the one on hold', async () => {
  const c = await release();
  const own = { id: c.turn.id, companyId: c.companyId, agentId: c.agent.id };
  await c.db.update(agents).set({ roleKey: 'OPS-FIX', departmentId: c.watcher.departmentId }).where(eq(agents.id, c.agent.id));
  await c.db.update(jobs).set({ agentId: c.agent.id }).where(eq(jobs.id, c.turn.id));
  await expect(releaseRecoveryHold(c.ctx, own, { case: c.incident.id, reason: 'Me.' })).rejects.toMatchObject({ status: 403 });
});

it('keeps queue, start and deadline apart for an operator late behind other work: no action on the old case, and one delivery of the saved words', async () => {
  const c = await operatorCompany(true);
  const now = new Date(); let ordinal = 0;
  const record = (input: Parameters<typeof acceptOperatorEvidence>[2]) => acceptOperatorEvidence(c.ctx, c.identity, { ...input, evidenceId: randomUUID(), ordinal: ordinal++ }, now);
  const identity = { agentKey: c.agent.id, jobId: c.job.id, instance: c.fact.instance };
  /* The operator works on another node's case when this one opens. */
  const [other] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.operator!.id, subscriptionId: c.sub.id, kind: 'conversation', prompt: 'A case of another node.', timeoutMs: 1000, status: 'running', startedAt: now }).returning();
  await record(c.fact);
  await record({ type: 'program.operator_needed', ...identity, evidenceId: randomUUID(), ordinal: 0, reason: 'assignment_unrecorded', deliveryId: c.delivery.id, evidenceKey: c.delivery.id, elapsedMs: 60000, sinceLaunchMs: 60000, exit: null });
  const [opened] = await c.db.select().from(programOperatorCases);
  const notice = await c.jobOf(opened!.operatorJobId!);
  expect(notice).toMatchObject({ status: 'queued', startedAt: null });
  expect(+notice.createdAt).toBeLessThan(+opened!.deadlineAt);
  expect(+opened!.deadlineAt - +opened!.openedAt).toBe(OPERATOR_CASE_MS);

  /* The deadline comes while the notice still waits in the line: the timeout is not the operator's work. */
  const late = new Date(+opened!.deadlineAt + 1);
  await checkOperatorHealth(c.ctx, late);
  const [expired] = await c.db.select().from(programOperatorCases);
  expect(expired).toMatchObject({ status: 'escalated', recoveryHold: true, resolution: { outcome: 'operator_timeout' } });
  expect(await c.jobOf(notice.id)).toMatchObject({ status: 'queued' });

  /* The other work ends, and only now the notice starts, 158 s after the deadline as in #455. */
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date(+late + 158_000) }).where(eq(jobs.id, other!.id));
  await pump(c.ctx, c.operator!.id);
  const started = await c.jobOf(notice.id);
  expect(started.status).toBe('running');
  const caller = { id: notice.id, companyId: c.companyId, agentId: c.operator!.id };
  await expect(readProgramScreen(c.ctx, caller, { employee: c.agent.id, case: opened!.id })).rejects.toMatchObject({ status: 403 });
  await expect(sendProgramKey(c.ctx, caller, { employee: c.agent.id, case: opened!.id, snapshot: randomUUID(), key: 'Enter', reason: 'Too late.' })).rejects.toMatchObject({ status: 403 });
  expect(await c.db.select().from(programOperatorActions)).toEqual([]);
  expect(c.sent.mock.calls.filter(([, frame]) => frame.type === 'program.key_send' || frame.type === 'program.screen_get')).toEqual([]);

  /* The words stay and go once, however the late answers come in. */
  await c.db.update(jobs).set({ status: 'failed', error: 'agent_failed', failure: { kind: 'unknown', text: `Program operator recovery ended: operator_timeout; case ${opened!.id}.`, retryable: false }, finishedAt: late, createdBy: c.sub.ownerPersonId }).where(eq(jobs.id, c.job.id));
  const ready = (owner: boolean) => record({ type: 'program.recovery_ready', ...identity, evidenceId: randomUUID(), ordinal: 0, case: opened!.id, owner });
  await ready(false); await ready(false); await ready(true);
  await checkOperatorHealth(c.ctx, new Date(+late + 200_000));
  const children = await c.db.select().from(jobs).where(eq(jobs.continueOf, c.job.id));
  expect(children).toHaveLength(1);
  expect(children[0]).toMatchObject({ createdBy: c.sub.ownerPersonId, prompt: expect.stringContaining('Words.') });
  const running = await c.db.select({ id: jobs.id }).from(jobs).where(sql`${jobs.agentId} = ${c.agent.id} and ${jobs.status} = 'running'`);
  expect(running.length).toBeLessThanOrEqual(1);
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
  expect(again[0]).toMatchObject({ createdBy: c.sub.ownerPersonId, prompt: expect.stringContaining('Please look at the invoice.'), continueOf: first });
  await failOpenJobs(c.ctx, eq(jobs.id, first), 'machine_restarted');
  expect(await c.db.select().from(jobs).where(eq(jobs.retryOf, first))).toHaveLength(1);
});

it('goes on in the session the turn had when the node restarted, known only from what the node said meanwhile', async () => {
  const c = await operatorCompany(false);
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  const first = await asked(c);
  await c.db.update(jobs).set({ sessionId: null }).where(eq(jobs.id, first));
  await recordJobProgram(c.ctx, { type: 'job.program', jobId: first, state: 'working', since: 0, screenAt: 0, session: 'session-of-the-cut-turn' }, new Date(), sql`true`);
  expect((await c.jobOf(first)).sessionId).toBe('session-of-the-cut-turn');
  await failOpenJobs(c.ctx, eq(jobs.id, first), 'machine_restarted');
  const [again] = await c.db.select().from(jobs).where(eq(jobs.retryOf, first));
  await pump(c.ctx, c.head.id);
  expect((await c.jobOf(again!.id)).sessionId).toBe('session-of-the-cut-turn');
});

it('keeps the session a report says only for its own running turn', async () => {
  const c = await operatorCompany(false);
  await recordJobProgram(c.ctx, { type: 'job.program', jobId: c.job.id, state: 'working', since: 0, screenAt: 0, session: 'other' }, new Date(), sql`false`);
  expect((await c.jobOf(c.job.id)).sessionId).not.toBe('other');
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date(), sessionId: 'kept' }).where(eq(jobs.id, c.job.id));
  await recordJobProgram(c.ctx, { type: 'job.program', jobId: c.job.id, state: 'working', since: 0, screenAt: 0, session: 'late' }, new Date(), sql`true`);
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
