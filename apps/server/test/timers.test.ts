import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentChanges, agentEvents, agents, departments, jobs, tasks } from '../src/db/schema.js';
import { leadSweeps, minuteRound, timerTick } from '../src/modules/agents/timers.js';
import { agentState, insertTurn, onAgent } from '../src/modules/conversation/queue.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
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

  it('gives no alarm while the program thinks or runs a tool with a changing screenAt, then raises one alarm with reason program_stalled after 30 minutes without state or screen changes and keeps the turn running', async () => {
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

    /* While thinking or running a tool with changing screenAt, even past 30 minutes from since, no alarm fires. */
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

    /* Now the node keeps reporting, but neither state (since at +5m) nor screen (screenAt at +36m) changes for 30 minutes (+66m). */
    await handleNodeMessage(
      app.ctx,
      BUILTIN,
      { type: 'job.program', jobId: turn!.id, state: 'tool', since: at(5).getTime(), tool: 'Bash', screenAt: at(36).getTime() },
      at(65),
    );
    await minuteRound(app.ctx, at(65), () => () => {});
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);

    await handleNodeMessage(
      app.ctx,
      BUILTIN,
      { type: 'job.program', jobId: turn!.id, state: 'tool', since: at(5).getTime(), tool: 'Bash', screenAt: at(36).getTime() },
      at(66),
    );
    await minuteRound(app.ctx, at(66), () => () => {});
    expect((await db.select().from(jobs).where(eq(jobs.id, turn!.id)))[0]!.status).toBe('running');
    const waltTurns = await db.select().from(jobs).where(eq(jobs.agentId, waltId));
    expect(waltTurns).toHaveLength(1);
    for (const part of ['Bruno', 'Backend engineer', turn!.id, '#1', 'Checkout API', 'tool (Bash)', at(36).toISOString(), 'program_stalled']) {
      expect(waltTurns[0]!.prompt).toContain(part);
    }

    const card = (await app.inject({ url: `/api/agents/${bruno!.id}`, ...as(ceo) })).json();
    expect(card.alarm).toEqual({ reason: 'program_stalled', since: at(36).getTime() });

    /* One alarm per turn: even after Walt finishes his alarm turn, further minute rounds (including past 2 hours) send no second alarm and do not wake the orchestrator. */
    await db.update(jobs).set({ status: 'done', finishedAt: at(67) }).where(eq(jobs.id, waltTurns[0]!.id));
    const orchBefore = (await db.select().from(jobs).where(eq(jobs.agentId, orchestrator.id))).length;
    await handleNodeMessage(
      app.ctx,
      BUILTIN,
      { type: 'job.program', jobId: turn!.id, state: 'tool', since: at(5).getTime(), tool: 'Bash', screenAt: at(36).getTime() },
      at(70),
    );
    await minuteRound(app.ctx, at(70), () => () => {});
    await handleNodeMessage(
      app.ctx,
      BUILTIN,
      { type: 'job.program', jobId: turn!.id, state: 'tool', since: at(5).getTime(), tool: 'Bash', screenAt: at(36).getTime() },
      at(160),
    );
    await minuteRound(app.ctx, at(160), () => () => {});
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, wandaId))).toHaveLength(0);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, orchestrator.id))).toHaveLength(orchBefore);
    expect((await db.select().from(jobs).where(eq(jobs.id, turn!.id)))[0]!.status).toBe('running');
  });

  it('raises one alarm with reason node_silent after 30 minutes without a message from the node and keeps the turn running', async () => {
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
    const [task] = await db
      .insert(tasks)
      .values({ companyId: orchestrator.companyId, number: 1, title: 'Checkout API', status: 'working', departmentId: dev!.id, assigneeAgentId: bruno!.id, executorAgentId: bruno!.id })
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
        taskId: task!.id,
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
      { type: 'job.program', jobId: turn!.id, state: 'thinking', since: at(10).getTime(), screenAt: at(10).getTime() },
      at(10),
    );

    await minuteRound(app.ctx, at(25), () => () => {});
    await minuteRound(app.ctx, at(39), () => () => {});
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);

    await minuteRound(app.ctx, at(40), () => () => {});
    expect((await db.select().from(jobs).where(eq(jobs.id, turn!.id)))[0]!.status).toBe('running');
    const waltTurns = await db.select().from(jobs).where(eq(jobs.agentId, waltId));
    expect(waltTurns).toHaveLength(1);
    for (const part of ['Bruno', 'Backend engineer', turn!.id, '#1', 'Checkout API', 'thinking', at(10).toISOString(), 'node_silent']) {
      expect(waltTurns[0]!.prompt).toContain(part);
    }

    const card = (await app.inject({ url: `/api/agents/${bruno!.id}`, ...as(ceo) })).json();
    expect(card.alarm).toEqual({ reason: 'node_silent', since: at(10).getTime() });

    await minuteRound(app.ctx, at(45), () => () => {});
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(1);
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

  it('retries the 30-minute alarm on the next minute round when saving the alarm fails once, then deduplicates it', async () => {
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
    await minuteRound(app.ctx, at(30), () => err => errors.push(err));
    expect(errors).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(0);

    await minuteRound(app.ctx, at(31), () => () => {});
    const waltTurns = await db.select().from(jobs).where(eq(jobs.agentId, waltId));
    expect(waltTurns).toHaveLength(1);
    expect(waltTurns[0]!.prompt).toContain(turn!.id);

    await minuteRound(app.ctx, at(32), () => () => {});
    expect(await db.select().from(jobs).where(eq(jobs.agentId, waltId))).toHaveLength(1);
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
    return { started, endSweep: () => end(), ...leadSweeps(running('entry'), running('tick'), EVERY_MS) };
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

  it('starts no round once it has left', async () => {
    const { started, endSweep, enter, leave } = sweeps();
    enter();
    endSweep();
    await leave();
    await vi.advanceTimersByTimeAsync(3 * EVERY_MS);
    expect(started.tick).toBe(0);
  });
});
