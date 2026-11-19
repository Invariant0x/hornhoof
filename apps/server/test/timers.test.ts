import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentChanges, agentEvents, agents, companies, departments, jobs, requests, tasks } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { leadSweeps, minuteRound, timerTick } from '../src/modules/agents/timers.js';
import { agentState, insertTurn, onAgent } from '../src/modules/conversation/queue.js';
import { BUILTIN } from './builtin.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { createRoute, routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { developmentStages } from './templates-once.js';
import { discardStaleTurn, taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { as, connectNode, listen, sessionFrom, SETUP, testApp, until } from './helpers.js';

/* The wake state a real assignment leaves on the turn, so the turn stays current while its task does. */
async function keepTaskWake(db: FastifyInstance['ctx']['db'], task: typeof tasks.$inferSelect, agentId: string, jobId: string): Promise<void> {
  const taskWake = taskWakeOf(task, { why: 'go_on' }, routeSnapshot(await routeOf(db, task), task.assigneeAgentId));
  await db.insert(agentEvents).values({ companyId: task.companyId, agentId, jobId, kind: 'message', data: { text: 'Build POST /checkout.', taskWake } });
}

const NODE_KEY = 'k'.repeat(40);

/* Operations with Wanda on the company key, which the built-in node runs. Its mail goes each as a turn of its own, as a test
   of timers expects; inbox: it takes its mail by the inbox every company starts with. */
async function company({ inbox = false } = {}) {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }));
  if (!inbox) await db.update(companies).set({ inboxMode: 'direct' });
  const builtin = await connectNode(url, NODE_KEY);
  onTestFinished(() => builtin.close());
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  /* Wanda heads the Operations it starts with; the others rest, so each test's rounds are its own. */
  const [wanda] = await db.update(agents).set({ name: 'Wanda' }).where(eq(agents.kind, 'head')).returning();
  await db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.kind, 'worker'));
  const wandaId = wanda!.id;
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
    const status = async () => (await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, jobId)))[0]!.status;
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

  it('starts a round sooner when a change asked for one, and then counts its interval from that round', async () => {
    const { app, db, ceo, wandaId } = await company();
    await patch(app, ceo, wandaId, { timer: { minutes: 240, order: 'Go over the tracker.' } });
    const [{ timerAt }] = (await db.select({ timerAt: agents.timerAt }).from(agents).where(eq(agents.id, wandaId))) as [{ timerAt: Date }];
    await db.update(agents).set({ timerNudgedAt: new Date(timerAt.getTime() + 20 * MIN) }).where(eq(agents.id, wandaId));
    expect(await timerTick(app.ctx, new Date(timerAt.getTime() + 19 * MIN))).toBe(0);
    expect(await timerTick(app.ctx, new Date(timerAt.getTime() + 20 * MIN))).toBe(1);
    const [after] = await db.select({ at: agents.timerAt, nudged: agents.timerNudgedAt }).from(agents).where(eq(agents.id, wandaId));
    expect([after!.at!.getTime(), after!.nudged]).toEqual([timerAt.getTime() + 20 * MIN, null]);
  });

  it('wakes an employee once each interval with its order, outside any task', async () => {
    const { app, db, ceo, wandaId } = await company();
    await patch(app, ceo, wandaId, { timer: { minutes: 10, order: 'Check that every agent reported its task.' } });
    const [{ timerAt }] = (await db.select(only(agents, 'timerAt')).from(agents).where(eq(agents.id, wandaId))) as [{ timerAt: Date }];
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
    /* The clock stands still through the hire, so its moment is this one. */
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const hiredAt = new Date();
    const hired = await app.inject({
      method: 'POST',
      url: `/api/departments/${ops!.id}/staff`,
      payload: { people: [{ role: 'OPS-WATCH', name: 'Walt', model: '', subscription: orchestrator.subscriptionId, skills: role.skills.filter(s => s.on).map(s => s.id) }] },
      ...as(ceo),
    });
    vi.useRealTimers();
    const [walt] = await db.select().from(agents).where(eq(agents.id, hired.json().hired[0] as string));
    expect([walt!.timerMinutes, walt!.timerOrder, walt!.timerForWork]).toEqual([10, role.timer!.order, true]);
    expect(walt!.timerAt).toEqual(hiredAt);
  });

  it('skips the round of a timer for work while nothing is open or failed since the last one, and counts from the skip', async () => {
    const { app, db, ceo, wandaId, orchestrator } = await company();
    expect((await patch(app, ceo, wandaId, { timer: { minutes: 10, order: 'Look around.', forWork: true } })).json().timer).toMatchObject({ forWork: true });
    const [{ timerAt }] = (await db.select(only(agents, 'timerAt')).from(agents).where(eq(agents.id, wandaId))) as [{ timerAt: Date }];
    const at = (minutes: number) => new Date(timerAt.getTime() + minutes * MIN);
    expect(await timerTick(app.ctx, at(10))).toBe(0);
    expect((await db.select(only(agents, 'timerAt')).from(agents).where(eq(agents.id, wandaId)))[0]!.timerAt).toEqual(at(10));
    const [task] = await db.insert(tasks).values({ companyId: orchestrator.companyId, number: 1, title: 'Checkout', status: 'open' }).returning();
    expect(await timerTick(app.ctx, at(20))).toBe(1);
    await db.update(jobs).set({ status: 'done', finishedAt: at(21) }).where(eq(jobs.agentId, wandaId));
    await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, task!.id));
    /* A stop by a person is no failure; a timeout is. */
    const failed = (minute: number, error: string) => ({ companyId: orchestrator.companyId, subscriptionId: orchestrator.subscriptionId!, agentId: orchestrator.id, kind: 'conversation' as const, prompt: 'x', timeoutMs: 1, status: 'failed' as const, error, finishedAt: at(minute) });
    await db.insert(jobs).values(failed(25, 'cancelled'));
    const [obsolete] = await db.insert(jobs).values({ companyId: orchestrator.companyId, subscriptionId: orchestrator.subscriptionId!, agentId: orchestrator.id, taskId: task!.id, kind: 'conversation', prompt: 'x', timeoutMs: 1, status: 'queued' }).returning();
    await db.insert(agentEvents).values({ companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: obsolete!.id, kind: 'message', data: { text: 'Merge wake', taskWake: { why: 'merge', status: 'working', stage: 0, merging: false } } });
    expect(await discardStaleTurn(db, obsolete!)).toBe(true);
    await db.update(jobs).set({ finishedAt: at(26) }).where(eq(jobs.id, obsolete!.id));
    expect(await timerTick(app.ctx, at(30))).toBe(0);
    await db.insert(jobs).values(failed(35, 'timeout'));
    expect(await timerTick(app.ctx, at(40))).toBe(1);
  });

  it('skips the round of a timer for work while every open task waits on purpose, for a person or for what it said it waits for', async () => {
    const { app, db, ceo, wandaId, orchestrator } = await company();
    await patch(app, ceo, wandaId, { timer: { minutes: 10, order: 'Look around.', forWork: true } });
    const [{ timerAt }] = (await db.select(only(agents, 'timerAt')).from(agents).where(eq(agents.id, wandaId))) as [{ timerAt: Date }];
    const at = (minutes: number) => new Date(timerAt.getTime() + minutes * MIN);
    const companyId = orchestrator.companyId;
    const [asking] = await db.insert(tasks).values({ companyId, number: 1, title: 'Checkout', status: 'working' }).returning();
    const [request] = await db.insert(requests).values({ companyId, taskId: asking!.id, agentId: orchestrator.id, kind: 'question', text: 'Is tax in scope?' }).returning();
    await db.insert(tasks).values({ companyId, number: 2, title: 'Images', status: 'working', externalWait: { reason: 'Images on the registry', since: at(0).toISOString(), until: at(600).toISOString() } });
    expect(await timerTick(app.ctx, at(10))).toBe(0);
    /* The answer came: the task is to be moved again, so there is something to look at. */
    await db.update(requests).set({ status: 'answered', answer: 'No.', answeredAt: at(15) }).where(eq(requests.id, request!.id));
    expect(await timerTick(app.ctx, at(20))).toBe(1);
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

  it('saves job.program for a running turn and exposes it in agent data (/api/org, /api/agents/:id, and /api/agents/:id/events), clearing it when the turn ends', async () => {
    const { app, db, ceo, orchestrator } = await company();
    const [dev] = await db.insert(departments).values({ companyId: orchestrator.companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    const [bruno] = await db
      .insert(agents)
      .values({ companyId: orchestrator.companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: orchestrator.subscriptionId })
      .returning();
    const startedAt = new Date();
    const at = (minutes: number) => new Date(startedAt.getTime() + minutes * MIN);
    const [turn] = await db
      .insert(jobs)
      .values({
        companyId: orchestrator.companyId,
        subscriptionId: orchestrator.subscriptionId!,
        agentId: bruno!.id,
        kind: 'conversation',
        prompt: 'Build POST /checkout.',
        timeoutMs: 900_000,
        status: 'running',
        startedAt,
      })
      .returning();

    await handleNodeMessage(
      app.ctx,
      BUILTIN,
      { type: 'job.program', jobId: turn!.id, state: 'tool', since: at(2).getTime(), tool: 'Bash', screenAt: at(3).getTime() },
      at(3),
    );

    const expectedProgram = {
      state: 'tool',
      since: at(2).getTime(),
      tool: 'Bash',
      screenAt: at(3).getTime(),
      signAt: null,
      retry: null,
      reportedAt: at(3).getTime(),
    };
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    const devEmp = org.departments.find((d: { id: string }) => d.id === dev!.id).employees.find((e: { id: string }) => e.id === bruno!.id);
    expect(devEmp.program).toEqual(expectedProgram);
    expect(devEmp.alarm).toBeNull();

    const card = (await app.inject({ url: `/api/agents/${bruno!.id}`, ...as(ceo) })).json();
    expect(card.program).toEqual(expectedProgram);
    expect(card.alarm).toBeNull();

    const events = (await app.inject({ url: `/api/agents/${bruno!.id}/events`, ...as(ceo) })).json();
    expect(events.state.program).toEqual(expectedProgram);
    expect(events.state.alarm).toBeNull();

    await handleNodeMessage(app.ctx, BUILTIN, { type: 'job.done', jobId: turn!.id, ok: true, result: 'Done.', sessionId: null, tail: '', error: null }, at(4));
    const afterCard = (await app.inject({ url: `/api/agents/${bruno!.id}`, ...as(ceo) })).json();
    expect(afterCard.program).toBeNull();
    expect(afterCard.alarm).toBeNull();
  });

  it('gives no alarm while the program thinks or runs a tool with a changing screenAt, then raises an alarm with reason program_stalled after 10 minutes without state or screen changes, tells the head of Operations and not the watchdog, calls again only each time the quiet has doubled, and keeps the turn running', async () => {
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
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    const [bruno] = await db
      .insert(agents)
      .values({ companyId: orchestrator.companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: orchestrator.subscriptionId })
      .returning();
    const [task] = await db
      .insert(tasks)
      .values({ companyId: orchestrator.companyId, number: 1, title: 'Checkout API', status: 'working', departmentId: dev!.id, assigneeAgentId: bruno!.id, executorAgentId: bruno!.id })
      .returning();
    await db.transaction(tx => createRoute(tx, task!, {}, developmentStages()));
    const startedAt = new Date();
    const at = (minutes: number) => new Date(startedAt.getTime() + minutes * MIN);
    await db.update(agents).set({ timerAt: at(300) }).where(eq(agents.id, waltId));

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
    await keepTaskWake(db, task!, bruno!.id, turn!.id);

    /* While thinking or running a tool with changing screenAt, even past 10 minutes from since, no alarm fires. */
    await handleNodeMessage(
      app.ctx,
      BUILTIN,
      { type: 'job.program', jobId: turn!.id, state: 'thinking', since: startedAt.getTime(), screenAt: at(31).getTime() },
      at(31),
    );
    await minuteRound(app.ctx, at(31), () => () => {});
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);

    await handleNodeMessage(
      app.ctx,
      BUILTIN,
      { type: 'job.program', jobId: turn!.id, state: 'tool', since: at(5).getTime(), tool: 'Bash', screenAt: at(36).getTime() },
      at(36),
    );
    await minuteRound(app.ctx, at(36), () => () => {});
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);

    /* Now the node keeps reporting, but neither state (since at +5m) nor screen (screenAt at +36m) changes for 10 minutes (+46m). */
    await handleNodeMessage(
      app.ctx,
      BUILTIN,
      { type: 'job.program', jobId: turn!.id, state: 'tool', since: at(5).getTime(), tool: 'Bash', screenAt: at(36).getTime() },
      at(45),
    );
    await minuteRound(app.ctx, at(45), () => () => {});
    expect(await db.select().from(jobs).where(eq(jobs.agentId, wandaId))).toHaveLength(0);

    await handleNodeMessage(
      app.ctx,
      BUILTIN,
      { type: 'job.program', jobId: turn!.id, state: 'tool', since: at(5).getTime(), tool: 'Bash', screenAt: at(36).getTime() },
      at(46),
    );
    await minuteRound(app.ctx, at(46), () => () => {});
    expect((await db.select().from(jobs).where(eq(jobs.id, turn!.id)))[0]!.status).toBe('running');
    /* No program operator is hired, so the head of Operations is told; the watchdog never is. */
    const wandaTurns = await db.select().from(jobs).where(eq(jobs.agentId, wandaId));
    expect(wandaTurns).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);
    for (const part of ['Bruno', 'Backend engineer', turn!.id, '#1', 'Checkout API', 'tool (Bash)', at(36).toISOString(), 'program_stalled', `Read program_screen for employee ${bruno!.id}`, 'restart_program']) {
      expect(wandaTurns[0]!.prompt).toContain(part);
    }

    const card = (await app.inject({ url: `/api/agents/${bruno!.id}`, ...as(ceo) })).json();
    expect(card.alarm).toEqual({ reason: 'program_stalled', since: at(36).getTime() });

    /* One call when the quiet begins (+46m, 10 minutes of quiet) and one more each time it has doubled (20, 40, 80 minutes: +56m, +76m, +116m), never in between, and the orchestrator is not woken. */
    const orchBefore = (await db.select().from(jobs).where(eq(jobs.agentId, orchestrator.id))).length;
    const quietRound = async (minute: number) => {
      await db.update(jobs).set({ status: 'done', finishedAt: at(minute) }).where(and(eq(jobs.agentId, wandaId), eq(jobs.status, 'running')));
      await handleNodeMessage(
        app.ctx,
        BUILTIN,
        { type: 'job.program', jobId: turn!.id, state: 'tool', since: at(5).getTime(), tool: 'Bash', screenAt: at(36).getTime() },
        at(minute),
      );
      await minuteRound(app.ctx, at(minute), () => () => {});
      return (await db.select().from(jobs).where(eq(jobs.agentId, wandaId))).length;
    };
    expect(await quietRound(47)).toBe(1);
    expect(await quietRound(55)).toBe(1);
    expect(await quietRound(56)).toBe(2);
    expect(await quietRound(75)).toBe(2);
    expect(await quietRound(76)).toBe(3);
    expect(await quietRound(115)).toBe(3);
    expect(await quietRound(116)).toBe(4);
    expect(await quietRound(160)).toBe(4);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, orchestrator.id))).toHaveLength(orchBefore);
    expect((await db.select().from(jobs).where(eq(jobs.id, turn!.id)))[0]!.status).toBe('running');
  });

  it('raises an alarm with reason node_silent after 10 minutes without a message from the node, tells the head of Operations and not the watchdog, calls again only when the quiet has doubled, and keeps the turn running', async () => {
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
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    const [bruno] = await db
      .insert(agents)
      .values({ companyId: orchestrator.companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: orchestrator.subscriptionId })
      .returning();
    const [task] = await db
      .insert(tasks)
      .values({ companyId: orchestrator.companyId, number: 1, title: 'Checkout API', status: 'working', departmentId: dev!.id, assigneeAgentId: bruno!.id, executorAgentId: bruno!.id })
      .returning();
    await db.transaction(tx => createRoute(tx, task!, {}, developmentStages()));
    const startedAt = new Date();
    const at = (minutes: number) => new Date(startedAt.getTime() + minutes * MIN);
    await db.update(agents).set({ timerAt: at(300) }).where(eq(agents.id, waltId));

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
    await keepTaskWake(db, task!, bruno!.id, turn!.id);

    await handleNodeMessage(
      app.ctx,
      BUILTIN,
      { type: 'job.program', jobId: turn!.id, state: 'thinking', since: at(10).getTime(), screenAt: at(10).getTime() },
      at(10),
    );

    await minuteRound(app.ctx, at(15), () => () => {});
    await minuteRound(app.ctx, at(19), () => () => {});
    expect(await db.select().from(jobs).where(eq(jobs.agentId, wandaId))).toHaveLength(0);

    await minuteRound(app.ctx, at(20), () => () => {});
    expect((await db.select().from(jobs).where(eq(jobs.id, turn!.id)))[0]!.status).toBe('running');
    /* No program operator is hired, so the head of Operations is told; the watchdog never is. */
    const wandaTurns = await db.select().from(jobs).where(eq(jobs.agentId, wandaId));
    expect(wandaTurns).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);
    for (const part of ['Bruno', 'Backend engineer', turn!.id, '#1', 'Checkout API', 'thinking', at(10).toISOString(), 'node_silent', `Read program_screen for employee ${bruno!.id}`, 'restart_program']) {
      expect(wandaTurns[0]!.prompt).toContain(part);
    }

    const card = (await app.inject({ url: `/api/agents/${bruno!.id}`, ...as(ceo) })).json();
    expect(card.alarm).toEqual({ reason: 'node_silent', since: at(10).getTime() });

    /* One more call each time the quiet has doubled (20 minutes of quiet: +30m), none in between. Wanda is still on the
       first call, so the free orchestrator hears the second; the watchdog never does. */
    const callsAbout = async () => (await db.select(only(agentEvents, 'agentId')).from(agentEvents)
      .where(and(eq(agentEvents.kind, 'message'), sql`split_part(${agentEvents.data}->>'silentJob', ':', 1) = ${turn!.id}`))).map(e => e.agentId);
    await minuteRound(app.ctx, at(25), () => () => {});
    await minuteRound(app.ctx, at(29), () => () => {});
    expect(await callsAbout()).toEqual([wandaId]);
    await minuteRound(app.ctx, at(30), () => () => {});
    expect((await callsAbout()).sort()).toEqual([wandaId, orchestrator.id].sort());
    expect(await db.select().from(jobs).where(eq(jobs.agentId, wandaId))).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);
  });

  it('says the reason of an alarm first, so the head of Operations reads it in its inbox turn, where each letter is cut short', async () => {
    const { app, db, wandaId, orchestrator } = await company({ inbox: true });
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
    await db.transaction(tx => createRoute(tx, task!, {}, developmentStages()));
    const startedAt = new Date();
    const at = (minutes: number) => new Date(startedAt.getTime() + minutes * MIN);
    const [turn] = await db
      .insert(jobs)
      .values({ companyId: orchestrator.companyId, subscriptionId: orchestrator.subscriptionId!, agentId: bruno!.id, taskId: task!.id, kind: 'conversation', prompt: 'Build POST /checkout.', timeoutMs: 900_000, status: 'running', startedAt })
      .returning();
    await keepTaskWake(db, task!, bruno!.id, turn!.id);
    await handleNodeMessage(app.ctx, BUILTIN, { type: 'job.program', jobId: turn!.id, state: 'thinking', since: at(10).getTime(), screenAt: at(10).getTime() }, at(10));

    await minuteRound(app.ctx, at(20), () => () => {});
    const [wandaTurn] = await db.select().from(jobs).where(eq(jobs.agentId, wandaId));
    expect(wandaTurn).toMatchObject({ inboxWake: true });
    expect(wandaTurn!.prompt).toContain('Each is cut at 300 characters.');
    expect(wandaTurn!.prompt).toContain('node_silent (node has not reported for 10 minutes)');
    expect(wandaTurn!.prompt).toContain('Bruno (Backend engineer)');
  });

  it("sends the 30-minute alarm to the head of Operations when the task watchdog's own turn is silent, or when the watchdog is busy, off, or removed, without closing the watchdog's turn", async () => {
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
    await db.update(agents).set({ timerAt: at(300) }).where(eq(agents.id, waltId));

    /* Case 1: Walt's own turn is silent for 30 minutes; alarm goes to Wanda (OPS-HEAD) and Walt's turn stays running. */
    const [waltTurn] = await db
      .insert(jobs)
      .values({
        companyId: orchestrator.companyId,
        subscriptionId: orchestrator.subscriptionId!,
        agentId: waltId,
        kind: 'conversation',
        prompt: 'Inspecting logs.',
        timeoutMs: 900_000,
        status: 'running',
        startedAt,
      })
      .returning();

    await minuteRound(app.ctx, at(30), () => () => {});
    expect((await db.select().from(jobs).where(eq(jobs.id, waltTurn!.id)))[0]!.status).toBe('running');
    const wandaTurns1 = await db.select().from(jobs).where(eq(jobs.agentId, wandaId));
    expect(wandaTurns1).toHaveLength(1);
    for (const part of ['Walt', 'Task watchdog', waltTurn!.id, startedAt.toISOString(), 'node_silent']) {
      expect(wandaTurns1[0]!.prompt).toContain(part);
    }

    /* Case 2: Walt is switched off when another turn hits 30 minutes; alarm goes to Wanda. */
    await db.update(jobs).set({ status: 'done', finishedAt: at(31) }).where(eq(jobs.id, waltTurn!.id));
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

    /* Case 3: Walt is removed when another turn hits 30 minutes; alarm goes to Wanda. */
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

  it('retries the 10-minute alarm on the next minute round when saving the alarm fails once, then deduplicates it', async () => {
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
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    const [bruno] = await db
      .insert(agents)
      .values({ companyId: orchestrator.companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: orchestrator.subscriptionId })
      .returning();
    const startedAt = new Date();
    const at = (minutes: number) => new Date(startedAt.getTime() + minutes * MIN);
    await db.update(agents).set({ timerAt: at(300) }).where(eq(agents.id, waltId));

    const [turn] = await db
      .insert(jobs)
      .values({
        companyId: orchestrator.companyId,
        subscriptionId: orchestrator.subscriptionId!,
        agentId: bruno!.id,
        kind: 'conversation',
        prompt: 'Build POST /checkout.',
        timeoutMs: 900_000,
        status: 'running',
        startedAt,
      })
      .returning();

    const realInsert = db.insert.bind(db);
    let failOnce = true;
    db.insert = ((...args: Parameters<typeof db.insert>) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('transient db write error');
      }
      return realInsert(...args);
    }) as typeof db.insert;

    const errors: unknown[] = [];
    await minuteRound(app.ctx, at(10), () => err => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, wandaId))).toHaveLength(0);

    /* No program operator is hired, so the head of Operations is told; the watchdog never is. */
    await minuteRound(app.ctx, at(11), () => () => {});
    const wandaTurns = await db.select().from(jobs).where(eq(jobs.agentId, wandaId));
    expect(wandaTurns).toHaveLength(1);
    expect(wandaTurns[0]!.prompt).toContain(turn!.id);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);

    await minuteRound(app.ctx, at(12), () => () => {});
    expect(await db.select().from(jobs).where(eq(jobs.agentId, wandaId))).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);
  });
});

