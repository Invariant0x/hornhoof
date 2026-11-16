import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Spot } from '../../auth/access.js';
import { agents, departments, pipelines, pipelineStages, tasks } from '../../db/schema.js';
import { deptName } from '../departments/templates.js';
import { refuse, type Actor, type Task, type Tx } from '../tasks/engine.js';
import { spotOf } from './responsible.js';

export type Pipeline = typeof pipelines.$inferSelect;
type StageRow = typeof pipelineStages.$inferSelect;
/* A stage as it is written: key names it in the list, its id when it is there already; parent: the key of the stage above
   it, none for the first ones after the head. One owner: a role of the department, or one of its employees. */
export type StageInput = { key: string; id?: string; parent: string | null; name: string; ownerRole?: string; ownerAgentId?: string };
export type PipelineInput = { name: string; why: string; stages: StageInput[] };
/* Whoever writes may change pipelines of this department, or it throws. */
export type PipelineGuard = (spot: Spot) => Promise<void>;
type Live = Pick<Ctx, 'db' | 'bus' | 'templates'>;

export type StageView = { id: string; parentId: string | null; name: string; ownerRole: string | null; owner: { id: string; name: string } | null; position: number };
export type PipelineView = { id: string; department: { id: string; name: string }; name: string; why: string; archived: boolean; version: number; stages: StageView[] };

export const MAX_STAGES = 40;
const invalid = (message: string) => refuse(400, 'pipeline_invalid', message);

/* Stages depth first, each level by its position: the order a board's columns and a map read them in. */
export function inTreeOrder<S extends { id: string; parentStageId: string | null; position: number }>(stages: S[]): S[] {
  const under = (parent: string | null) => stages.filter(s => s.parentStageId === parent).sort((a, b) => a.position - b.position);
  const walk = (parent: string | null): S[] => under(parent).flatMap(s => [s, ...walk(s.id)]);
  return walk(null);
}

/* Parents first, so each stage is written after the one above it; a key that names no stage of the list, two stages with one
   key, and a loop are refused. */
function ordered(stages: StageInput[]): StageInput[] {
  const keys = new Set(stages.map(s => s.key));
  if (keys.size !== stages.length) throw invalid('Two stages have the same key.');
  if (stages.some(s => s.parent !== null && !keys.has(s.parent))) throw invalid('A stage names a stage above it that is not in the list.');
  const out: StageInput[] = [];
  const placed = new Set<string>();
  while (out.length < stages.length) {
    const next = stages.filter(s => !placed.has(s.key) && (s.parent === null || placed.has(s.parent)));
    if (!next.length) throw invalid('The stages go round in a circle: each stage needs a way back to the head.');
    for (const s of next) {
      out.push(s);
      placed.add(s.key);
    }
  }
  return out;
}

/* Each stage is owned by a role of the department's template or by one of its employees, never by one of another department. */
async function checkOwners(ctx: Pick<Ctx, 'db' | 'templates'>, dept: typeof departments.$inferSelect, stages: StageInput[]): Promise<void> {
  for (const s of stages) {
    if (Boolean(s.ownerRole) === Boolean(s.ownerAgentId)) throw invalid(`"${s.name}" needs one owner: a role or an employee.`);
    if (s.ownerRole && ctx.templates.roles.get(s.ownerRole)?.department !== dept.templateKey) throw invalid(`"${s.name}": ${s.ownerRole} is not a role of this department.`);
  }
  const ids = [...new Set(stages.flatMap(s => (s.ownerAgentId ? [s.ownerAgentId] : [])))];
  if (!ids.length) return;
  const units = (await ctx.db.select({ id: departments.id }).from(departments).where(eq(departments.parentId, dept.id))).map(d => d.id);
  const found = await ctx.db.select({ id: agents.id }).from(agents).where(and(inArray(agents.id, ids), inArray(agents.departmentId, [dept.id, ...units]), isNull(agents.removedAt)));
  if (found.length !== ids.length) throw invalid('A stage names an employee who does not work in this department.');
}

async function departmentOf(db: Live['db'], companyId: string, id: string) {
  const [dept] = await db.select().from(departments).where(and(eq(departments.id, id), eq(departments.companyId, companyId)));
  if (!dept) throw refuse(404, 'department_unknown', 'This department does not exist.');
  return dept;
}

function checkStages(input: Pick<PipelineInput, 'stages'>): StageInput[] {
  if (input.stages.length > MAX_STAGES) throw invalid(`A pipeline has at most ${MAX_STAGES} stages.`);
  return ordered(input.stages);
}

