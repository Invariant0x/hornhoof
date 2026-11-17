import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, goals, jobs, people, pipelines, pipelineStages, subscriptions, tasks } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { createPipeline, editPipeline } from '../src/modules/tracker/pipelines.js';
import { as, echelonsTurn, invitePerson, listen, mcp, setUpCompany, testApp } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  await listen(app);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev, sales] = await db.insert(departments).values([
    { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
    { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
  ]).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)!.skills.filter(s => s.on).map(s => s.id) }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const pia = await hire('Pia', 'worker', 'DEV-PM');
  const salesHead = await hire('Sol', 'head', 'SAL-HEAD', sales!.id);
  await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id] } });
  await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
  await echelonsTurn(db, companyId);
  let n = 0;
  const tools = async (agent: { id: string }) => {
    const token = `tracker-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  const id = async (email: string) => (await db.select({ id: people.id }).from(people).where(eq(people.email, email)))[0]!.id;
  const work = (departmentId = dev!.id, holder = bruno.id, by = head.id) =>
    createTask(app.ctx, { agentId: by }, { title: 'Checkout', brief: 'Pay by card.', body: '', departmentId, assigneeAgentId: holder, executor: true, resultKind: 'coordination' });
  return { app, db, ctx: app.ctx, companyId, ceo, orchestrator: orchestrator!, dev: dev!, sales: sales!, head, bruno, pia, salesHead, tools, work, ivanId: await id('ivan@acme.com'), olegId: await id('oleg@acme.com'), mariaId: await id('maria@acme.com') };
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Res;
const text = (r: Res) => r.content[0]!.text;
const names = async (c: Client) => (await c.listTools()).tools.map(t => t.name);

describe('tracker tools', () => {
  it('give goals to everyone, setting goals and pipelines to heads, the orchestrator and the product manager, and tidying to the product manager alone', async () => {
    const { head, bruno, pia, orchestrator, tools } = await company();
    const has = async (agent: { id: string }) => (await names(await tools(agent))).filter(t => ['goals', 'set_goal', 'set_pipeline', 'tidy_task'].includes(t)).sort();
    expect(await has(bruno)).toEqual(['goals']);
    expect(await has(head)).toEqual(['goals', 'set_goal', 'set_pipeline']);
    expect(await has(orchestrator)).toEqual(['goals', 'set_goal', 'set_pipeline']);
    expect(await has(pia)).toEqual(['goals', 'set_goal', 'set_pipeline', 'tidy_task']);
  });

  it('set goals of the own department, the company ones only through the orchestrator', async () => {
    const { db, dev, head, orchestrator, olegId, tools } = await company();
    const top = await call(await tools(orchestrator), 'set_goal', { company: true, title: 'Grow', why: 'Revenue before the round.' });
    expect(top.isError, text(top)).toBeFalsy();
    const refused = await call(await tools(head), 'set_goal', { company: true, title: 'Grow more' });
    expect(refused.isError).toBe(true);
    const made = await call(await tools(head), 'set_goal', { title: 'Shop', parent: 1, responsible: olegId, target: 500, current: 212, unit: 'subscribers' });
    expect(made.isError, text(made)).toBeFalsy();
    const edited = await call(await tools(head), 'set_goal', { goal: 2, current: 250, status: 'active' });
    expect(edited.isError, text(edited)).toBeFalsy();
    expect((await db.select().from(goals).where(eq(goals.number, 2)))[0]).toMatchObject({ departmentId: dev.id, responsiblePersonId: olegId, currentValue: 250 });
    const read = JSON.parse(text(await call(await tools(head), 'goals')));
    expect(read.goals.map((g: { number: number; progress: number | null }) => [g.number, g.progress])).toEqual([[1, null], [2, 0.5]]);
  });

  it('take goal, why, responsible person and pipeline on create_task and update_task', async () => {
    const { db, companyId, dev, head, bruno, ivanId, tools } = await company();
    await db.insert(goals).values({ companyId, number: 1, departmentId: dev.id, title: 'Shop', responsiblePersonId: ivanId });
    const pipe = JSON.parse(text(await call(await tools(head), 'set_pipeline', { name: 'Releases', stages: [{ key: 'build', parent: null, name: 'Build', ownerRole: 'DEV-BE' }] })));
    const made = await call(await tools(head), 'create_task', { title: 'Checkout', brief: 'Pay.', body: 'Card.', executor: bruno.id, resultKind: 'coordination', goal: 1, why: 'Shops sell online.', pipeline: pipe.id });
    expect(made.isError, text(made)).toBeFalsy();
    const [task] = await db.select().from(tasks).where(eq(tasks.title, 'Checkout'));
    expect(task).toMatchObject({ why: 'Shops sell online.', responsiblePersonId: ivanId, pipelineId: pipe.id, pipelineStageId: pipe.stages[0].id });
    const updated = await call(await tools(head), 'update_task', { task: task!.number, why: 'People pay without calling.', due: '2026-12-01T00:00:00.000Z' });
    expect(updated.isError, text(updated)).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.id, task!.id)))[0]).toMatchObject({ why: 'People pay without calling.', dueAt: new Date('2026-12-01T00:00:00.000Z') });
  });

  it('change the work and the stage of update_task together or not at all, when the stage goes meanwhile', async () => {
    const { app, db, companyId, dev, head, tools, work } = await company();
    const anyone = async () => {};
    const pipe = await createPipeline(app.ctx, companyId, { agentId: head.id }, anyone, dev.id, { name: 'Releases', why: '', stages: [
      { key: 'build', parent: null, name: 'Build', ownerRole: 'DEV-BE' },
      { key: 'check', parent: 'build', name: 'Check', ownerRole: 'DEV-HEAD' },
    ] });
    const stage = async (name: string) => (await db.select().from(pipelineStages).where(eq(pipelineStages.name, name)))[0]!;
    const [build, check] = [await stage('Build'), await stage('Check')];
    const { task } = await work();
    await db.update(tasks).set({ pipelineId: pipe.id, pipelineStageId: build.id }).where(eq(tasks.id, task.id));
    const asHead = await tools(head);
    /* Someone takes Check off the pipeline once the tool checked what it names, as the work is about to be written. */
    const begin = db.transaction.bind(db);
    let raced = false;
    vi.spyOn(db, 'transaction').mockImplementation(async (fn, config) => {
      if (!raced && /\bupdateTask\b/.test(new Error().stack ?? '')) {
        raced = true;
        await editPipeline(app.ctx, companyId, anyone, pipe.id, { stages: [{ key: 'build', id: build.id, parent: null, name: 'Build', ownerRole: 'DEV-BE' }] });
      }
      return begin(fn, config);
    });
    const res = await call(asHead, 'update_task', { task: task.number, title: 'Checkout by card', stage: check.id });
    expect(raced).toBe(true);
    expect(res.isError, text(res)).toBe(true);
    expect(text(res)).toMatch(/took this stage off its pipeline meanwhile/);
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect([after!.title, after!.version, after!.pipelineStageId]).toEqual(['Checkout', task.version, build.id]);
  });

  it('let the product manager tidy only its own department, naming as responsible only the decision owner or a person on the goal', async () => {
    const { db, companyId, dev, sales, pia, salesHead, olegId, mariaId, ivanId, tools, work } = await company();
    const [goal] = await db.insert(goals).values({ companyId, number: 1, departmentId: dev.id, title: 'Shop', responsiblePersonId: ivanId }).returning();
    const { task } = await work();
    const pm = await tools(pia);
    const tidied = await call(pm, 'tidy_task', { task: task.number, title: 'Customers pay by card', why: 'Shops sell online.', goal: 1 });
    expect(tidied.isError, text(tidied)).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ title: 'Customers pay by card', why: 'Shops sell online.', goalId: goal!.id, status: 'open' });
    expect((await call(pm, 'tidy_task', { task: task.number, responsible: mariaId })).isError).toBe(true);
    expect((await call(pm, 'tidy_task', { task: task.number, responsible: olegId })).isError).toBeFalsy();
    expect((await call(pm, 'tidy_task', { task: task.number, responsible: ivanId })).isError).toBeFalsy();
    const { task: theirs } = await work(sales.id, salesHead.id, salesHead.id);
    expect((await call(pm, 'tidy_task', { task: theirs.number, title: 'Leads' })).isError).toBe(true);
    expect((await call(pm, 'set_pipeline', { department: sales.id, name: 'Deals', stages: [] })).isError).toBe(true);
    expect(await db.select().from(pipelines)).toEqual([]);
  });

  it("refuse a person's edit read before the product manager tidied the task, keeping what it tidied and the work's version", async () => {
    const { app, db, ceo, pia, tools, work } = await company();
    const { task } = await work();
    const read = (await app.inject({ url: `/api/tasks/${task.id}`, ...as(ceo) })).json().task as { version: number; revision: number };
    const tidied = await call(await tools(pia), 'tidy_task', { task: task.number, title: 'Customers pay by card' });
    expect(tidied.isError, text(tidied)).toBeFalsy();
    const stale = await app.inject({ method: 'PATCH', url: `/api/tasks/${task.id}`, payload: { title: 'Checkout by card', version: read.version, revision: read.revision }, ...as(ceo) });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.reason).toBe('task_changed');
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ title: 'Customers pay by card', version: task.version });
  });

  it('wake the product manager soon after a task of its department is made or changes status, once for many', async () => {
    const { db, pia, work } = await company();
    const hourAgo = new Date(Date.now() - 3_600_000);
    await db.update(agents).set({ timerMinutes: 240, timerOrder: 'Go over the tracker.', timerAt: hourAgo }).where(eq(agents.id, pia.id));
    await work();
    const [first] = await db.select({ at: agents.timerNudgedAt, last: agents.timerAt }).from(agents).where(eq(agents.id, pia.id));
    const dueIn = (at: Date) => at.getTime() - Date.now();
    expect(dueIn(first!.at!)).toBeGreaterThan(4 * 60_000);
    expect(dueIn(first!.at!)).toBeLessThanOrEqual(5 * 60_000);
    expect(first!.last).toEqual(hourAgo);
    await work();
    const [second] = await db.select({ at: agents.timerNudgedAt }).from(agents).where(eq(agents.id, pia.id));
    expect(second!.at!.getTime()).toBe(first!.at!.getTime());
  });
});
