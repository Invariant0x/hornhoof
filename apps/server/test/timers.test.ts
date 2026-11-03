import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agentChanges, agentEvents, agents, departments, jobs, taskEvents, tasks } from '../src/db/schema.js';
import { minuteRound, timerTick } from '../src/modules/agents/timers.js';
import { agentState, enqueueTurn, insertTurn, onAgent } from '../src/modules/conversation/queue.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { submit } from '../src/modules/tasks/engine.js';
import { as, connectNode, listen, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

/* Operations with Wanda on the company key, which the built-in node runs. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  onTestFinished(() => builtin.close());
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
  await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'operations' }] }, ...as(ceo) });
  const [ops] = await db.select().from(departments).where(isNull(departments.parentId));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const role = app.ctx.templates.roles.get('OPS-HEAD')!;
  const hired = await app.inject({
    method: 'POST',
    url: `/api/departments/${ops!.id}/staff`,
    payload: { people: [{ role: 'OPS-HEAD', name: 'Wanda', model: '', subscription: orchestrator!.subscriptionId, skills: role.skills.filter(s => s.on).map(s => s.id) }] },
    ...as(ceo),
  });
  const wandaId = hired.json().hired[0] as string;
  await until(async () => (await agentState(app.ctx, wandaId)).ready);
  return { app, db, ceo, wandaId, builtin, orchestrator: orchestrator! };
}

const patch = (app: FastifyInstance, token: string, id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/agents/${id}`, payload, ...as(token) });
const MIN = 60_000;

describe('timers', () => {
  it('sends a turn that was left waiting with nothing running on the next minute round', async () => {
    const { app, db, wandaId, orchestrator } = await company();
    /* A turn put in line whose send was lost: nothing else would start it. */
    const jobId = await insertTurn(app.ctx, { companyId: orchestrator.companyId, agentId: wandaId, prompt: 'Left waiting', createdBy: null });
    const status = async () => (await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)))[0]!.status;
    expect(await status()).toBe('queued');
    await minuteRound(app.ctx, new Date(), () => () => {});
    expect(await status()).toBe('running');
  });

  it('sets an employee to wake every so many minutes with an order, and the card shows it', async () => {
    const { app, db, ceo, wandaId } = await company();
    const set = await patch(app, ceo, wandaId, { timer: { minutes: 10, order: 'Check that every agent reported its task.' } });
    expect(set.statusCode).toBe(200);
    expect(set.json().timer).toMatchObject({ minutes: 10, order: 'Check that every agent reported its task.', lastAt: expect.any(String) });
    const [change] = await db.select().from(agentChanges).where(and(eq(agentChanges.agentId, wandaId), eq(agentChanges.field, 'timer')));
    expect(change).toMatchObject({ before: null, after: { minutes: 10, order: 'Check that every agent reported its task.' } });
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.departments[0].employees.find((e: { id: string }) => e.id === wandaId).timer).toBe(10);
    expect((await patch(app, ceo, wandaId, { timer: null })).json().timer).toBeNull();
    expect((await patch(app, ceo, wandaId, { timer: { minutes: 2, order: 'Too often.' } })).statusCode).toBe(400);
    expect((await patch(app, ceo, wandaId, { timer: { minutes: 10, order: '' } })).statusCode).toBe(400);
  });

  it("keeps the orchestrator off timers: Hornhoof wakes him itself", async () => {
    const { app, ceo } = await company();
    const res = await patch(app, ceo, 'orchestrator', { timer: { minutes: 10, order: 'Look around.' } });
    expect([res.statusCode, res.json().error.reason]).toEqual([400, 'orchestrator_card']);
  });

  it('wakes an employee once each interval with its order, outside any task', async () => {
    const { app, db, ceo, wandaId } = await company();
    await patch(app, ceo, wandaId, { timer: { minutes: 10, order: 'Check that every agent reported its task.' } });
    const [{ timerAt }] = (await db.select({ timerAt: agents.timerAt }).from(agents).where(eq(agents.id, wandaId))) as [{ timerAt: Date }];
    const rounds = async () => db.select().from(jobs).where(eq(jobs.agentId, wandaId));
    expect(await timerTick(app.ctx, new Date(timerAt.getTime() + 9 * MIN))).toBe(0);
    expect(await rounds()).toHaveLength(0);
    expect(await timerTick(app.ctx, new Date(timerAt.getTime() + 10 * MIN))).toBe(1);
    const [round] = await rounds();
    expect(round).toMatchObject({ kind: 'conversation', taskId: null });
    expect(round!.prompt).toContain('every 10 minutes');
    expect(round!.prompt).toContain('Check that every agent reported its task.');
    const [said] = await db.select().from(agentEvents).where(and(eq(agentEvents.agentId, wandaId), eq(agentEvents.kind, 'message')));
    expect(said!.personId).toBeNull();
    /* Its round still waits, so the next tick adds no second one. */
    expect(await timerTick(app.ctx, new Date(timerAt.getTime() + 25 * MIN))).toBe(0);
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, round!.id));
    expect(await timerTick(app.ctx, new Date(timerAt.getTime() + 25 * MIN))).toBe(1);
    expect(await timerTick(app.ctx, new Date(timerAt.getTime() + 26 * MIN))).toBe(0);
  });

  it("gives a hire the timer of its role, starting from the hire", async () => {
    const { app, db, ceo, orchestrator } = await company();
    const [ops] = await db.select().from(departments).where(isNull(departments.parentId));
    const role = app.ctx.templates.roles.get('OPS-WATCH')!;
    const hired = await app.inject({
      method: 'POST',
      url: `/api/departments/${ops!.id}/staff`,
      payload: { people: [{ role: 'OPS-WATCH', name: 'Walt', model: '', subscription: orchestrator.subscriptionId, skills: role.skills.filter(s => s.on).map(s => s.id) }] },
      ...as(ceo),
    });
    const [walt] = await db.select().from(agents).where(eq(agents.id, hired.json().hired[0] as string));
    expect([walt!.timerMinutes, walt!.timerOrder, walt!.timerForWork]).toEqual([10, role.timer!.order, true]);
    expect(walt!.timerAt!.getTime()).toBeGreaterThan(Date.now() - MIN);
  });

  it('skips the round of a timer for work while nothing is open or failed since the last one, and counts from the skip', async () => {
    const { app, db, ceo, wandaId, orchestrator } = await company();
    expect((await patch(app, ceo, wandaId, { timer: { minutes: 10, order: 'Look around.', forWork: true } })).json().timer).toMatchObject({ forWork: true });
    const [{ timerAt }] = (await db.select({ timerAt: agents.timerAt }).from(agents).where(eq(agents.id, wandaId))) as [{ timerAt: Date }];
    const at = (minutes: number) => new Date(timerAt.getTime() + minutes * MIN);
    expect(await timerTick(app.ctx, at(10))).toBe(0);
    expect((await db.select({ timerAt: agents.timerAt }).from(agents).where(eq(agents.id, wandaId)))[0]!.timerAt).toEqual(at(10));
    const [task] = await db.insert(tasks).values({ companyId: orchestrator.companyId, number: 1, title: 'Checkout', status: 'open' }).returning();
    expect(await timerTick(app.ctx, at(20))).toBe(1);
    await db.update(jobs).set({ status: 'done', finishedAt: at(21) }).where(eq(jobs.agentId, wandaId));
    await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, task!.id));
    /* A stop by a person is no failure; a timeout is. */
    const failed = (minute: number, error: string) => ({ companyId: orchestrator.companyId, subscriptionId: orchestrator.subscriptionId!, agentId: orchestrator.id, kind: 'conversation' as const, prompt: 'x', timeoutMs: 1, status: 'failed' as const, error, finishedAt: at(minute) });
    await db.insert(jobs).values(failed(25, 'cancelled'));
    expect(await timerTick(app.ctx, at(30))).toBe(0);
    await db.insert(jobs).values(failed(35, 'timeout'));
    expect(await timerTick(app.ctx, at(40))).toBe(1);
  });

  it("queues no round while the employee's machine is offline", async () => {
    const { app, db, ceo, wandaId, builtin } = await company();
    await patch(app, ceo, wandaId, { timer: { minutes: 10, order: 'Look around.' } });
    builtin.close();
    await until(async () => !(await agentState(app.ctx, wandaId)).ready);
    expect(await timerTick(app.ctx, new Date(Date.now() + 11 * MIN))).toBe(0);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, wandaId))).toHaveLength(0);
  });

  it('looks at the employee again once its line is free, and starts no round for one switched off meanwhile', async () => {
    const { app, db, ceo, wandaId } = await company();
    await patch(app, ceo, wandaId, { timer: { minutes: 10, order: 'Look around.' } });
    let release = () => {};
    void onAgent(app.ctx, wandaId, () => new Promise<void>(done => (release = done)));
    const tick = timerTick(app.ctx, new Date(Date.now() + 11 * MIN));
    await db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, wandaId));
    release();
    expect(await tick).toBe(0);
  });

  it('lets an employee that is off or has no subscription sleep through its timer', async () => {
    const { app, db, ceo, wandaId } = await company();
    await patch(app, ceo, wandaId, { timer: { minutes: 10, order: 'Look around.' } });
    const later = new Date(Date.now() + 11 * MIN);
    await patch(app, ceo, wandaId, { on: false });
    expect(await timerTick(app.ctx, later)).toBe(0);
    await patch(app, ceo, wandaId, { on: true, subscription: null });
    expect(await timerTick(app.ctx, later)).toBe(0);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, wandaId))).toHaveLength(0);
  });

  it('at 10 minutes of silence asks the node what the turn is doing, closes a turn waiting at its prompt as lost_ending with its last answer (done or failed by doneIfRecorded), logs it, and sends queued messages at once', async () => {
    const { app, db, ceo, wandaId, orchestrator } = await company();
    const [dev] = await db.insert(departments).values({ companyId: orchestrator.companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    const [bruno] = await db
      .insert(agents)
      .values({ companyId: orchestrator.companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: orchestrator.subscriptionId })
      .returning();
    const [task] = await db
      .insert(tasks)
      .values({ companyId: orchestrator.companyId, number: 1, title: 'Checkout API', status: 'working', departmentId: dev!.id, assigneeAgentId: bruno!.id, executorAgentId: bruno!.id })
      .returning();
    const startedAt = new Date();
    const at = (minutes: number) => new Date(startedAt.getTime() + minutes * MIN);
    const [turn] = await db
      .insert(jobs)
      .values({
        companyId: orchestrator.companyId,
        subscriptionId: orchestrator.subscriptionId!,
        agentId: bruno!.id,
        taskId: task!.id,
        kind: 'conversation',
        prompt: 'Build POST /checkout.',
        timeoutMs: 900_000,
        status: 'running',
        startedAt,
      })
      .returning();
    /* Bruno recorded his submission and emitted his final answer at +2m, then his hook was lost while waiting at prompt. */
    await submit(app.ctx, bruno!.id, task!.id, { summary: 'POST /checkout works.', evidence: 'npm test: 4 passed' });
    await db.insert(agentEvents).values({
      companyId: orchestrator.companyId,
      agentId: bruno!.id,
      jobId: turn!.id,
      kind: 'text',
      data: { kind: 'text', text: 'All tests pass and the branch is pushed.' },
      createdAt: at(2),
    });
    /* A message queued behind Bruno's hanging turn waits until the turn closes. */
    const queuedMsgId = await enqueueTurn(app.ctx, {
      companyId: orchestrator.companyId,
      agentId: bruno!.id,
      prompt: 'Check the edge case too.',
      createdBy: null,
      message: { personId: null, text: 'Check the edge case too.', from: 'agent', name: 'Wanda', by: wandaId },
    });
    expect((await db.select().from(jobs).where(eq(jobs.id, queuedMsgId)))[0]!.status).toBe('queued');

    /* At +12m (10 minutes after the last event at +2m), the cron checks with the node; the node says it waits at prompt. */
    await minuteRound(app.ctx, at(12), () => () => {});
    await handleNodeMessage(app.ctx, BUILTIN, { type: 'job.state', jobId: turn!.id, state: 'waiting' });

    const [closed] = await db.select().from(jobs).where(eq(jobs.id, turn!.id));
    expect(closed).toMatchObject({
      status: 'done',
      error: null,
      result: 'All tests pass and the branch is pushed.',
      tail: expect.stringContaining('lost_ending'),
    });
    /* Logged in agent_events and task_events as lost_ending. */
    const turnEvents = await db.select().from(agentEvents).where(eq(agentEvents.jobId, turn!.id));
    expect(turnEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ error: 'lost_ending' }) })]),
    );
    const taskLog = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task!.id));
    expect(taskLog).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'interrupted', data: expect.objectContaining({ job: turn!.id, reason: 'lost_ending' }) })]),
    );
    /* The queued message behind the hanging turn went out at once. */
    expect((await db.select().from(jobs).where(eq(jobs.id, queuedMsgId)))[0]!.status).toBe('running');

    /* A turn that recorded no task move before waiting at its prompt closes as failed with error lost_ending. */
    const [unrecorded] = await db
      .insert(jobs)
      .values({
        companyId: orchestrator.companyId,
        subscriptionId: orchestrator.subscriptionId!,
        agentId: wandaId,
        kind: 'conversation',
        prompt: 'Check the status.',
        timeoutMs: 900_000,
        status: 'running',
        startedAt: at(20),
      })
      .returning();
    await db.insert(agentEvents).values({
      companyId: orchestrator.companyId,
      agentId: wandaId,
      jobId: unrecorded!.id,
      kind: 'text',
      data: { kind: 'text', text: 'Status checked.' },
      createdAt: at(21),
    });
    await patch(app, ceo, wandaId, { timer: null });
    await minuteRound(app.ctx, at(31), () => () => {});
    await handleNodeMessage(app.ctx, BUILTIN, { type: 'job.state', jobId: unrecorded!.id, state: 'waiting' });
    const [closedUnrecorded] = await db.select().from(jobs).where(eq(jobs.id, unrecorded!.id));
    expect(closedUnrecorded).toMatchObject({
      status: 'failed',
      error: 'lost_ending',
      result: 'Status checked.',
    });
  });

  it('when the node does not answer job.check, keeps the turn running and sends one alarm at 30 minutes to the watchdog and one at 2 hours to the orchestrator', async () => {
    const { app, db, ceo, wandaId, orchestrator } = await company();
    const [ops] = await db.select().from(departments).where(isNull(departments.parentId));
    const [dev] = await db.insert(departments).values({ companyId: orchestrator.companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
    const watchRole = app.ctx.templates.roles.get('OPS-WATCH')!;
    const hiredWatch = await app.inject({
      method: 'POST',
      url: `/api/departments/${ops!.id}/staff`,
      payload: { people: [{ role: 'OPS-WATCH', name: 'Walt', model: '', subscription: orchestrator.subscriptionId, skills: watchRole.skills.filter(s => s.on).map(s => s.id) }] },
      ...as(ceo),
    });
    const waltId = hiredWatch.json().hired[0] as string;
    /* Finish the orchestrator's initial greeting turn so Bruno's turn is the only running one. */
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    const [bruno] = await db
      .insert(agents)
      .values({ companyId: orchestrator.companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: orchestrator.subscriptionId })
      .returning();
    const [task] = await db
      .insert(tasks)
      .values({ companyId: orchestrator.companyId, number: 1, title: 'Checkout API', status: 'working', departmentId: dev!.id, assigneeAgentId: bruno!.id, executorAgentId: bruno!.id })
      .returning();
    const startedAt = new Date();
    const [turn] = await db
      .insert(jobs)
      .values({
        companyId: orchestrator.companyId,
        subscriptionId: orchestrator.subscriptionId!,
        agentId: bruno!.id,
        taskId: task!.id,
        kind: 'conversation',
        prompt: 'Build POST /checkout.',
        timeoutMs: 900_000,
        status: 'running',
        startedAt,
      })
      .returning();
    const at = (minutes: number) => new Date(startedAt.getTime() + minutes * MIN);
    /* Prevent Walt's regular timer from firing while we check silent-turn alarms. */
    await db.update(agents).set({ timerAt: at(300) }).where(eq(agents.id, waltId));

    const lastEventAt = at(15);
    await db.insert(agentEvents).values({
      companyId: orchestrator.companyId,
      agentId: bruno!.id,
      jobId: turn!.id,
      kind: 'text',
      data: { kind: 'text', text: 'Checking schema.' },
      createdAt: lastEventAt,
    });
    /* An incoming message from another agent is no sign of life from Bruno's turn. */
    await db.insert(agentEvents).values({
      companyId: orchestrator.companyId,
      agentId: bruno!.id,
      jobId: turn!.id,
      kind: 'message',
      data: { text: 'Any progress?', from: 'agent', name: 'Wanda' },
      createdAt: at(35),
    });

    /* At +25m (10 minutes of silence) and +30m (15 minutes of silence), the node does not answer: turn stays running, no alarm yet. */
    await minuteRound(app.ctx, at(25), () => () => {});
    await minuteRound(app.ctx, at(30), () => () => {});
    expect((await db.select().from(jobs).where(eq(jobs.id, turn!.id)))[0]!.status).toBe('running');
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, wandaId))).toHaveLength(0);

    /* At +45m (30 minutes of silence since lastEventAt at +15m), Hornhoof sends one alarm to Walt, and the turn stays running. */
    await minuteRound(app.ctx, at(45), () => () => {});
    expect((await db.select().from(jobs).where(eq(jobs.id, turn!.id)))[0]!.status).toBe('running');
    const waltTurns = await db.select().from(jobs).where(eq(jobs.agentId, waltId));
    expect(waltTurns).toHaveLength(1);
    for (const part of ['Bruno', 'Backend engineer', turn!.id, '#1', 'Checkout API', lastEventAt.toISOString()]) {
      expect(waltTurns[0]!.prompt).toContain(part);
    }

    /* Further rounds before 2 hours do not repeat the 30-minute alarm. */
    await minuteRound(app.ctx, at(50), () => () => {});
    await minuteRound(app.ctx, at(55), () => () => {});
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(1);

    /* At +135m (2 hours of silence since lastEventAt at +15m), Hornhoof also alerts the orchestrator once. */
    const orchBefore = (await db.select().from(jobs).where(eq(jobs.agentId, orchestrator.id))).length;
    await minuteRound(app.ctx, at(135), () => () => {});
    await minuteRound(app.ctx, at(136), () => () => {});
    const orchTurns = await db.select().from(jobs).where(eq(jobs.agentId, orchestrator.id)).orderBy(asc(jobs.createdAt));
    expect(orchTurns).toHaveLength(orchBefore + 1);
    for (const part of ['Bruno', 'Backend engineer', turn!.id, '#1', 'Checkout API', lastEventAt.toISOString()]) {
      expect(orchTurns.at(-1)!.prompt).toContain(part);
    }
  });

  it('does not close a turn with a tool call running without a result, and at 30 minutes raises an alarm naming the tool', async () => {
    const { app, db, ceo, orchestrator } = await company();
    const [ops] = await db.select().from(departments).where(isNull(departments.parentId));
    const [dev] = await db.insert(departments).values({ companyId: orchestrator.companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
    const watchRole = app.ctx.templates.roles.get('OPS-WATCH')!;
    const hiredWatch = await app.inject({
      method: 'POST',
      url: `/api/departments/${ops!.id}/staff`,
      payload: { people: [{ role: 'OPS-WATCH', name: 'Walt', model: '', subscription: orchestrator.subscriptionId, skills: watchRole.skills.filter(s => s.on).map(s => s.id) }] },
      ...as(ceo),
    });
    const waltId = hiredWatch.json().hired[0] as string;
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    const [bruno] = await db
      .insert(agents)
      .values({ companyId: orchestrator.companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: orchestrator.subscriptionId })
      .returning();
    const startedAt = new Date();
    const at = (minutes: number) => new Date(startedAt.getTime() + minutes * MIN);
    await db.update(agents).set({ timerAt: at(120) }).where(eq(agents.id, waltId));

    const [turn] = await db
      .insert(jobs)
      .values({
        companyId: orchestrator.companyId,
        subscriptionId: orchestrator.subscriptionId!,
        agentId: bruno!.id,
        kind: 'conversation',
        prompt: 'Run migration.',
        timeoutMs: 900_000,
        status: 'running',
        startedAt,
      })
      .returning();
    const toolStartedAt = at(5);
    await db.insert(agentEvents).values({
      companyId: orchestrator.companyId,
      agentId: bruno!.id,
      jobId: turn!.id,
      kind: 'tool',
      data: { kind: 'tool', name: 'Bash', input: 'npm run migrate' },
      createdAt: toolStartedAt,
    });

    /* Even if a node reported waiting at +15m, an unfinished tool call prevents closing the turn. */
    await minuteRound(app.ctx, at(15), () => () => {});
    await handleNodeMessage(app.ctx, BUILTIN, { type: 'job.state', jobId: turn!.id, state: 'waiting' });
    expect((await db.select().from(jobs).where(eq(jobs.id, turn!.id)))[0]!.status).toBe('running');
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);

    /* At +35m (30 minutes after the Bash tool call started with no tool_result), the turn stays running and Walt gets the tool alarm. */
    await minuteRound(app.ctx, at(35), () => () => {});
    expect((await db.select().from(jobs).where(eq(jobs.id, turn!.id)))[0]!.status).toBe('running');
    const waltTurns = await db.select().from(jobs).where(eq(jobs.agentId, waltId));
    expect(waltTurns).toHaveLength(1);
    expect(waltTurns[0]!.prompt).toContain('Bash');
    expect(waltTurns[0]!.prompt).toContain('30 minutes');
  });

  it('sends the silent-turn alarm to the head of Operations when the task watchdog is busy, off, or removed', async () => {
    const { app, db, ceo, wandaId, orchestrator } = await company();
    const [ops] = await db.select().from(departments).where(isNull(departments.parentId));
    const watchRole = app.ctx.templates.roles.get('OPS-WATCH')!;
    const hiredWatch = await app.inject({
      method: 'POST',
      url: `/api/departments/${ops!.id}/staff`,
      payload: { people: [{ role: 'OPS-WATCH', name: 'Walt', model: '', subscription: orchestrator.subscriptionId, skills: watchRole.skills.filter(s => s.on).map(s => s.id) }] },
      ...as(ceo),
    });
    const waltId = hiredWatch.json().hired[0] as string;
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));

    const startedAt = new Date();
    const at = (minutes: number) => new Date(startedAt.getTime() + minutes * MIN);
    await db.update(agents).set({ timerAt: at(120) }).where(eq(agents.id, waltId));

    /* Case 1: Walt (OPS-WATCH) is busy running a turn of his own when another turn hits 30 minutes of silence. */
    const [waltBusy] = await db
      .insert(jobs)
      .values({
        companyId: orchestrator.companyId,
        subscriptionId: orchestrator.subscriptionId!,
        agentId: waltId,
        kind: 'conversation',
        prompt: 'Inspecting logs.',
        timeoutMs: 900_000,
        status: 'running',
        startedAt: at(20),
      })
      .returning();
    const [turn1] = await db
      .insert(jobs)
      .values({
        companyId: orchestrator.companyId,
        subscriptionId: orchestrator.subscriptionId!,
        agentId: orchestrator.id,
        kind: 'conversation',
        prompt: 'Plan turn 4.',
        timeoutMs: 900_000,
        status: 'running',
        startedAt,
      })
      .returning();

    await minuteRound(app.ctx, at(30), () => () => {});
    const wandaTurns1 = await db.select().from(jobs).where(eq(jobs.agentId, wandaId));
    expect(wandaTurns1).toHaveLength(1);
    for (const part of ['Orchestrator', turn1!.id, startedAt.toISOString()]) {
      expect(wandaTurns1[0]!.prompt).toContain(part);
    }

    /* Case 2: Walt is switched off when another turn hits 30 minutes of silence. */
    await db.update(jobs).set({ status: 'done', finishedAt: at(31) }).where(eq(jobs.id, waltBusy!.id));
    await db.update(jobs).set({ status: 'done', finishedAt: at(31) }).where(eq(jobs.id, turn1!.id));
    await patch(app, ceo, waltId, { on: false });
    const [turn2] = await db
      .insert(jobs)
      .values({
        companyId: orchestrator.companyId,
        subscriptionId: orchestrator.subscriptionId!,
        agentId: orchestrator.id,
        kind: 'conversation',
        prompt: 'Plan turn 5.',
        timeoutMs: 900_000,
        status: 'running',
        startedAt: at(40),
      })
      .returning();
    await minuteRound(app.ctx, at(70), () => () => {});
    const wandaTurns2 = await db.select().from(jobs).where(eq(jobs.agentId, wandaId)).orderBy(asc(jobs.createdAt));
    expect(wandaTurns2).toHaveLength(2);
    expect(wandaTurns2[1]!.prompt).toContain(turn2!.id);

    /* Case 3: Walt is removed when another turn hits 30 minutes of silence. */
    await db.update(jobs).set({ status: 'done', finishedAt: at(71) }).where(eq(jobs.id, turn2!.id));
    expect((await app.inject({ method: 'DELETE', url: `/api/agents/${waltId}`, ...as(ceo) })).statusCode).toBe(204);
    const [turn3] = await db
      .insert(jobs)
      .values({
        companyId: orchestrator.companyId,
        subscriptionId: orchestrator.subscriptionId!,
        agentId: orchestrator.id,
        kind: 'conversation',
        prompt: 'Plan turn 6.',
        timeoutMs: 900_000,
        status: 'running',
        startedAt: at(80),
      })
      .returning();
    await minuteRound(app.ctx, at(110), () => () => {});
    const wandaTurns3 = await db.select().from(jobs).where(eq(jobs.agentId, wandaId)).orderBy(asc(jobs.createdAt));
    expect(wandaTurns3).toHaveLength(3);
    expect(wandaTurns3[2]!.prompt).toContain(turn3!.id);
  });

  it("closes the task watchdog's own turn after 30 minutes of silence, alerts the head of Operations, and lets the watchdog's timer start its next round", async () => {
    const { app, db, ceo, wandaId, orchestrator } = await company();
    const [ops] = await db.select().from(departments).where(isNull(departments.parentId));
    const watchRole = app.ctx.templates.roles.get('OPS-WATCH')!;
    const hiredWatch = await app.inject({
      method: 'POST',
      url: `/api/departments/${ops!.id}/staff`,
      payload: { people: [{ role: 'OPS-WATCH', name: 'Walt', model: '', subscription: orchestrator.subscriptionId, skills: watchRole.skills.filter(s => s.on).map(s => s.id) }] },
      ...as(ceo),
    });
    const waltId = hiredWatch.json().hired[0] as string;
    await until(async () => (await agentState(app.ctx, waltId)).ready);
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    await db.insert(tasks).values({ companyId: orchestrator.companyId, number: 1, title: 'Keep watching', status: 'working' });

    const [{ timerAt }] = (await db.select({ timerAt: agents.timerAt }).from(agents).where(eq(agents.id, waltId))) as [{ timerAt: Date }];
    const at = (minutes: number) => new Date(timerAt.getTime() + minutes * MIN);

    /* Walt's first round starts at +10m and emits its last event at +15m, then hangs running. */
    expect(await timerTick(app.ctx, at(10))).toBe(1);
    const [firstRound] = await db.select().from(jobs).where(eq(jobs.agentId, waltId));
    expect(firstRound!.status).toBe('running');
    const lastEventAt = at(15);
    await db.insert(agentEvents).values({
      companyId: orchestrator.companyId,
      agentId: waltId,
      jobId: firstRound!.id,
      kind: 'text',
      data: { kind: 'text', text: 'Checked open tasks.' },
      createdAt: lastEventAt,
    });

    /* Before 30 minutes of silence (+30m and +44m), the running round holds the timer. */
    expect(await timerTick(app.ctx, at(30))).toBe(0);
    expect(await timerTick(app.ctx, at(44))).toBe(0);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, wandaId))).toHaveLength(0);

    /* At +45m (30 minutes after lastEventAt at +15m), the stuck round closes, Wanda gets the alarm, and Walt's timer starts a new round. */
    expect(await timerTick(app.ctx, at(45))).toBe(1);
    const [closedFirst] = await db.select().from(jobs).where(eq(jobs.id, firstRound!.id));
    expect(closedFirst!.status).toBe('failed');
    const runningWalt = await db.select().from(jobs).where(and(eq(jobs.agentId, waltId), eq(jobs.status, 'running')));
    expect(runningWalt).toHaveLength(1);
    expect(runningWalt[0]!.id).not.toBe(firstRound!.id);
    expect(runningWalt[0]!.prompt).toContain('Do your round:');

    const wandaTurns = await db.select().from(jobs).where(eq(jobs.agentId, wandaId));
    expect(wandaTurns).toHaveLength(1);
    for (const part of ['Walt', 'Task watchdog', firstRound!.id, lastEventAt.toISOString()]) {
      expect(wandaTurns[0]!.prompt).toContain(part);
    }
  });
});
