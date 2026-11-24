import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, subscriptions, tasks, turns } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { loadQueue, slotsApply } from '../src/modules/tasks/slots.js';
import { giveTasks, type PlanItem } from '../src/modules/tasks/turns.js';
import { as, echelonsTurn, setUpCompany, testApp } from './helpers.js';

/* A development department runs its turn in slots, one per developer, five at most. A new task that finds every slot busy
   waits in the queue for the next turn and says which; a small addition may join a running slot; urgent work goes past both. */

async function company(developers: number, slotCap: number | null = 5) {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev] = await db.insert(departments).values([{ companyId, templateKey: 'development', roleCode: 'DEV', position: 1, slotCap }]).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  for (let i = 1; i <= developers; i++) await hire(`Dev${i}`, 'worker', 'DEV-BE');
  const turn = await echelonsTurn(db, companyId);
  const by = () => ({ companyId, agentId: orchestrator!.id, jobId: crypto.randomUUID() });
  const give = (...items: Partial<PlanItem>[]) => giveTasks(app.ctx, by(), items.map((i, n) => ({ department: dev!.id, title: `Task ${n}`, brief: 'x', body: '', ...i })));
  const row = async (title: string) => (await db.select().from(tasks).where(eq(tasks.title, title)))[0]!;
  return { app, db, ceo, companyId, dev: dev!, head, turn, give, row, orchestrator: orchestrator! };
}

describe('turn slots', () => {
  it('gives a slot to each developer and queues the next task for the next turn, with no one woken for it', async () => {
    const { give, row, head } = await company(2);
    const first = await give({ title: 'A' }, { title: 'B' });
    expect(first.wakes.map(w => w.agentId)).toEqual([head.id, head.id]);
    const third = await give({ title: 'C' });
    expect(third.wakes).toEqual([]);
    expect(third.text).toContain('#3 waits for the next turn');
    expect(await row('A')).toMatchObject({ assigneeAgentId: head.id, queuedAt: null });
    expect(await row('C')).toMatchObject({ assigneeAgentId: null, status: 'open' });
    expect((await row('C')).queuedAt).toBeInstanceOf(Date);
  });

  it('stops at five slots however many developers there are', async () => {
    const { give, row } = await company(6);
    await give(...Array.from({ length: 6 }, (_, i) => ({ title: `T${i + 1}` })));
    expect((await row('T5')).queuedAt).toBeNull();
    expect((await row('T6')).queuedAt).not.toBeNull();
  });

  it('runs the work of a department that sets no slots as it always did', async () => {
    const { give, row } = await company(1, null);
    await give({ title: 'A' }, { title: 'B' }, { title: 'C' });
    expect((await row('C')).queuedAt).toBeNull();
  });

  it('lets one small addition of the same product join a running slot, and queues the next', async () => {
    const { give, row } = await company(1);
    await give({ title: 'Big' });
    await give({ title: 'Small 1', small: true });
    await give({ title: 'Small 2', small: true });
    expect((await row('Small 1')).queuedAt).toBeNull();
    expect((await row('Small 2')).queuedAt).not.toBeNull();
  });

  it('takes no slot for urgent work, which goes past the queue', async () => {
    const { give, row, head } = await company(1);
    await give({ title: 'A' });
    const urgent = await give({ title: 'Hotfix', urgent: true });
    expect(urgent.wakes.map(w => w.agentId)).toEqual([head.id]);
    expect(await row('Hotfix')).toMatchObject({ assigneeAgentId: head.id, queuedAt: null, urgent: true });
    await give({ title: 'B' });
    expect((await row('B')).queuedAt).not.toBeNull();
  });

  it('says in the task which turn it waits for: the next one, then the one after, in batches of the slots', async () => {
    const { give, app, ceo, turn } = await company(1);
    await give({ title: 'A' });
    await give({ title: 'B' });
    await give({ title: 'C' });
    const list = (await app.inject({ url: '/api/tasks?status=open', ...as(ceo) })).json().tasks as { title: string; queue: unknown }[];
    expect(list.find(t => t.title === 'A')!.queue).toBeNull();
    expect(list.find(t => t.title === 'B')!.queue).toEqual({ ahead: 1, position: 1, openTurn: turn.number });
    expect(list.find(t => t.title === 'C')!.queue).toEqual({ ahead: 2, position: 2, openTurn: turn.number });
  });

  it('queues the task of a person too, who is told so', async () => {
    const { give, app, ceo, dev } = await company(1);
    await give({ title: 'A' });
    const res = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'From a person', brief: 'x', body: '', department: dev.id }, ...as(ceo) });
    expect(res.statusCode).toBe(201);
    expect(res.json().task).toMatchObject({ assignee: null, queue: { ahead: 1, position: 1 } });
  });

  it('loads the queue into the turn that opens: in order, as many as the slots take, each woken at its head', async () => {
    const { give, row, db, head, companyId, dev } = await company(2);
    await give({ title: 'A' }, { title: 'B' });
    await give({ title: 'C' }, { title: 'D' }, { title: 'E' });
    await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.title, 'A'));
    await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.title, 'B'));
    const given = await db.transaction(tx => loadQueue(tx, companyId, dev.id));
    expect(given.map(g => g.task.title)).toEqual(['C', 'D']);
    expect(given.map(g => g.wake)).toEqual([{ agentId: head.id, taskId: given[0]!.task.id, why: 'assigned' }, { agentId: head.id, taskId: given[1]!.task.id, why: 'assigned' }]);
    expect(await row('C')).toMatchObject({ assigneeAgentId: head.id, queuedAt: null });
    expect((await row('E')).queuedAt).not.toBeNull();
  });

  it('keeps a task that waited for a named holder with that holder, not with the head', async () => {
    const { db, app, row, give, companyId, dev, head } = await company(1);
    await give({ title: 'A' });
    const [bruno] = await db.select().from(agents).where(eq(agents.name, 'Dev1'));
    await createTask(app.ctx, { agentId: head.id }, { title: 'Named', brief: 'x', body: '', departmentId: dev.id, assigneeAgentId: bruno!.id, executor: true, resultKind: 'code', useSlots: true });
    expect((await row('Named')).queuedAt).not.toBeNull();
    await db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.title, 'A'));
    await db.transaction(tx => loadQueue(tx, companyId, dev.id));
    expect(await row('Named')).toMatchObject({ assigneeAgentId: bruno!.id, queuedAt: null });
  });

  it('does not hand the unstarted work of a busy developer to another developer in a department that runs slots', async () => {
    const { db, dev, companyId } = await company(2);
    const [task] = await db.insert(tasks).values({ companyId, number: 1, title: 'x', departmentId: dev.id }).returning();
    expect(await slotsApply(db, task!)).toBe(true);
    await db.update(departments).set({ slotCap: null }).where(eq(departments.id, dev.id));
    expect(await slotsApply(db, task!)).toBe(false);
    expect((await db.select().from(turns))[0]!.departmentId).toBe(dev.id);
  });
});