/* Writes the stages as listed: one that keeps its id stays with the tasks on it, a new one is added, and one left out goes,
   taking the tasks that stood on it back to not started. */
async function writeStages(tx: Tx, pipeline: Pipeline, stages: StageInput[]): Promise<void> {
  const kept = stages.flatMap(s => (s.id ? [s.id] : []));
  const there = await tx.select({ id: pipelineStages.id }).from(pipelineStages).where(eq(pipelineStages.pipelineId, pipeline.id));
  if (kept.some(id => !there.some(s => s.id === id))) throw invalid('A stage names an id that is not of this pipeline.');
  const gone = there.map(s => s.id).filter(id => !kept.includes(id));
  if (gone.length) await tx.update(tasks).set({ pipelineStageId: null, version: sql`${tasks.version} + 1`, updatedAt: new Date() }).where(inArray(tasks.pipelineStageId, gone));
  await tx.update(pipelineStages).set({ parentStageId: null }).where(eq(pipelineStages.pipelineId, pipeline.id));
  if (gone.length) await tx.delete(pipelineStages).where(inArray(pipelineStages.id, gone));
  const idOf = new Map<string, string>();
  const positions = new Map<string | null, number>();
  for (const s of stages) {
    const parentStageId = s.parent === null ? null : idOf.get(s.parent)!;
    const position = positions.get(parentStageId) ?? 0;
    positions.set(parentStageId, position + 1);
    const values = { parentStageId, name: s.name.trim(), ownerRole: s.ownerRole ?? null, ownerAgentId: s.ownerAgentId ?? null, position };
    const [row] = s.id
      ? await tx.update(pipelineStages).set(values).where(eq(pipelineStages.id, s.id)).returning()
      : await tx.insert(pipelineStages).values({ ...values, companyId: pipeline.companyId, pipelineId: pipeline.id }).returning();
    idOf.set(s.key, row!.id);
  }
}

const publish = (ctx: Live, companyId: string) => ctx.bus.publish(companyId, { type: 'tracker' });

export async function createPipeline(ctx: Live, companyId: string, actor: Actor, guard: PipelineGuard, departmentId: string, input: PipelineInput): Promise<Pipeline> {
  const dept = await departmentOf(ctx.db, companyId, departmentId);
  await guard(await spotOf(ctx.db, companyId, dept.id));
  const stages = checkStages(input);
  await checkOwners(ctx, dept, stages);
  const made = await ctx.db.transaction(async tx => {
    const [last] = await tx.select({ n: sql<number>`coalesce(max(${pipelines.position}), -1)` }).from(pipelines).where(eq(pipelines.departmentId, dept.id));
    const [row] = await tx.insert(pipelines).values({ companyId, departmentId: dept.id, name: input.name.trim(), why: input.why.trim(), position: Number(last?.n ?? -1) + 1, createdByPersonId: actor.personId ?? null, createdByAgentId: actor.agentId ?? null }).returning();
    await writeStages(tx, row!, stages);
    return row!;
  });
  publish(ctx, companyId);
  return made;
}

/* A change made only when the pipeline is still as its writer saw it. */
export async function editPipeline(ctx: Live, companyId: string, guard: PipelineGuard, id: string, change: Partial<PipelineInput> & { archived?: true }, version?: number): Promise<Pipeline> {
  const [before] = await ctx.db.select().from(pipelines).where(and(eq(pipelines.id, id), eq(pipelines.companyId, companyId)));
  if (!before) throw refuse(404, 'pipeline_unknown', 'There is no such pipeline.');
  const dept = await departmentOf(ctx.db, companyId, before.departmentId);
  await guard(await spotOf(ctx.db, companyId, dept.id));
  const stages = change.stages ? checkStages({ stages: change.stages }) : null;
  if (stages) await checkOwners(ctx, dept, stages);
  const row = await ctx.db.transaction(async tx => {
    const [current] = await tx.select().from(pipelines).where(eq(pipelines.id, id)).for('update');
    if (version !== undefined && current!.version !== version) throw refuse(409, 'pipeline_changed', 'Someone changed this pipeline meanwhile. Look at it again.');
    if (stages) await writeStages(tx, current!, stages);
    const [saved] = await tx.update(pipelines).set({
      ...(change.name !== undefined ? { name: change.name.trim() } : {}),
      ...(change.why !== undefined ? { why: change.why.trim() } : {}),
      ...(change.archived ? { archivedAt: current!.archivedAt ?? new Date() } : {}),
      version: sql`${pipelines.version} + 1`,
      updatedAt: new Date(),
    }).where(eq(pipelines.id, id)).returning();
    return saved!;
  });
  publish(ctx, companyId);
  return row;
}

