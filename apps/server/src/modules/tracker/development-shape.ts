import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { agents, departments, pipelines, pipelineStages, teams } from '../../db/schema.js';
import type { CatalogPipeline, TeamTemplate, Templates } from '../templates/load.js';
import { DEFAULT_SLOT_CAP } from '../tasks/slots.js';
import type { Tx } from '../tasks/state.js';
import { catalogStages, writeStages } from './pipelines.js';

/* The move of a Development department made before the shape of 24.11 (#2074) to that shape: the code pipeline as a tree, the
   turnkey team as the Hotfix unit that takes urgent work only, and five slots. It is a function of its own: the update of
   the adapter (#2059) calls it for each Development department inside the transaction of that update.

   It moves what the template made and nobody changed, and keeps whatever a person changed by hand, which it lists for
   review instead. It hires and removes no one, and moves no task: a stage keeps its id, so its tasks stay on it. Run again
   it finds nothing to move. */

export type ShapeMove = { departmentId: string; moved: string[]; review: string[] };

/* The code pipeline as the template made it before: a chain from planning to the tests, each stage owned by its role. */
const OLD_CODE_PIPELINE = [
  ['Plan the change', 'DEV-ARCH'], ['Build the change', 'DEV-ENG'], ['Review the change', 'DEV-REV'],
  ['Tidy the change', 'DEV-ENG'], ['Check security', 'DEV-SEC'], ['Run tests', 'DEV-TEST'],
] as const;
const CODE_KEY = 'development-changes';
/* The team as the template made it before: a turnkey team of two developers, named for what it was. */
const OLD_TEAM = { name: 'Turnkey team', about: 'Each member owns the work and its checks from start to finish.' };

type Stage = typeof pipelineStages.$inferSelect;

const chain = (stages: Stage[]): [string, string | null][] => {
  const byParent = new Map(stages.map(s => [s.parentStageId, s]));
  const out: [string, string | null][] = [];
  for (let at = byParent.get(null); at; at = byParent.get(at.id)) out.push([at.name, at.ownerAgentId ? null : at.ownerRole]);
  return out;
};
const isOldChain = (stages: Stage[]): boolean => {
  const found = chain(stages);
  return stages.length === OLD_CODE_PIPELINE.length && found.length === OLD_CODE_PIPELINE.length && found.every(([name, role], i) => name === OLD_CODE_PIPELINE[i]![0] && role === OLD_CODE_PIPELINE[i]![1]);
};
/* The stage a ready pipeline's stage hangs under: the one it names, or the one before it. */
const wantedParent = (stock: CatalogPipeline, i: number): string | undefined => stock.stages[i]!.parent ?? stock.stages[i - 1]?.name;
const sameTree = (stages: Stage[], stock: CatalogPipeline): boolean => {
  const nameOf = new Map(stages.map(s => [s.id, s.name]));
  return stages.length === stock.stages.length && stock.stages.every((want, i) => {
    const stage = stages.find(s => s.name === want.name);
    return stage !== undefined && stage.ownerRole === want.ownerRole && !stage.ownerAgentId && (stage.parentStageId ? nameOf.get(stage.parentStageId) : undefined) === wantedParent(stock, i);
  });
};

async function moveCodePipeline(tx: Tx, templates: Templates, departmentId: string, move: ShapeMove): Promise<void> {
  const stock = templates.catalogs.get('development')?.pipelines.find(p => p.key === CODE_KEY);
  const [pipeline] = await tx.select().from(pipelines).where(and(eq(pipelines.departmentId, departmentId), eq(pipelines.catalogKey, CODE_KEY), isNull(pipelines.archivedAt)));
  if (!stock || !pipeline) return;
  const stages = await tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipeline.id)).orderBy(asc(pipelineStages.position));
  if (sameTree(stages, stock)) return;
  if (!isOldChain(stages)) {
    move.review.push(`The pipeline "${pipeline.name}" was changed by hand, so it stays as it is. The template's tree: ${stock.stages.map(s => `${s.name}${s.parent ? ` (after ${s.parent})` : ''}`).join(', ')}.`);
    return;
  }
  const idOf = new Map(stages.map(s => [s.name, s.id]));
  await writeStages(tx, pipeline, catalogStages(stock).map((s, i) => ({ ...s, ...(idOf.has(stock.stages[i]!.name) ? { id: idOf.get(stock.stages[i]!.name)! } : {}) })));
  await tx.update(pipelines).set({ version: sql`${pipelines.version} + 1`, updatedAt: new Date() }).where(eq(pipelines.id, pipeline.id));
  move.moved.push(`The pipeline "${pipeline.name}" is a tree now: Development first, Review, Security, Tests and the release after it, Architecture on request beside it.`);
}

