import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agentChanges, agentEvents, agents, departments, jobs } from '../src/db/schema.js';
import { timerTick } from '../src/modules/agents/timers.js';
import { as, setUpCompany, testApp } from './helpers.js';

/* Operations with Wanda on the company key, which the built-in node runs. */
async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
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
  return { app, db, ceo, wandaId, orchestrator: orchestrator! };
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
