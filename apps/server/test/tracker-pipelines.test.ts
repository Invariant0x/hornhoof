import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, subscriptions, tasks } from '../src/db/schema.js';
import { createTask, move } from '../src/modules/tasks/engine.js';
import { as, echelonsTurn, invitePerson, setUpCompany, testApp } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [dev, sales] = await db.insert(departments).values([
    { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
    { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
  ]).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const tess = await hire('Tess', 'worker', 'DEV-TEST');
  const sam = await hire('Sam', 'worker', 'SAL-AE', sales!.id);
  const oleg = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id] } });
  const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
  await echelonsTurn(db, companyId);
  const send = (method: 'POST' | 'PATCH', token: string, url: string, payload: object = {}) => app.inject({ method, url, payload, ...as(token) });
  const get = (token: string, url: string) => app.inject({ url, ...as(token) });
  return { app, db, ctx: app.ctx, companyId, ceo, oleg, maria, dev: dev!, sales: sales!, head, bruno, tess, sam, send, get };
}

/* A tree with a fork: the plan, then building and the docs at once, testing after the build. */
const RELEASES = {
  name: 'Releases',
  why: 'How a change reaches people.',
  stages: [
    { key: 'plan', parent: null, name: 'Plan', ownerRole: 'DEV-ARCH' },
    { key: 'build', parent: 'plan', name: 'Build', ownerRole: 'DEV-BE' },
    { key: 'docs', parent: 'plan', name: 'Docs', ownerRole: 'DEV-DOCS' },
    { key: 'test', parent: 'build', name: 'Test', ownerRole: 'DEV-TEST' },
  ],
};

type Stage = { id: string; parentId: string | null; name: string; ownerRole: string | null };

describe('pipelines', () => {
  it('keeps a tree of stages with forks, read back in tree order', async () => {
    const { oleg, dev, send, get } = await company();
    const made = await send('POST', oleg, '/api/pipelines', { ...RELEASES, department: dev.id });
    expect(made.statusCode, made.body).toBe(201);
    const [pipeline] = (await get(oleg, `/api/pipelines?department=${dev.id}`)).json().pipelines;
    expect(pipeline).toMatchObject({ name: 'Releases', why: 'How a change reaches people.', department: { id: dev.id }, archived: false });
    const stages = pipeline.stages as Stage[];
    expect(stages.map(s => s.name)).toEqual(['Plan', 'Build', 'Test', 'Docs']);
    const byName = new Map(stages.map(s => [s.name, s]));
    expect(stages.map(s => (s.parentId ? stages.find(p => p.id === s.parentId)!.name : null))).toEqual([null, 'Plan', 'Build', 'Plan']);
    expect(byName.get('Build')!.ownerRole).toBe('DEV-BE');
  });

  it('refuses a stage owned by another department, a loop and a person without the department', async () => {
    const { oleg, maria, dev, send } = await company();
    const other = await send('POST', oleg, '/api/pipelines', { ...RELEASES, department: dev.id, stages: [{ key: 'a', parent: null, name: 'Sell', ownerRole: 'SAL-AE' }] });
    expect([other.statusCode, other.json().error.reason]).toEqual([400, 'pipeline_invalid']);
    const loop = await send('POST', oleg, '/api/pipelines', { ...RELEASES, department: dev.id, stages: [{ key: 'a', parent: 'b', name: 'A', ownerRole: 'DEV-BE' }, { key: 'b', parent: 'a', name: 'B', ownerRole: 'DEV-BE' }] });
    expect([loop.statusCode, loop.json().error.reason]).toEqual([400, 'pipeline_invalid']);
    const stranger = await send('POST', maria, '/api/pipelines', { ...RELEASES, department: dev.id });
    expect([stranger.statusCode, stranger.json().error.reason]).toEqual([403, 'not_your_department']);
  });

  it('moves a task to the stage of whoever holds it, and keeps it where it was for a holder of no stage', async () => {
    const { ctx, db, oleg, dev, head, bruno, tess, sam, send } = await company();
    const pipeline = (await send('POST', oleg, '/api/pipelines', { ...RELEASES, department: dev.id })).json().pipeline;
    const stage = (name: string) => (pipeline.stages as Stage[]).find(s => s.name === name)!.id;
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true, resultKind: 'code', pipelineId: pipeline.id });
    expect(task.pipelineStageId).toBe(stage('Build'));
    const tested = await move(ctx, task, { assigneeAgentId: tess.id }, { kind: 'assigned', actor: { agentId: head.id } });
    expect(tested.pipelineStageId).toBe(stage('Test'));
    const checked = await move(ctx, tested, { assigneeAgentId: sam.id }, { kind: 'assigned', actor: { agentId: head.id } });
    expect(checked.pipelineStageId).toBe(stage('Test'));
    expect((await db.select({ stage: tasks.pipelineStageId }).from(tasks).where(eq(tasks.id, task.id)))[0]!.stage).toBe(stage('Test'));
  });

  it('takes tasks off a stage an edit removes, back to not started, and archives a pipeline', async () => {
    const { ctx, db, oleg, dev, head, tess, send, get } = await company();
    const pipeline = (await send('POST', oleg, '/api/pipelines', { ...RELEASES, department: dev.id })).json().pipeline;
    const stages = pipeline.stages as Stage[];
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev.id, assigneeAgentId: tess.id, executor: true, resultKind: 'code', pipelineId: pipeline.id });
    expect(task.pipelineStageId).toBe(stages.find(s => s.name === 'Test')!.id);

    const kept = stages.filter(s => s.name !== 'Test').map(s => ({ key: s.id, id: s.id, parent: s.parentId, name: s.name, ownerRole: s.ownerRole }));
    const edited = await send('PATCH', oleg, `/api/pipelines/${pipeline.id}`, { stages: [...kept, { key: 'ship', parent: stages.find(s => s.name === 'Build')!.id, name: 'Ship', ownerRole: 'DEV-OPS' }], version: pipeline.version });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((edited.json().pipeline.stages as Stage[]).map(s => s.name)).toEqual(['Plan', 'Build', 'Ship', 'Docs']);
    expect((edited.json().pipeline.stages as Stage[]).find(s => s.name === 'Build')!.id).toBe(stages.find(s => s.name === 'Build')!.id);
    const [now] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect([now!.pipelineId, now!.pipelineStageId]).toEqual([pipeline.id, null]);

    const stale = await send('PATCH', oleg, `/api/pipelines/${pipeline.id}`, { name: 'Again', version: pipeline.version });
    expect([stale.statusCode, stale.json().error.reason]).toEqual([409, 'pipeline_changed']);
    expect((await send('POST', oleg, `/api/pipelines/${pipeline.id}/archive`)).statusCode).toBe(200);
    expect((await get(oleg, `/api/pipelines?department=${dev.id}`)).json().pipelines[0].archived).toBe(true);
  });
});
