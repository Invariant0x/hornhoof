import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, companies, departments, people, subscriptions, tasks } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { giveTasks } from '../src/modules/tasks/turns.js';
import { as, echelonsTurn, invitePerson, setUpCompany, testApp } from './helpers.js';
import { freshPglite } from './helpers-db.js';
import { migrationsBefore, migrationsThrough } from './migrations-before.js';

/* "Asked by" is the person whose request started a tree, inherited down that tree and empty for work agents started themselves;
   "decides" is the responsible person of the chain tasks always had. A person's list of what is theirs holds what they asked
   for and what waits for their decision, not everything they would decide. */

async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev] = await db.insert(departments).values([{ companyId, templateKey: 'development', roleCode: 'DEV', position: 1 }]).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id] } });
  const id = async (email: string) => (await db.select({ id: people.id }).from(people).where(eq(people.email, email)))[0]!.id;
  await echelonsTurn(db, companyId);
  const work = (actor: { agentId: string }, input: Partial<Parameters<typeof createTask>[2]> = {}) =>
    createTask(app.ctx, actor, { title: 'Checkout', brief: 'Pay by card.', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, resultKind: 'code', ...input });
  return { app, db, ctx: app.ctx, ceo, companyId, dev: dev!, orchestrator: orchestrator!, head, bruno, work, ivanId: await id('ivan@acme.com'), olegId: await id('oleg@acme.com') };
}

const askedBy = async (db: Awaited<ReturnType<typeof company>>['db'], taskId: string) => (await db.select({ a: tasks.askedByPersonId }).from(tasks).where(eq(tasks.id, taskId)))[0]!.a;

describe('"asked by" and "decides"', () => {
  it('records the person who made a task by their own request, and keeps "decides" as it was', async () => {
    const { app, ceo, db, dev, ivanId, olegId } = await company();
    const res = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Checkout', brief: 'Pay by card.', body: '', department: dev.id }, ...as(ceo) });
    expect(res.statusCode).toBe(201);
    const task = res.json().task;
    expect(task.askedBy).toEqual({ id: ivanId, name: 'Ivan' });
    /* The department's decisions are the one person's whose access lists it: they decide, the CEO asked. */
    expect(task.responsible).toMatchObject({ id: olegId });
    expect(await askedBy(db, task.id)).toBe(ivanId);
  });

  it('hands it down the tree: work under a task is asked for by whoever asked for the task', async () => {
    const { app, ceo, db, dev, ivanId, head, work } = await company();
    const res = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Checkout', brief: 'Pay by card.', body: '', department: dev.id }, ...as(ceo) });
    const top = res.json().task;
    const { task: child } = await work({ agentId: head.id }, { parentId: top.id, title: 'Card form' });
    const { task: grandchild } = await work({ agentId: head.id }, { parentId: child.id, title: 'Card number field' });
    expect(await askedBy(db, child.id)).toBe(ivanId);
    expect(await askedBy(db, grandchild.id)).toBe(ivanId);
  });

  it('leaves it empty for work that agents started themselves, though somebody decides it', async () => {
    const { db, head, work, olegId } = await company();
    const { task } = await work({ agentId: head.id });
    expect(await askedBy(db, task.id)).toBeNull();
    expect((await db.select({ r: tasks.responsiblePersonId }).from(tasks).where(eq(tasks.id, task.id)))[0]!.r).toBe(olegId);
  });

  it('lets the orchestrator name the person whose request it carries out, and no one else', async () => {
    const { ctx, db, orchestrator, head, work, olegId, ivanId, dev, companyId } = await company();
    await giveTasks(ctx, { companyId, agentId: orchestrator.id, jobId: crypto.randomUUID() }, [{ department: dev.id, title: 'Refunds', brief: 'Give money back.', body: '', askedByPersonId: olegId }]);
    const [given] = await db.select().from(tasks).where(eq(tasks.title, 'Refunds'));
    expect(given!.askedByPersonId).toBe(olegId);
    await expect(work({ agentId: head.id }, { askedByPersonId: ivanId })).rejects.toMatchObject({ status: 403 });
    /* A person names only themselves; the orchestrator, any active person of the company. */
    const own = { title: 'Mine', brief: 'x', body: '', departmentId: dev.id, assigneeAgentId: head.id, executor: false, resultKind: 'coordination' as const };
    await expect(createTask(ctx, { personId: olegId }, { ...own, askedByPersonId: ivanId })).rejects.toMatchObject({ status: 403 });
    expect((await createTask(ctx, { personId: olegId }, { ...own, askedByPersonId: olegId })).task.askedByPersonId).toBe(olegId);
    expect((await createTask(ctx, { agentId: orchestrator.id }, { ...own, title: 'Named by the orchestrator', askedByPersonId: ivanId })).task.askedByPersonId).toBe(ivanId);
    await expect(giveTasks(ctx, { companyId, agentId: orchestrator.id, jobId: crypto.randomUUID() }, [{ department: dev.id, title: 'Ghost request', brief: 'x', body: '', askedByPersonId: '00000000-0000-4000-8000-000000000000' }])).rejects.toMatchObject({ status: 400 });
  });

  it('shows both on the task as people read it, and in the list', async () => {
    const { app, ceo, dev, ivanId, olegId, ctx, orchestrator, companyId } = await company();
    await giveTasks(ctx, { companyId, agentId: orchestrator.id, jobId: crypto.randomUUID() }, [{ department: dev.id, title: 'Refunds', brief: 'Give money back.', body: '', askedByPersonId: ivanId }]);
    const list = (await app.inject({ url: '/api/tasks?status=all', ...as(ceo) })).json().tasks as { title: string; askedBy: unknown; responsible: unknown }[];
    expect(list.find(t => t.title === 'Refunds')).toMatchObject({ askedBy: { id: ivanId, name: 'Ivan' }, responsible: { id: olegId } });
  });
});

describe('the backfill', () => {
  /* Only a request on record is taken: a task a person made, and the work under it. Nothing else is guessed. */
  it('sets "asked by" on the tasks people made and the work under them, and on nothing else', async () => {
    const client = await freshPglite();
    onTestFinished(() => client.close());
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: await migrationsBefore('task_asked_by') });
    const company = (await db.execute<{ id: string }>(sql`insert into companies (name) values ('Acme') returning id`)).rows[0]!.id;
    const person = (await db.execute<{ id: string }>(sql`insert into people (company_id, name, email, status, scope_kind, is_owner) values (${company}, 'Dana', 'dana@acme.example', 'active', 'company', true) returning id`)).rows[0]!.id;
    const task = async (number: number, parent: string | null, byPerson: string | null) =>
      (await db.execute<{ id: string }>(sql`insert into tasks (company_id, number, title, parent_id, created_by_person_id) values (${company}, ${number}, ${`Task ${number}`}, ${parent}, ${byPerson}) returning id`)).rows[0]!.id;
    const asked = await task(1, null, person);
    const under = await task(2, asked, null);
    await task(3, under, null);
    const agentOnly = await task(4, null, null);
    await task(5, agentOnly, null);

    await migrate(db, { migrationsFolder: await migrationsThrough('task_asked_by') });

    const rows = (await db.execute<{ number: number; asked: string | null }>(sql`select number, asked_by_person_id as asked from tasks order by number`)).rows;
    expect(rows).toEqual([{ number: 1, asked: person }, { number: 2, asked: person }, { number: 3, asked: person }, { number: 4, asked: null }, { number: 5, asked: null }]);
  });
});
