import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agents, companies, departments, people, pipelineStages, subscriptions, tasks } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { editTask, seenOf } from '../src/modules/tracker/edit.js';
import { createPipeline, editPipeline } from '../src/modules/tracker/pipelines.js';
import { echelonsTurn, invitePerson, ownPlan, setUpCompany, testApp } from './helpers.js';

/* Development with a pipeline from Build, which the developer holds, to Check, which the head holds. */
async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', position: 1 }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id] } });
  await ownPlan(db, 'oleg@acme.com', bruno.id);
  await echelonsTurn(db, companyId);
  const [oleg] = await db.select({ id: people.id }).from(people).where(eq(people.email, 'oleg@acme.com'));
  const anyone = async () => {};
  const pipe = await createPipeline(app.ctx, companyId, { agentId: head.id }, anyone, dev!.id, { name: 'Releases', why: '', stages: [
    { key: 'build', parent: null, name: 'Build', ownerRole: 'DEV-BE' },
    { key: 'check', parent: 'build', name: 'Check', ownerRole: 'DEV-HEAD' },
  ] });
  const named = new Map((await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipe.id))).map(s => [s.name, s]));
  const [build, check] = [named.get('Build'), named.get('Check')];
  const stages = async () => (await db.select({ id: pipelineStages.id }).from(pipelineStages)).map(s => s.id);
  /* Someone else takes Check off the pipeline, and that change is in. */
  const dropCheck = () => editPipeline(app.ctx, companyId, anyone, pipe.id, { stages: [{ key: 'build', id: build!.id, parent: null, name: 'Build', ownerRole: 'DEV-BE' }] });
  const work = (over: { pipelineStageId?: string } = {}) =>
    createTask(app.ctx, { agentId: head.id }, { title: 'Checkout', brief: 'Pay by card.', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, resultKind: 'coordination', pipelineId: pipe.id, ...over });
  return { app, db, ctx: app.ctx, companyId, dev: dev!, head, bruno, olegId: oleg!.id, pipe, build: build!, check: check!, stages, dropCheck, work };
}

/* The competing change lands after the request checked what it names and before it writes: right before its first
   transaction, as two requests at once would meet. */
function meanwhile(db: Db, change: () => Promise<unknown>): void {
  const begin = db.transaction.bind(db);
  vi.spyOn(db, 'transaction').mockImplementationOnce(async (fn, config) => {
    await change();
    return begin(fn, config);
  });
}

describe('a stage taken off its pipeline while a task is put on it', () => {
  it('refuses the edit that puts the task there as a conflict, and the task stays where it was', async () => {
    const { db, ctx, olegId, build, check, stages, dropCheck, work } = await company();
    const { task } = await work();
    expect(task.pipelineStageId).toBe(build.id);
    meanwhile(db, dropCheck);
    await expect(editTask(ctx, { personId: olegId }, task, { pipelineStageId: check.id }, seenOf(task))).rejects.toMatchObject({ status: 409, reason: 'stage_gone' });
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect([row!.pipelineStageId, row!.version, row!.trackerRevision]).toEqual([build.id, task.version, task.trackerRevision]);
    expect(await stages()).toEqual([build.id]);
  });

  it('refuses a new task on that stage as a conflict and makes none', async () => {
    const { db, check, build, stages, dropCheck, work } = await company();
    meanwhile(db, dropCheck);
    await expect(work({ pipelineStageId: check.id })).rejects.toMatchObject({ status: 409, reason: 'stage_gone' });
    expect(await db.select().from(tasks)).toEqual([]);
    expect(await stages()).toEqual([build.id]);
  });
});
