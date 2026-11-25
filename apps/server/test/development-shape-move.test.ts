import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, pipelines, pipelineStages, tasks, teams } from '../src/db/schema.js';
import { moveDevelopmentToBatchShape } from '../src/modules/tracker/development-shape.js';
import { writeStages } from '../src/modules/tracker/pipelines.js';
import { SETUP, testApp } from './helpers.js';

/* The move of a Development department made before the shape of 24.11 (#2074), for the adapter to call. It moves what the
   template made and nobody changed, lists what a person changed by hand, hires and removes no one, moves no task, and run
   again finds nothing to move. */

const OLD_STAGES = [
  ['Plan the change', 'DEV-ARCH'], ['Build the change', 'DEV-ENG'], ['Review the change', 'DEV-REV'],
  ['Tidy the change', 'DEV-ENG'], ['Check security', 'DEV-SEC'], ['Run tests', 'DEV-TEST'],
] as const;

/* A department as the template left it before: the code pipeline a chain, a turnkey team of two, no slots. */
async function oldDepartment() {
  const { app, db } = await testApp();
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'later' }, template: 'project' } });
  expect(res.statusCode).toBe(201);
  const [dev] = await db.select().from(departments).where(eq(departments.templateKey, 'development'));
  const [code] = await db.select().from(pipelines).where(and(eq(pipelines.departmentId, dev!.id), eq(pipelines.catalogKey, 'development-changes')));
  const stages = await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, code!.id));
  const idOf = new Map(stages.map(s => [s.name, s.id]));
  await db.transaction(tx => writeStages(tx, code!, OLD_STAGES.map(([name, ownerRole], i) => ({ key: String(i), id: idOf.get(name)!, parent: i ? String(i - 1) : null, name, ownerRole }))));
  const [team] = await db.select().from(teams).where(eq(teams.departmentId, dev!.id));
  await db.update(teams).set({ name: 'Turnkey team', about: 'Each member owns the work and its checks from start to finish.', turnkey: true, urgentOnly: false }).where(eq(teams.id, team!.id));
  await db.update(departments).set({ slotCap: null }).where(eq(departments.id, dev!.id));
  const move = () => db.transaction(tx => moveDevelopmentToBatchShape(tx, app.ctx.templates, dev!.id));
  const stagesNow = async () => (await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, code!.id)));
  return { app, db, dev: dev!, code: code!, team: team!, idOf, move, stagesNow };
}

describe('the move of an existing Development department to the batch shape', () => {
  it('makes the code pipeline a tree that keeps every stage it had, the turnkey team the Hotfix unit, and gives five slots', async () => {
    const { db, dev, code, team, idOf, move, stagesNow } = await oldDepartment();
    const result = await move();
    expect(result.review).toEqual([]);
    expect(result.moved).toHaveLength(3);
    const stages = await stagesNow();
    const byName = new Map(stages.map(s => [s.name, s]));
    for (const [name, id] of idOf) if (name !== 'Release the turn') expect(byName.get(name)!.id, name).toBe(id);
    expect(byName.get('Build the change')!.parentStageId).toBeNull();
    expect(byName.get('Plan the change')!.parentStageId).toBe(byName.get('Build the change')!.id);
    expect(byName.get('Review the change')!.parentStageId).toBe(byName.get('Build the change')!.id);
    expect(byName.get('Check security')!.parentStageId).toBe(byName.get('Tidy the change')!.id);
    expect(byName.get('Run tests')!.parentStageId).toBe(byName.get('Check security')!.id);
    expect(byName.get('Release the turn')).toMatchObject({ parentStageId: byName.get('Run tests')!.id, ownerRole: 'DEV-OPS' });
    expect((await db.select().from(pipelines).where(eq(pipelines.id, code.id)))[0]!.version).toBe(code.version + 1);
    expect((await db.select().from(teams).where(eq(teams.id, team.id)))[0]).toMatchObject({ name: 'Hotfix', turnkey: false, urgentOnly: true });
    expect((await db.select().from(departments).where(eq(departments.id, dev.id)))[0]!.slotCap).toBe(5);
  });

  it('moves no task and no person: a task on a stage stays on it, and a team of two keeps both, which it lists', async () => {
    const { db, dev, team, idOf, move } = await oldDepartment();
    const [member] = await db.select().from(agents).where(and(eq(agents.departmentId, dev.id), eq(agents.teamId, team.id)));
    await db.insert(agents).values({ ...member!, id: crypto.randomUUID(), name: 'Developer 2 (Hotfix)', teamId: team.id });
    const [task] = await db.insert(tasks).values({ companyId: dev.companyId, number: 9001, title: 'On the plan', departmentId: dev.id, pipelineStageId: idOf.get('Plan the change')! }).returning();
    const before = (await db.select().from(agents).where(eq(agents.teamId, team.id))).length;
    const result = await move();
    expect((await db.select().from(tasks).where(eq(tasks.id, task!.id)))[0]!.pipelineStageId).toBe(idOf.get('Plan the change'));
    expect(await db.select().from(agents).where(eq(agents.teamId, team.id))).toHaveLength(before);
    expect(result.review).toEqual([expect.stringMatching(/Hotfix unit has 2 people and the template brings 1: nobody was removed/)]);
  });

  it('finds nothing to move when it runs again', async () => {
    const { move } = await oldDepartment();
    await move();
    expect(await move()).toMatchObject({ moved: [], review: [] });
  });

  it('keeps what a person changed by hand and lists it for review', async () => {
    const { db, dev, team, code, move, stagesNow } = await oldDepartment();
    await db.update(pipelineStages).set({ name: 'Look it over' }).where(and(eq(pipelineStages.pipelineId, code.id), eq(pipelineStages.name, 'Review the change')));
    await db.update(teams).set({ name: 'Our fixers' }).where(eq(teams.id, team.id));
    await db.update(departments).set({ slotCap: 3 }).where(eq(departments.id, dev.id));
    const before = (await stagesNow()).map(s => [s.name, s.parentStageId]);
    const result = await move();
    expect(result.moved).toEqual([]);
    expect(result.review).toEqual([
      expect.stringMatching(/pipeline "Software changes" was changed by hand, so it stays as it is. The template's tree: Build the change, Plan the change \(after Build the change\)/),
      expect.stringMatching(/team "Our fixers" is still turnkey[\s\S]*changed by hand/),
      expect.stringMatching(/no Hotfix unit/),
      expect.stringMatching(/runs 3 slots, set by hand; the template gives 5/),
    ]);
    expect((await stagesNow()).map(s => [s.name, s.parentStageId])).toEqual(before);
    expect((await db.select().from(teams).where(eq(teams.id, team.id)))[0]).toMatchObject({ name: 'Our fixers', turnkey: true });
    expect((await db.select().from(departments).where(eq(departments.id, dev.id)))[0]!.slotCap).toBe(3);
  });

  it('leaves a department of another template, and a sub-unit, alone', async () => {
    const { app, db, dev } = await oldDepartment();
    const [sub] = await db.insert(departments).values({ companyId: dev.companyId, parentId: dev.id, templateKey: 'development', roleCode: 'DEV', position: 9 }).returning();
    const [ops] = await db.select().from(departments).where(eq(departments.templateKey, 'operations'));
    for (const id of [sub!.id, ops!.id]) expect(await db.transaction(tx => moveDevelopmentToBatchShape(tx, app.ctx.templates, id))).toEqual({ departmentId: id, moved: [], review: [] });
  });
});
