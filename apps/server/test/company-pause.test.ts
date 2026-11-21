import { randomUUID } from 'node:crypto';
import { PROGRAM_OPERATOR_ROLE } from '@hornhoof/protocol/program-operator';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { orchestratorJobHeaders } from '../src/auth/internal.js';
import {
  agentEvents,
  agents,
  assistantEvents,
  assistantReplies,
  assistants,
  companies,
  departments,
  jobs,
  machines,
  nodes,
  people,
  programInstances,
  programOperatorCases,
  requests,
  subscriptions,
  tasks,
  taskWaits,
  testParts,
  testRuns,
  turns,
} from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { minuteRound, timerTick } from '../src/modules/agents/timers.js';
import { agentState, enqueueTurn, insertTurn, pump } from '../src/modules/conversation/queue.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { checkExternalWaits, sendTaskMessage } from '../src/modules/tasks/external-wait.js';
import { recordRelease, releaseRound } from '../src/modules/tasks/releases.js';
import { checkSilentTurns } from '../src/modules/tasks/silent.js';
import { closeIdleTurns } from '../src/modules/tasks/turn-ends.js';
import { checkWaitHealth } from '../src/modules/tasks/wait-monitor.js';
import { quietDepartment } from '../src/modules/tasks/wait-observations.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { checkTestTimes, partDone, pumpTests } from '../src/modules/testruns/runs.js';
import { holdTurns, turnsHeld } from '../src/modules/updates/drain.js';
import { BUILTIN } from './builtin.js';
import { appOn, as, connectNode, invitePerson, listen, nextOf, sessionFrom, SETUP, testApp, until } from './helpers.js';
import { openTestDb } from './helpers-db.js';

const NODE_KEY = 'k'.repeat(40);
const MIN = 60_000;
const GIB = 1024 ** 3;
const IDLE_LOAD = { cpus: 8, load: 0.5, memFree: 12 * GIB, memTotal: 16 * GIB, tests: 0, jobs: 0 };

async function setupCompany({ inbox = false } = {}) {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }));
  if (!inbox) await db.update(companies).set({ inboxMode: 'direct' });
  const builtin = await connectNode(url, NODE_KEY);
  onTestFinished(() => builtin.close());
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [], load: IDLE_LOAD });
  const [company] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [head] = await db.select().from(agents).where(eq(agents.kind, 'head'));
  const [sub] = await db.select().from(subscriptions);
  const [opsDept] = await db.select().from(departments);
  await db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.kind, 'worker'));
  await until(async () => (await agentState(app.ctx, head!.id)).ready && (await agentState(app.ctx, orchestrator!.id)).ready);
  return {
    app,
    db,
    url,
    ceo,
    builtin,
    company: company!,
    owner: owner!,
    orchestrator: orchestrator!,
    head: head!,
    sub: sub!,
    opsDept: opsDept!,
  };
}

const pause = (app: FastifyInstance, token: string) => app.inject({ method: 'POST', url: '/api/company/pause', ...as(token) });
const resume = (app: FastifyInstance, token: string) => app.inject({ method: 'POST', url: '/api/company/resume', ...as(token) });
const pauseState = (app: FastifyInstance, token: string) => app.inject({ method: 'GET', url: '/api/company/pause', ...as(token) });

