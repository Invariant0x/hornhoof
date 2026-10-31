import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agentChanges, agentEvents, agents, departments, jobs, tasks } from '../src/db/schema.js';
import { timerTick } from '../src/modules/agents/timers.js';
import { agentState, onAgent } from '../src/modules/conversation/queue.js';
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
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, task!.id));
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
});
