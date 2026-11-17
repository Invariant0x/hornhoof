import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, goals, jobs, people, pipelines, pipelineStages, subscriptions, tasks, taskWaits } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { repeatWake, taskForWake } from '../src/modules/tasks/wake-state.js';
import { editTask, seenOf } from '../src/modules/tracker/edit.js';
import { nudgeTrackerKeepers } from '../src/modules/tracker/nudge.js';
import { as, echelonsTurn, invitePerson, listen, mcp, setUpCompany, testApp } from './helpers.js';

/* The edges of the tracker: what a quick reading of its rules leaves out. */
async function company() {
  const { app, db } = await testApp();
  await listen(app);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [dev, sales, fin] = await db.insert(departments).values([
    { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
    { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    { companyId, templateKey: 'finance', roleCode: 'FIN', position: 3 },
  ]).returning();
  const [shop] = await db.insert(departments).values({ companyId, parentId: dev!.id, name: 'Shop', roleCode: 'DEV', position: 1 }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id, productId: string | null = null) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, productId, model: '', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)!.skills.filter(s => s.on).map(s => s.id) }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE', dev!.id, shop!.id);
  const pia = await hire('Pia', 'worker', 'DEV-PM');
  const oleg = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id] } });
  await invitePerson(app, ceo, { name: 'Pavel', email: 'pavel@acme.com', access: { departments: [dev!.id] } });
  await echelonsTurn(db, companyId);
  let n = 0;
  const tools = async (agent: { id: string }) => {
    const token = `guard-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  const id = async (email: string) => (await db.select({ id: people.id }).from(people).where(eq(people.email, email)))[0]!.id;
  const work = () => createTask(app.ctx, { agentId: head.id }, { title: 'Checkout', brief: 'Pay by card.', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, resultKind: 'coordination' });
  const send = (method: 'POST' | 'PATCH', token: string, url: string, payload: object = {}) => app.inject({ method, url, payload, ...as(token) });
  return { app, db, ctx: app.ctx, companyId, ceo, oleg, dev: dev!, sales: sales!, fin: fin!, shop: shop!, head, bruno, pia, tools, work, send, ivanId: await id('ivan@acme.com'), pavelId: await id('pavel@acme.com'), olegId: await id('oleg@acme.com') };
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Res;

describe('the tracker at its edges', () => {
  it('keeps the next round at least 15 minutes after the last one, however many changes nudge it', async () => {
    const { ctx, db, pia, dev, companyId } = await company();
    /* The clock the server counts on, which only the test moves. */
    let now = Date.parse('2026-03-02T09:00:00.000Z');
    ctx.clock = () => now;
    const lastRound = new Date(now - 60_000);
    await db.update(agents).set({ timerMinutes: 240, timerOrder: 'Go over the tracker.', timerAt: lastRound }).where(eq(agents.id, pia.id));
    const nextRound = async () => {
      const [a] = await db.select({ at: agents.timerAt, nudged: agents.timerNudgedAt }).from(agents).where(eq(agents.id, pia.id));
      expect(a!.at!.getTime()).toBe(lastRound.getTime());
      return (a!.nudged!.getTime() - lastRound.getTime()) / 60_000;
    };
    await nudgeTrackerKeepers(ctx, { companyId, departmentId: dev.id });
    expect(await nextRound()).toBe(15);
    now += 2 * 60_000;
    await nudgeTrackerKeepers(ctx, { companyId, departmentId: dev.id });
    expect(await nextRound()).toBe(15);
  });

  it('refuses two stages that name one stage, in words', async () => {
    const { oleg, dev, send } = await company();
    const made = (await send('POST', oleg, '/api/pipelines', { name: 'P', department: dev.id, stages: [{ key: 'a', parent: null, name: 'A', ownerRole: 'DEV-BE' }, { key: 'b', parent: 'a', name: 'B', ownerRole: 'DEV-BE' }] })).json().pipeline;
    const [x, y] = made.stages as { id: string }[];
    const twice = await send('PATCH', oleg, `/api/pipelines/${made.id}`, { version: made.version, stages: [
      { key: 'a', id: x!.id, parent: null, name: 'A', ownerRole: 'DEV-BE' },
      { key: 'b', id: y!.id, parent: 'a', name: 'B', ownerRole: 'DEV-BE' },
      { key: 'c', id: x!.id, parent: 'b', name: 'C', ownerRole: 'DEV-BE' },
    ] });
    expect([twice.statusCode, twice.json().error.reason]).toEqual([400, 'pipeline_invalid']);
  });

  it('lets a product have a pipeline owned by its roles and its employees', async () => {
    const { oleg, shop, bruno, send } = await company();
    const made = await send('POST', oleg, '/api/pipelines', { name: 'Shop releases', department: shop.id, stages: [{ key: 'a', parent: null, name: 'Build', ownerRole: 'DEV-BE' }, { key: 'b', parent: 'a', name: 'Check', ownerAgentId: bruno.id }] });
    expect(made.statusCode, made.body).toBe(201);
  });

  it('removes a department with goals and pipelines, keeping its goals for the company', async () => {
    const { db, ceo, fin, send } = await company();
    expect((await send('POST', ceo, '/api/goals', { title: 'Close the books', department: fin.id })).statusCode).toBe(201);
    expect((await send('POST', ceo, '/api/pipelines', { name: 'Books', department: fin.id, stages: [{ key: 'a', parent: null, name: 'Count', ownerRole: 'FIN-HEAD' }] })).statusCode).toBe(201);
    const gone = await send('POST', ceo, '/api/departments/build', { items: [{ department: fin.id, note: 'Not yet', remove: true }] });
    expect(gone.statusCode, gone.body).toBe(201);
    expect((await db.select().from(goals)).map(g => [g.title, g.departmentId])).toEqual([['Close the books', null]]);
    expect([await db.select().from(pipelines), await db.select().from(pipelineStages)]).toEqual([[], []]);
  });

  it('leaves the work of update_task as it was when its tracker part is refused', async () => {
    const { db, head, tools, work } = await company();
    const { task } = await work();
    const res = await call(await tools(head), 'update_task', { task: task.number, title: 'Checkout v2', goal: 999 });
    expect(res.isError).toBe(true);
    expect((await db.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, task.id)))[0]!.title).toBe('Checkout');
  });

  it('keeps a waiting repeat of the holder turn after an edit of the tracker fields, and the version too', async () => {
    const { db, ctx, companyId, bruno, head, work } = await company();
    const { task } = await work();
    const [sub] = await db.select().from(subscriptions);
    const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'x', timeoutMs: 900000, status: 'failed', error: 'agent_failed' }).returning();
    const [fresh] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    const state = await repeatWake(db, { job: job!, task: fresh!, agent: bruno }, 'continue');
    const edited = await editTask(ctx, { agentId: head.id }, fresh!, { why: 'Customers asked for it.' }, seenOf(fresh!));
    expect([edited.why, edited.version, edited.updatedAt.getTime()]).toEqual(['Customers asked for it.', fresh!.version, fresh!.updatedAt.getTime()]);
    expect(await taskForWake(db, { agentId: bruno.id, taskId: task.id, why: state!.why as never, version: state!.version })).not.toBeNull();
  });

  it('lets a product manager name on a goal only the person who decides for the department or the one already on it', async () => {
    const { db, pia, tools, work, pavelId, ivanId } = await company();
    const { task } = await work();
    const pm = await tools(pia);
    expect((await call(pm, 'set_goal', { title: 'Mine', responsible: pavelId })).isError).toBe(true);
    /* Two people reach Development, so the CEO decides for it. */
    const made = await call(pm, 'set_goal', { title: 'Ours', responsible: ivanId });
    expect(made.isError, made.content[0]!.text).toBeFalsy();
    const number = JSON.parse(made.content[0]!.text).number;
    expect((await call(pm, 'set_goal', { goal: number, responsible: pavelId })).isError).toBe(true);
    expect((await call(pm, 'tidy_task', { task: task.number, goal: number, responsible: pavelId })).isError).toBe(true);
    expect((await db.select({ r: tasks.responsiblePersonId }).from(tasks).where(eq(tasks.id, task.id)))[0]!.r).not.toBe(pavelId);
  });

  it('names whom a task waits for only as its wait owner is shown: never another person', async () => {
    const { app, db, companyId, oleg, ceo, pavelId, work } = await company();
    const { task } = await work();
    await db.insert(taskWaits).values({ companyId, taskId: task.id, kind: 'person', sourceKey: 'question', sourceRevision: 0, state: 'legacy_needs_plan', ownerPersonId: pavelId });
    const waitsOn = async (token: string) => (await app.inject({ url: `/api/tasks/${task.id}`, ...as(token) })).json().task.time.waitsOn as { who: { id: string } | null }[];
    expect((await waitsOn(oleg)).map(w => w.who)).toEqual([null]);
    expect((await waitsOn(ceo)).map(w => w.who?.id)).toEqual([pavelId]);
  });
});