describe('company pause', () => {
  it('lets a running turn finish without cutting it, counts finishing turns down to 0, holds queued turns, and survives restart', async () => {
    const { client } = await openTestDb();
    onTestFinished(() => client.close());
    const { app, db } = await appOn(client, { NODE_KEY });
    const url = await listen(app);
    const ceo = sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }));
    await db.update(companies).set({ inboxMode: 'direct' });
    const builtin = await connectNode(url, NODE_KEY);
    onTestFinished(() => builtin.close());
    builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [], load: IDLE_LOAD });
    await db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.kind, 'worker'));
    const [head] = await db.select().from(agents).where(eq(agents.kind, 'head'));
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    await until(async () => (await agentState(app.ctx, head!.id)).ready);

    const firstId = await enqueueTurn(app.ctx, { companyId: head!.companyId, agentId: head!.id, prompt: 'First turn', createdBy: null });
    await nextOf(builtin, 'job.run');
    await until(async () => (await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, firstId)))[0]?.status === 'running');
    const secondId = await insertTurn(app.ctx, { companyId: head!.companyId, agentId: head!.id, prompt: 'Second turn', createdBy: null });

    const paused = await pause(app, ceo);
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({
      paused: { by: owner!.id, byName: owner!.name, at: expect.any(String) },
      finishingTurns: 1,
    });
    const org = (await app.inject({ method: 'GET', url: '/api/org', ...as(ceo) })).json();
    expect(org.company.paused).toEqual(paused.json().paused);
    expect(builtin.queued()).toBe(0);

    /* Running turn finishes cleanly; its result is kept and the next queued turn stays queued. */
    await handleNodeMessage(app.ctx, BUILTIN, { type: 'job.done', jobId: firstId, ok: true, result: 'Finished cleanly', tail: '', error: null, sessionId: 'sess-1' });
    const [first] = await db.select().from(jobs).where(eq(jobs.id, firstId));
    const [second] = await db.select().from(jobs).where(eq(jobs.id, secondId));
    expect(first?.status).toBe('done');
    expect(first?.result).toBe('Finished cleanly');
    expect(second?.status).toBe('queued');
    expect((await pauseState(app, ceo)).json()).toEqual({ paused: paused.json().paused, finishingTurns: 0 });

    /* Pause survives a server restart on the same database. */
    const restarted = await appOn(client, { NODE_KEY });
    const afterRestart = await pauseState(restarted.app, ceo);
    expect(afterRestart.statusCode).toBe(200);
    expect(afterRestart.json()).toEqual({ paused: paused.json().paused, finishingTurns: 0 });

    /* Resuming continues the queued turn in order. */
    const resumed = await resume(app, ceo);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().paused).toBeNull();
    await until(async () => (await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, secondId)))[0]?.status === 'running');
  });

  it('starts no new turns during pause for task wakes, timers, employee messages, test parts, or releases, and keeps employee messages queued', async () => {
    const { app, db, ceo, company, head, opsDept, sub } = await setupCompany();
    await db.update(departments).set({ repoUrl: 'https://github.com/acme/app.git', repoBranch: 'main' }).where(eq(departments.id, opsDept.id));
    const [worker] = await db
      .insert(agents)
      .values({ companyId: company.id, departmentId: opsDept.id, kind: 'worker', name: 'Worker', model: '', subscriptionId: sub.id })
      .returning();
    await until(async () => (await agentState(app.ctx, worker!.id)).ready);

    /* Start a running turn on worker before pausing, then pause. */
    const runningId = await enqueueTurn(app.ctx, { companyId: company.id, agentId: worker!.id, prompt: 'Finish current work', createdBy: null });
    await until(async () => (await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, runningId)))[0]?.status === 'running');

    expect((await pause(app, ceo)).statusCode).toBe(200);

    /* 1. Task wake queues but does not start. */
    const created = await createTask(
      app.ctx,
      { agentId: worker!.id },
      { departmentId: opsDept.id, title: 'Wait until resume', brief: 'Stay queued while paused', body: 'Stay queued while paused', assigneeAgentId: head.id },
    );
    await wakeAll(app.ctx, created.wakes);
    const taskJobs = await db.select().from(jobs).where(and(eq(jobs.agentId, head.id), eq(jobs.taskId, created.task.id)));
    expect(taskJobs).toHaveLength(1);
    expect(taskJobs[0]!.status).toBe('queued');

    /* 2. Due timer does not fire or advance timerAt. */
    const pastTimer = new Date(Date.now() - 30 * MIN);
    await db.update(agents).set({ timerMinutes: 10, timerOrder: 'Do round', timerAt: pastTimer }).where(eq(agents.id, head.id));
    expect(await timerTick(app.ctx, new Date())).toBe(0);
    const [headAfterTimer] = await db.select(only(agents, 'timerAt')).from(agents).where(eq(agents.id, head.id));
    expect(headAfterTimer!.timerAt!.getTime()).toBe(pastTimer.getTime());

    /* 3. Running employee sending message_employee succeeds (not NOT_DELIVERED) and waits in queue instead of injecting live. */
    const sentToHead = await sendTaskMessage(
      app.ctx,
      { companyId: company.id, agentId: head.id, actor: { agentId: worker!.id }, text: 'Update during pause' },
      { companyId: company.id, agentId: head.id, prompt: 'Update during pause', createdBy: null, message: { personId: null, text: 'Update during pause', from: 'agent', by: worker!.id, byTurn: runningId } },
    );
    const [msgJob] = await db.select().from(jobs).where(eq(jobs.id, sentToHead.id));
    expect(msgJob?.status).toBe('queued');

    /* Also message sent toward the still-running worker queues instead of delivering live into its finishing turn. */
    const sentToWorker = await sendTaskMessage(
      app.ctx,
      { companyId: company.id, agentId: worker!.id, actor: { agentId: head.id }, text: 'Hold for after pause' },
      { companyId: company.id, agentId: worker!.id, prompt: 'Hold for after pause', createdBy: null, message: { personId: null, text: 'Hold for after pause', from: 'agent', by: head.id } },
    );
    expect(sentToWorker.id).not.toBe(runningId);
    const [workerQueued] = await db.select().from(jobs).where(eq(jobs.id, sentToWorker.id));
    expect(workerQueued?.status).toBe('queued');

    /* 4. Running test part finishes, queued part stays queued and never times out as no_machine during pause. */
    const [run] = await db
      .insert(testRuns)
      .values({ companyId: company.id, number: 1, taskId: created.task.id, agentId: worker!.id, jobId: runningId, departmentId: opsDept.id, command: 'npm test', parts: 2, timeoutMs: 60_000, status: 'running' })
      .returning();
    const [part1] = await db
      .insert(testParts)
      .values({ companyId: company.id, runId: run!.id, part: 1, status: 'running', builtin: true, startedAt: new Date() })
      .returning();
    const oldQueuedAt = new Date(Date.now() - 120 * MIN);
    const [part2] = await db
      .insert(testParts)
      .values({ companyId: company.id, runId: run!.id, part: 2, status: 'queued', queuedAt: oldQueuedAt })
      .returning();

    await pumpTests(app.ctx);
    await checkTestTimes(app.ctx, new Date(Date.now() + 180 * MIN));
    expect((await db.select().from(testParts).where(eq(testParts.id, part2!.id)))[0]?.status).toBe('queued');

    await partDone(app.ctx, BUILTIN, { type: 'tests.done', partId: part1!.id, ok: true, exitCode: 0, error: null, commit: null, log: 'ok' });
    expect((await db.select().from(testParts).where(eq(testParts.id, part1!.id)))[0]?.status).toBe('passed');
    expect((await db.select().from(testParts).where(eq(testParts.id, part2!.id)))[0]?.status).toBe('queued');

    /* 5. release_turn is refused during pause; releaseRound and closeIdleTurns skip paused company. */
    await expect(recordRelease(app.ctx, head.id, company.id, { task: created.task.number, commit: 'a'.repeat(40), runId: run!.id })).rejects.toMatchObject({ status: 409, reason: 'company_paused' });
    const [openTurn] = await db.select().from(turns).where(and(eq(turns.departmentId, opsDept.id), eq(turns.status, 'open')));
    await releaseRound(app.ctx);
    await closeIdleTurns(app.ctx);
    expect((await db.select(only(turns, 'status')).from(turns).where(eq(turns.id, openTurn!.id)))[0]?.status).toBe('open');

    /* Resume starts queued turns and queued test part in order. */
    expect((await resume(app, ceo)).statusCode).toBe(200);
    await until(async () => (await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, taskJobs[0]!.id)))[0]?.status === 'running');
    await until(async () => (await db.select(only(testParts, 'status')).from(testParts).where(eq(testParts.id, part2!.id)))[0]?.status === 'running');
  });

  it('lets the orchestrator hear people during pause, blocks non-person turns, forbids self-pause, and restricts orchestrator resume to whole-company words', async () => {
    const { app, db, ceo, company, orchestrator, owner, opsDept, sub } = await setupCompany();
    const listedSession = await invitePerson(app, ceo, { name: 'Listed User', email: 'listed@example.test', access: { departments: [opsDept.id], teams: [] } });
    const [listedPerson] = await db.select().from(people).where(eq(people.email, 'listed@example.test'));

    expect((await pause(app, ceo)).statusCode).toBe(200);

    /* Non-person queued turn (including a delayed retry) waits and neither blocks nor bundles into a person's turn. */
    const autoTurn = await insertTurn(app.ctx, { companyId: company.id, agentId: orchestrator.id, prompt: 'Employee note', createdBy: null });
    const delayedRetry = await insertTurn(app.ctx, { companyId: company.id, agentId: orchestrator.id, prompt: 'Delayed retry', createdBy: null, notBefore: new Date(Date.now() + 10 * MIN) });
    await pump(app.ctx, orchestrator.id);
    expect((await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, autoTurn)))[0]?.status).toBe('queued');
    expect((await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, delayedRetry)))[0]?.status).toBe('queued');

    /* Person's message to the orchestrator dispatches immediately during pause without bundling autoTurn. */
    const msgRes = await app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'Please lift the pause' }, ...as(ceo) });
    expect(msgRes.statusCode).toBe(202);
    const ceoJobId = msgRes.json().jobId as string;
    await until(async () => (await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, ceoJobId)))[0]?.status === 'running');
    expect((await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, autoTurn)))[0]?.status).toBe('queued');

    /* Orchestrator cannot pause the company on its own. */
    const selfPause = await app.inject({
      method: 'POST',
      url: '/api/company/pause',
      headers: orchestratorJobHeaders({ id: ceoJobId, agentId: orchestrator.id }),
    });
    expect(selfPause.statusCode).toBe(403);

    /* Orchestrator in a non-person turn cannot resume. */
    const [nonPersonJob] = await db
      .insert(jobs)
      .values({ companyId: company.id, subscriptionId: sub.id, agentId: orchestrator.id, kind: 'conversation', prompt: 'Timer wake', status: 'running', timeoutMs: 60_000, createdBy: null })
      .returning();
    const resumeAuto = await app.inject({
      method: 'POST',
      url: '/api/company/resume',
      headers: orchestratorJobHeaders({ id: nonPersonJob!.id, agentId: orchestrator.id }),
    });
    expect(resumeAuto.statusCode).toBe(403);

    /* Orchestrator in a turn carrying a listed person's words cannot resume. */
    const [listedJob] = await db
      .insert(jobs)
      .values({ companyId: company.id, subscriptionId: sub.id, agentId: orchestrator.id, kind: 'conversation', prompt: 'Resume please', status: 'running', timeoutMs: 60_000, createdBy: listedPerson!.id, decisionInputPending: false })
      .returning();
    await db.insert(agentEvents).values({ companyId: company.id, agentId: orchestrator.id, jobId: listedJob!.id, kind: 'message', personId: listedPerson!.id, data: { text: 'Resume please' } });
    const resumeListed = await app.inject({
      method: 'POST',
      url: '/api/company/resume',
      headers: orchestratorJobHeaders({ id: listedJob!.id, agentId: orchestrator.id }),
    });
    expect(resumeListed.statusCode).toBe(403);

    /* Orchestrator in the turn carrying CEO's words CAN resume. */
    const resumeCeo = await app.inject({
      method: 'POST',
      url: '/api/company/resume',
      headers: orchestratorJobHeaders({ id: ceoJobId, agentId: orchestrator.id }),
    });
    expect(resumeCeo.statusCode).toBe(200);
    expect(resumeCeo.json().paused).toBeNull();
    expect(listedSession).toBeTruthy();
    expect(owner.id).toBeTruthy();
  });

  it('lets personal assistants answer their own person during pause while holding company replies and requests until resume', async () => {
    const { app, db, ceo, company, owner, head, sub, opsDept } = await setupCompany();
    app.ctx.assistants.replyGraceMs = 0;
    const added = await app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name: 'Ava', owner: owner.id, program: 'avaclone' }, ...as(ceo) });
    expect(added.statusCode).toBe(201);
    const assistantPersonId = added.json().person.id as string;
    expect((await app.inject({ method: 'PATCH', url: `/api/people/${assistantPersonId}/assistant`, payload: { plan: sub.id }, ...as(ceo) })).statusCode).toBe(200);
    const [assistantRow] = await db.select().from(assistants).where(eq(assistants.personId, assistantPersonId));
    const ownAgentId = assistantRow!.agentId!;
    await until(async () => (await agentState(app.ctx, ownAgentId)).ready);

    expect((await pause(app, ceo)).statusCode).toBe(200);

    /* 1. Owner writes to their own assistant agent: turn starts and reply is collected during pause. */
    const ownTurnId = await enqueueTurn(app.ctx, { companyId: company.id, agentId: ownAgentId, prompt: 'Owner words', createdBy: owner.id, message: { personId: owner.id, text: 'Owner words' } });
    await until(async () => (await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, ownTurnId)))[0]?.status === 'running');
    await db.insert(assistantReplies).values({ companyId: company.id, assistantId: assistantPersonId, agentId: ownAgentId, messageId: randomUUID(), jobId: ownTurnId, byOwnAgent: true, afterSeq: 0 });
    await db.insert(agentEvents).values({ companyId: company.id, agentId: ownAgentId, jobId: ownTurnId, kind: 'text', data: { text: 'Direct answer to owner' } });
    await handleNodeMessage(app.ctx, BUILTIN, { type: 'job.done', jobId: ownTurnId, ok: true, result: 'Direct answer to owner', tail: '', error: null, sessionId: 'a-1' });

    /* 2. A company agent's reply and a company request wait while paused. */
    const [headDoneJob] = await db
      .insert(jobs)
      .values({ companyId: company.id, subscriptionId: sub.id, agentId: head.id, kind: 'conversation', prompt: 'Company work', status: 'done', timeoutMs: 60_000, createdBy: owner.id, finishedAt: new Date() })
      .returning();
    await db.insert(assistantReplies).values({ companyId: company.id, assistantId: assistantPersonId, agentId: head.id, messageId: randomUUID(), jobId: headDoneJob!.id, byOwnAgent: false, afterSeq: 0 });
    await db.insert(agentEvents).values({ companyId: company.id, agentId: head.id, jobId: headDoneJob!.id, kind: 'text', data: { text: 'Company reply held' } });
    const [taskRow] = await db.insert(tasks).values({ companyId: company.id, departmentId: opsDept.id, number: 99, title: 'Need decision', status: 'waiting' }).returning();
    await db.insert(requests).values({ companyId: company.id, taskId: taskRow!.id, agentId: head.id, kind: 'question', text: 'Pick A or B', status: 'open', audience: 'human', recipientPersonId: owner.id });

    app.ctx.assistants.collect(company.id);
    await app.ctx.assistants.settled();

    const duringPause = await db.select().from(assistantEvents).where(eq(assistantEvents.assistantId, assistantPersonId));
    expect(duringPause.some(e => e.kind === 'reply' && (e.data as { text?: string }).text === 'Direct answer to owner')).toBe(true);
    expect(duringPause.some(e => e.kind === 'reply' && (e.data as { text?: string }).text === 'Company reply held')).toBe(false);
    expect(duringPause.some(e => e.kind === 'request')).toBe(false);

    /* On resume, waiting company reply and request are delivered. */
    expect((await resume(app, ceo)).statusCode).toBe(200);
    await app.ctx.assistants.settled();
    const afterResume = await db.select().from(assistantEvents).where(eq(assistantEvents.assistantId, assistantPersonId));
    expect(afterResume.some(e => e.kind === 'reply' && (e.data as { text?: string }).text === 'Company reply held')).toBe(true);
    expect(afterResume.some(e => e.kind === 'request')).toBe(true);
  });

  it('allows the program operator to answer an open case for a running turn during pause, while holding non-running cases and Operations alarms', async () => {
    const { app, db, ceo, company, owner, head, opsDept, sub } = await setupCompany();
    const [operator] = await db
      .insert(agents)
      .values({ companyId: company.id, departmentId: opsDept.id, kind: 'worker', roleKey: PROGRAM_OPERATOR_ROLE, name: 'Program operator', model: '', subscriptionId: sub.id })
      .returning();
    const [worker] = await db
      .insert(agents)
      .values({ companyId: company.id, departmentId: opsDept.id, kind: 'worker', name: 'Worker', model: '', subscriptionId: sub.id })
      .returning();
    await until(async () => (await agentState(app.ctx, operator!.id)).ready && (await agentState(app.ctx, worker!.id)).ready);

    const [machine] = await db.insert(machines).values({ companyId: company.id, personId: owner.id, machineKey: 'm-1', hostname: 'host-1' }).returning();
    const [node] = await db.insert(nodes).values({ companyId: company.id, machineId: machine!.id, subscriptionId: sub.id, keyHash: 'h'.repeat(64), status: 'ready' }).returning();

    const runningSubject = await enqueueTurn(app.ctx, { companyId: company.id, agentId: worker!.id, prompt: 'Working before pause', createdBy: null });
    await until(async () => (await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, runningSubject)))[0]?.status === 'running');

    expect((await pause(app, ceo)).statusCode).toBe(200);

    /* Silent turn watchdog does not wake Operations during pause. */
    await db.update(jobs).set({ startedAt: new Date(Date.now() - 60 * MIN) }).where(eq(jobs.id, runningSubject));
    await checkSilentTurns(app.ctx, new Date());
    expect(await db.select().from(jobs).where(eq(jobs.agentId, head.id))).toEqual([]);

    /* Ordinary Operations turn waits during pause. */
    const ordinaryOps = await insertTurn(app.ctx, { companyId: company.id, agentId: operator!.id, prompt: 'Ordinary check', createdBy: null });
    await pump(app.ctx, operator!.id);
    expect((await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, ordinaryOps)))[0]?.status).toBe('queued');

    /* Open program operator case for the currently running subject turn DOES dispatch during pause. */
    const [inst] = await db.insert(programInstances).values({ id: randomUUID(), companyId: company.id, agentId: worker!.id, nodeId: node!.id }).returning();
    const opCaseJob = await insertTurn(app.ctx, { companyId: company.id, agentId: operator!.id, prompt: 'Help running turn', createdBy: null });
    await db.insert(programOperatorCases).values({
      companyId: company.id,
      agentId: worker!.id,
      jobId: runningSubject,
      nodeId: node!.id,
      instance: inst!.id,
      reason: 'question_waiting',
      evidenceKey: 'ev-1',
      capability: randomUUID(),
      status: 'open',
      deadlineAt: new Date(Date.now() + 10 * MIN),
      operatorAgentId: operator!.id,
      operatorJobId: opCaseJob,
    });
    await pump(app.ctx, operator!.id);
    await until(async () => (await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, opCaseJob)))[0]?.status === 'running');
    expect((await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, ordinaryOps)))[0]?.status).toBe('queued');
  });

  it('freezes deadlines and silence alarms during pause and shifts all pending deadlines forward on resume', async () => {
    const { app, db, ceo, company, owner, head, opsDept, sub } = await setupCompany();
    const T0 = new Date(Date.now());
    const PAUSE_MS = 60 * MIN;
    const T1 = new Date(T0.getTime() + PAUSE_MS);
    let nowMs = T0.getTime();
    app.ctx.clock = () => nowMs;

    const [openTurn] = await db
      .update(turns)
      .set({ openedAt: new Date(T0.getTime() - 20 * MIN) })
      .where(and(eq(turns.departmentId, opsDept.id), eq(turns.status, 'open')))
      .returning();
    const [waitTask] = await db
      .insert(tasks)
      .values({
        companyId: company.id,
        departmentId: opsDept.id,
        turnId: openTurn!.id,
        number: 10,
        title: 'Task with wait',
        status: 'working',
        assigneeAgentId: head.id,
        externalWait: { reason: 'Waiting for CI', since: T0.toISOString(), until: new Date(T0.getTime() + 10 * MIN).toISOString(), operation: randomUUID() },
      })
      .returning();
    const [quietTask] = await db
      .insert(tasks)
      .values({ companyId: company.id, departmentId: opsDept.id, turnId: openTurn!.id, number: 11, title: 'Unexplained task', status: 'working', assigneeAgentId: head.id, updatedAt: new Date(T0.getTime() - 20 * MIN) })
      .returning();

    const ownerDue = new Date(T0.getTime() + 10 * MIN);
    const headDue = new Date(T0.getTime() + 20 * MIN);
    const decisionDue = new Date(T0.getTime() + 30 * MIN);
    const reviewDue = new Date(T0.getTime() + 15 * MIN);
    const [tw] = await db
      .insert(taskWaits)
      .values({
        companyId: company.id,
        taskId: waitTask!.id,
        kind: 'external',
        sourceKey: `wait_for:${randomUUID()}`,
        sourceRevision: 1,
        state: 'active',
        ownerAgentId: head.id,
        ownerDueAt: ownerDue,
        headDueAt: headDue,
        decisionDueAt: decisionDue,
        nextActionAt: ownerDue,
        nextReviewAt: reviewDue,
        plan: {
          version: 1,
          ownerDueAt: ownerDue.toISOString(),
          headDueAt: headDue.toISOString(),
          decisionDueAt: decisionDue.toISOString(),
          provenance: { kind: 'source_contract', actor: { agentId: head.id }, ref: 'test', revision: 1, origin: 'test' },
          finalReview: { headAgentId: head.id, anchorAt: T0.toISOString(), intervalMs: 15 * MIN },
        },
      })
      .returning();

    const jobNotBefore = new Date(T0.getTime() + 5 * MIN);
    const delayedJobId = await insertTurn(app.ctx, { companyId: company.id, agentId: head.id, prompt: 'Retry later', createdBy: null, notBefore: jobNotBefore });

    const timerAt = new Date(T0.getTime() - 20 * MIN);
    const timerNudgedAt = new Date(T0.getTime() + 5 * MIN);
    await db.update(agents).set({ timerMinutes: 30, timerOrder: 'Check stuff', timerAt, timerNudgedAt }).where(eq(agents.id, head.id));

    const [run] = await db
      .insert(testRuns)
      .values({ companyId: company.id, number: 1, taskId: waitTask!.id, agentId: head.id, jobId: delayedJobId, departmentId: opsDept.id, command: 'npm test', parts: 1, timeoutMs: 60_000, status: 'running' })
      .returning();
    const partQueuedAt = new Date(T0.getTime() - 5 * MIN);
    const [part] = await db.insert(testParts).values({ companyId: company.id, runId: run!.id, part: 1, status: 'queued', queuedAt: partQueuedAt }).returning();

    const [machine] = await db.insert(machines).values({ companyId: company.id, personId: owner.id, machineKey: 'm-2', hostname: 'host-2' }).returning();
    const [node] = await db.insert(nodes).values({ companyId: company.id, machineId: machine!.id, subscriptionId: sub.id, keyHash: 'g'.repeat(64), status: 'ready' }).returning();
    const [inst] = await db.insert(programInstances).values({ id: randomUUID(), companyId: company.id, agentId: head.id, nodeId: node!.id }).returning();
    const caseDeadline = new Date(T0.getTime() + 10 * MIN);
    const [opCase] = await db
      .insert(programOperatorCases)
      .values({ companyId: company.id, agentId: head.id, jobId: delayedJobId, nodeId: node!.id, instance: inst!.id, reason: 'question_waiting', evidenceKey: 'ev-2', capability: randomUUID(), status: 'open', deadlineAt: caseDeadline })
      .returning();

    /* Pause at T0. */
    expect((await pause(app, ceo)).statusCode).toBe(200);

    /* Advance 60 minutes during pause and run the full minute round: nothing expires or alarms. */
    nowMs = T1.getTime();
    await minuteRound(app.ctx, T1, () => () => {});
    expect(await checkExternalWaits(app.ctx, T1)).toBe(0);
    await checkWaitHealth(app.ctx, T1);
    expect((await db.select().from(tasks).where(eq(tasks.id, waitTask!.id)))[0]!.externalWait).not.toBeNull();
    expect((await db.select().from(taskWaits).where(eq(taskWaits.id, tw!.id)))[0]!.level).toBe(0);
    expect((await db.select().from(programOperatorCases).where(eq(programOperatorCases.id, opCase!.id)))[0]!.status).toBe('open');
    expect((await db.select().from(testParts).where(eq(testParts.id, part!.id)))[0]!.status).toBe('queued');
    expect(await quietDepartment(app.ctx, openTurn!.id, opsDept.id, T1)).toBeNull();

    /* Resume at T1 (+60m): every pending deadline shifts by +60m, and silence alarms count from T1. */
    expect((await resume(app, ceo)).statusCode).toBe(200);

    const [taskAfter] = await db.select().from(tasks).where(eq(tasks.id, waitTask!.id));
    expect(Date.parse(taskAfter!.externalWait!.until)).toBe(T0.getTime() + 10 * MIN + PAUSE_MS);

    const [twAfter] = await db.select().from(taskWaits).where(eq(taskWaits.id, tw!.id));
    expect(twAfter!.ownerDueAt!.getTime()).toBe(ownerDue.getTime() + PAUSE_MS);
    expect(twAfter!.headDueAt!.getTime()).toBe(headDue.getTime() + PAUSE_MS);
    expect(twAfter!.decisionDueAt!.getTime()).toBe(decisionDue.getTime() + PAUSE_MS);
    expect(twAfter!.nextActionAt!.getTime()).toBe(ownerDue.getTime() + PAUSE_MS);
    expect(twAfter!.nextReviewAt!.getTime()).toBe(reviewDue.getTime() + PAUSE_MS);
    expect(Date.parse(twAfter!.plan!.ownerDueAt)).toBe(ownerDue.getTime() + PAUSE_MS);
    expect(Date.parse(twAfter!.plan!.finalReview.anchorAt)).toBe(T0.getTime() + PAUSE_MS);

    const [jobAfter] = await db.select().from(jobs).where(eq(jobs.id, delayedJobId));
    expect(jobAfter!.notBefore!.getTime()).toBe(jobNotBefore.getTime() + PAUSE_MS);

    const [headAfter] = await db.select().from(agents).where(eq(agents.id, head.id));
    expect(headAfter!.timerAt!.getTime()).toBe(timerAt.getTime() + PAUSE_MS);
    expect(headAfter!.timerNudgedAt!.getTime()).toBe(timerNudgedAt.getTime() + PAUSE_MS);
    expect(await timerTick(app.ctx, new Date(T1.getTime() + MIN))).toBe(0);

    const [partAfter] = await db.select().from(testParts).where(eq(testParts.id, part!.id));
    expect(partAfter!.queuedAt.getTime()).toBe(partQueuedAt.getTime() + PAUSE_MS);

    const [caseAfter] = await db.select().from(programOperatorCases).where(eq(programOperatorCases.id, opCase!.id));
    expect(caseAfter!.deadlineAt.getTime()).toBe(caseDeadline.getTime() + PAUSE_MS);

    /* Quiet department counts from resumedAt (T1): silent at T1+5m -> null; silent at T1+16m -> detected! */
    expect(await quietDepartment(app.ctx, openTurn!.id, opsDept.id, new Date(T1.getTime() + 5 * MIN))).toBeNull();
    const quietLater = await quietDepartment(app.ctx, openTurn!.id, opsDept.id, new Date(T1.getTime() + 16 * MIN));
    expect(quietLater?.silent.some(t => t.id === quietTask!.id)).toBe(true);
  });

  it('enforces whole-company permission on pause/resume and keeps Hornhoof update holds independent', async () => {
    const { app, db, ceo, company, head, opsDept } = await setupCompany();
    const listedSession = await invitePerson(app, ceo, { name: 'Dept Member', email: 'dept@example.test', access: { departments: [opsDept.id], teams: [] } });
    const wholeSession = await invitePerson(app, ceo, { name: 'Company Member', email: 'whole@example.test', access: { whole: true } });

    /* Listed person can read pause state but gets 403 on pause and resume. */
    expect((await pauseState(app, listedSession)).statusCode).toBe(200);
    expect((await pause(app, listedSession)).statusCode).toBe(403);
    expect((await resume(app, listedSession)).statusCode).toBe(403);

    /* Whole-company person can pause and resume. */
    expect((await pause(app, wholeSession)).statusCode).toBe(200);
    expect((await pauseState(app, listedSession)).json().paused?.byName).toBe('Company Member');
    expect((await resume(app, wholeSession)).statusCode).toBe(200);

    /* Resuming company pause does NOT lift a Hornhoof update hold (holdTurns). */
    holdTurns(app.ctx, company.id, true);
    onTestFinished(() => holdTurns(app.ctx, company.id, false));
    expect((await pause(app, ceo)).statusCode).toBe(200);
    const queuedId = await insertTurn(app.ctx, { companyId: company.id, agentId: head.id, prompt: 'Waits for update too', createdBy: null });
    expect((await resume(app, ceo)).statusCode).toBe(200);
    expect(turnsHeld(app.ctx, company.id)).toBe(true);
    expect((await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, queuedId)))[0]?.status).toBe('queued');

    /* Also verifies ordered queue resume when multiple turns queued during pause. */
    holdTurns(app.ctx, company.id, false);
    expect((await pause(app, ceo)).statusCode).toBe(200);
    const secondQueued = await insertTurn(app.ctx, { companyId: company.id, agentId: head.id, prompt: 'Second in line', createdBy: null });
    const queuedOrder = await db.select(only(jobs, 'id')).from(jobs).where(and(eq(jobs.agentId, head.id), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt));
    expect(queuedOrder.map(j => j.id)).toEqual([queuedId, secondQueued]);
    expect((await resume(app, ceo)).statusCode).toBe(200);
    await until(async () => (await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, queuedId)))[0]?.status === 'running');
  });
});