describe('the sweeps of a leading app', () => {
  const EVERY_MS = 1000;
  /* Sweeps that stay running until the test ends them, and how many of each kind started. */
  function sweeps() {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const started = { entry: 0, tick: 0 };
    let end: () => void = () => undefined;
    const running = (kind: keyof typeof started) => () => {
      started[kind]++;
      return new Promise<void>(done => (end = done));
    };
    const stalled: number[] = [];
    return { started, stalled, endSweep: () => end(), ...leadSweeps(running('entry'), running('tick'), EVERY_MS, ticks => stalled.push(ticks)) };
  }
  /* Tells whether a promise has ended by now, after everything already due has run. */
  async function ended(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    void promise.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    return done;
  }

  it('does not leave while the sweeps of the way in still run', async () => {
    const { started, endSweep, enter, leave } = sweeps();
    enter();
    expect(started.entry).toBe(1);
    const leaving = leave();
    expect(await ended(leaving)).toBe(false);
    endSweep();
    expect(await ended(leaving)).toBe(true);
  });

  it('starts no round over the sweeps of the way in', async () => {
    const { started, endSweep, enter, leave } = sweeps();
    enter();
    vi.advanceTimersByTime(EVERY_MS);
    expect(started.tick).toBe(0);
    endSweep();
    await vi.advanceTimersByTimeAsync(EVERY_MS);
    expect(started.tick).toBe(1);
    endSweep();
    await leave();
  });

  it('starts no round over a round that overran, and leaving waits for the one that runs', async () => {
    const { started, endSweep, enter, leave } = sweeps();
    enter();
    endSweep();
    await vi.advanceTimersByTimeAsync(EVERY_MS);
    await vi.advanceTimersByTimeAsync(3 * EVERY_MS);
    expect(started.tick).toBe(1);
    const leaving = leave();
    expect(await ended(leaving)).toBe(false);
    endSweep();
    expect(await ended(leaving)).toBe(true);
  });

  it('gives up waiting for a round that has not ended after five ticks, says so once, and goes on with the next', async () => {
    const { started, stalled, endSweep, enter, leave } = sweeps();
    enter();
    endSweep();
    await vi.advanceTimersByTimeAsync(EVERY_MS);
    expect(started.tick).toBe(1);
    /* That round never ends. Four ticks find it running and start nothing. */
    await vi.advanceTimersByTimeAsync(4 * EVERY_MS);
    expect(started.tick).toBe(1);
    expect(stalled).toEqual([]);
    await vi.advanceTimersByTimeAsync(EVERY_MS);
    expect(stalled).toEqual([5]);
    expect(started.tick).toBe(2);
    /* Leaving waits for the round that runs now, and no longer for the one given up. */
    const leaving = leave();
    expect(await ended(leaving)).toBe(false);
    endSweep();
    expect(await ended(leaving)).toBe(true);
    expect(stalled).toEqual([5]);
  });

  it('starts no round once it has left', async () => {
    const { started, endSweep, enter, leave } = sweeps();
    enter();
    endSweep();
    await leave();
    await vi.advanceTimersByTimeAsync(3 * EVERY_MS);
    expect(started.tick).toBe(0);
  });
});