/* The pipelines of the company, or of one department, with their stages in tree order. */
export async function pipelineViews(ctx: Pick<Ctx, 'db'>, companyId: string, departmentId?: string): Promise<PipelineView[]> {
  const rows = await ctx.db.select().from(pipelines).where(and(eq(pipelines.companyId, companyId), departmentId ? eq(pipelines.departmentId, departmentId) : undefined)).orderBy(asc(pipelines.position), asc(pipelines.createdAt));
  if (!rows.length) return [];
  const stages = await ctx.db.select().from(pipelineStages).where(inArray(pipelineStages.pipelineId, rows.map(p => p.id)));
  const agentIds = [...new Set(stages.flatMap(s => (s.ownerAgentId ? [s.ownerAgentId] : [])))];
  const named = new Map((agentIds.length ? await ctx.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : []).map(a => [a.id, a.name]));
  const depts = new Map((await ctx.db.select().from(departments).where(inArray(departments.id, [...new Set(rows.map(p => p.departmentId))]))).map(d => [d.id, { id: d.id, name: deptName(d) }]));
  return rows.map(p => ({
    id: p.id,
    department: depts.get(p.departmentId)!,
    name: p.name,
    why: p.why,
    archived: p.archivedAt !== null,
    version: p.version,
    stages: inTreeOrder(stages.filter(s => s.pipelineId === p.id)).map(s => ({
      id: s.id, parentId: s.parentStageId, name: s.name, ownerRole: s.ownerRole, owner: s.ownerAgentId ? { id: s.ownerAgentId, name: named.get(s.ownerAgentId) ?? '' } : null, position: s.position,
    })),
  }));
}

/* The first stage, in tree order, that this employee holds: as its owner, or by its role. None: no stage is theirs. */
export async function stageFor(db: Tx | Live['db'], pipelineId: string, holderId: string): Promise<string | null> {
  const [holder] = await db.select({ id: agents.id, roleKey: agents.roleKey }).from(agents).where(eq(agents.id, holderId));
  if (!holder) return null;
  const stages = inTreeOrder(await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipelineId)));
  return stages.find(s => s.ownerAgentId === holder.id || (s.ownerRole !== null && s.ownerRole === holder.roleKey))?.id ?? null;
}

/* A task on a pipeline follows whoever holds it: when its holder changes and nobody set its stage, it goes to the first stage
   of the new holder, and stays where it was when none is theirs. */
export async function followedStage(tx: Tx, task: Pick<Task, 'pipelineId' | 'assigneeAgentId'>, set: Partial<Task>): Promise<Partial<Task>> {
  if (!task.pipelineId || set.pipelineStageId !== undefined || !set.assigneeAgentId || set.assigneeAgentId === task.assigneeAgentId) return {};
  const stage = await stageFor(tx, task.pipelineId, set.assigneeAgentId);
  return stage ? { pipelineStageId: stage } : {};
}

/* A pipeline a task of this department may join, and the stage it starts on: the one named, which must be the pipeline's,
   else the first one of whoever holds the task. */
export async function placeOnPipeline(db: Live['db'], companyId: string, spot: Spot, holderId: string | null, pipelineId: string, stageId?: string | null): Promise<{ pipelineId: string; pipelineStageId: string | null }> {
  const [pipeline] = await db.select().from(pipelines).where(and(eq(pipelines.id, pipelineId), eq(pipelines.companyId, companyId)));
  if (!pipeline || pipeline.archivedAt) throw invalid('There is no such pipeline in use.');
  if (pipeline.departmentId !== spot.departmentId && pipeline.departmentId !== spot.parentId) throw invalid('A task joins a pipeline of its own department.');
  if (stageId) {
    const [stage] = await db.select({ id: pipelineStages.id }).from(pipelineStages).where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)));
    if (!stage) throw invalid('This stage is not of the pipeline.');
    return { pipelineId, pipelineStageId: stage.id };
  }
  return { pipelineId, pipelineStageId: stageId === null || !holderId ? null : await stageFor(db, pipelineId, holderId) };
}