type Team = typeof teams.$inferSelect;
const madeByTemplate = (t: Team): boolean => t.turnkey && t.name === OLD_TEAM.name && t.about === OLD_TEAM.about && !t.urgentOnly && !t.gate && t.stage === 0;

/* The team the template made becomes the Hotfix unit; nobody in it is removed, and a team of more than the template brings is listed. */
async function makeHotfix(tx: Tx, stock: TeamTemplate, team: Team, move: ShapeMove): Promise<void> {
  await tx.update(teams).set({ name: stock.title.en, about: stock.description.en, turnkey: false, urgentOnly: true }).where(eq(teams.id, team.id));
  const members = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.teamId, team.id), isNull(agents.removedAt)));
  move.moved.push('The turnkey team is the Hotfix unit now: it takes urgent work only, and its fix gets its own Security read before its patch release.');
  const brings = stock.members.reduce((n, m) => n + m.count, 0);
  if (members.length > brings) move.review.push(`The Hotfix unit has ${members.length} people and the template brings ${brings}: nobody was removed. Their models were chosen for turnkey work (the strongest tier); change them if you want the department's standard.`);
}

/* What stays as a person left it: a turnkey team made by hand, and the lack of a unit for urgent work. */
function listKeptTeams(found: Team[], move: ShapeMove): void {
  for (const team of found.filter(t => t.turnkey)) move.review.push(`The team "${team.name}" is still turnkey: the template has no turnkey team in Development any more, and the team was changed by hand, so it stays as it is.`);
  if (!found.some(t => t.urgentOnly)) move.review.push('The department has no Hotfix unit (a team that takes urgent work only, of one developer): add one through staff when you want urgent fixes to run past the pipeline.');
}

async function moveTeams(tx: Tx, templates: Templates, departmentId: string, move: ShapeMove): Promise<void> {
  const stock = templates.teams.get('DEV-TEAM');
  const found = await tx.select().from(teams).where(eq(teams.departmentId, departmentId)).orderBy(asc(teams.createdAt));
  const made = found.find(madeByTemplate);
  if (stock && made) await makeHotfix(tx, stock, made, move);
  else listKeptTeams(found, move);
}

async function moveSlots(tx: Tx, departmentId: string, current: number | null, move: ShapeMove): Promise<void> {
  if (current === null) {
    await tx.update(departments).set({ slotCap: DEFAULT_SLOT_CAP }).where(eq(departments.id, departmentId));
    move.moved.push(`The department runs ${DEFAULT_SLOT_CAP} slots: one task for each of up to ${DEFAULT_SLOT_CAP} developers, and a queue for the next turn behind them.`);
  } else if (current !== DEFAULT_SLOT_CAP) move.review.push(`The department runs ${current} slots, set by hand; the template gives ${DEFAULT_SLOT_CAP}.`);
}

/* Moves one top-level Development department. Any other department is left alone. */
export async function moveDevelopmentToBatchShape(tx: Tx, templates: Templates, departmentId: string): Promise<ShapeMove> {
  const move: ShapeMove = { departmentId, moved: [], review: [] };
  const [dept] = await tx.select().from(departments).where(eq(departments.id, departmentId)).for('update');
  if (!dept || dept.parentId || dept.templateKey !== 'development') return move;
  await moveCodePipeline(tx, templates, dept.id, move);
  await moveTeams(tx, templates, dept.id, move);
  await moveSlots(tx, dept.id, dept.slotCap, move);
  return move;
}
