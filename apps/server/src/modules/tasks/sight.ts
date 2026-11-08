import { emptyEchelonFindings, type EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import { inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { canReach } from '../../auth/access.js';
import { seesAgentId, type AgentViewer } from '../../auth/agent-view.js';
import { tasks } from '../../db/schema.js';
import { taskSpot, type Task } from './engine.js';
import type { TreeFacts } from './tree.js';
import { maskWaits } from './wait-views.js';
import { taskDetail, taskLines, type AgentRef, type LogLine, type TaskDetail, type TaskLine } from './views.js';

/* What a person reads of tasks by who they see (auth/agent-view.ts): the work of the agents they see in a place they
   reach, and what they gave themselves. The rest reads as if it were not there; agents' own tools do not come this way. */

export type TaskPlace = Pick<Task, 'departmentId' | 'productId' | 'createdByPersonId' | 'createdByAgentId' | 'assigneeAgentId' | 'executorAgentId'>;

export function seesTask(viewer: AgentViewer, task: TaskPlace): boolean {
  if (!canReach(viewer.access, taskSpot(task))) return false;
  if (viewer.full || task.createdByPersonId === viewer.personId) return true;
  return [task.assigneeAgentId, task.executorAgentId, task.createdByAgentId].some(id => seesAgentId(viewer, id));
}

const shownRef = (viewer: AgentViewer, agent: AgentRef | null) => (agent && seesAgentId(viewer, agent.id) ? agent : null);

/* A wait says what its holder wrote, so it goes with the holder, and whom it is on goes when that is someone not seen. */
function shownWait(viewer: AgentViewer, line: TaskLine): TaskLine['externalWait'] {
  const wait = line.externalWait;
  if (!wait || !line.assignee || !seesAgentId(viewer, line.assignee.id)) return null;
  if (wait.on?.kind !== 'employee' || seesAgentId(viewer, wait.on.employee)) return wait;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- whom it waits on is not this reader's to know
  const { on: _on, ...rest } = wait;
  return rest;
}

function shownIndependent(viewer: AgentViewer, part: TaskLine['independentPart']): TaskLine['independentPart'] {
  if (!part || 'reason' in part) return part;
  return shownRef(viewer, part.executor) ? part : null;
}

/* Route history is shared, but hidden employees and repository candidates remain private. */
export function shownEchelons(viewer: AgentViewer, route: EchelonsSnapshot): EchelonsSnapshot {
  if (viewer.full) return route;
  const owner = (id: string | null) => seesAgentId(viewer, id) ? id : null;
  return { ...route, ownerAgentId: owner(route.ownerAgentId), candidateId: null, assignment: null,
    security: { ...route.security, addedBy: owner(route.security.addedBy) },
    stages: route.stages.map(step => ({ ...step, ownerAgentId: owner(step.ownerAgentId), inputCandidateId: null, candidateId: null })),
  };
}

function maskLine<T extends TaskLine>(viewer: AgentViewer, line: T, parentSeen: boolean): T {
  return { ...line, echelons: shownEchelons(viewer, line.echelons), waits: maskWaits(viewer, line.waits), assignee: shownRef(viewer, line.assignee), parentId: parentSeen ? line.parentId : null, externalWait: shownWait(viewer, line), independentPart: shownIndependent(viewer, line.independentPart) };
}

/* Task lines as this person reads them. */
export async function linesFor(ctx: Pick<Ctx, 'db' | 'templates'>, viewer: AgentViewer, rows: Task[]): Promise<TaskLine[]> {
  const lines = await taskLines(ctx, rows, t => seesTask(viewer, t));
  if (viewer.full) return lines;
  const parentIds = [...new Set(rows.flatMap(t => (t.parentId ? [t.parentId] : [])))];
  const parents = parentIds.length ? await ctx.db.select().from(tasks).where(inArray(tasks.id, parentIds)) : [];
  const seen = new Set(parents.filter(p => seesTask(viewer, p)).map(p => p.id));
  return lines.map(l => maskLine(viewer, l, l.parentId !== null && seen.has(l.parentId)));
}

const IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/* The files that keep the whole text of a log line (long-text.ts). */
const filesOfLine = (data: unknown) => new Set(((data ?? {}) as { fullTexts?: { id: string }[] }).fullTexts?.map(f => f.id));

/* Log data names agents by id, among much else: only this person's own id, those of agents they see and the line's own
   files stay. */
function scrubbed(viewer: AgentViewer, data: unknown): unknown {
  const text = JSON.stringify(data);
  if (text === undefined) return data;
  const own = filesOfLine(data);
  return JSON.parse(text.replace(IDS, id => (id === viewer.personId || own.has(id) || seesAgentId(viewer, id) ? id : 'hidden')));
}

/* What people and agents they see said. A line nobody signed goes too: Hornhoof's own lines name who they are about. */
function shownLog(viewer: AgentViewer, log: LogLine[]): LogLine[] {
  return log.filter(l => l.by?.kind === 'person' || seesAgentId(viewer, l.by?.id)).map(l => ({ ...l, data: scrubbed(viewer, l.data) }));
}

function maskDetail(viewer: AgentViewer, detail: TaskDetail): TaskDetail {
  const sees = (id: string | undefined) => seesAgentId(viewer, id);
  return {
    ...maskLine(viewer, detail, detail.parent !== null),
    echelonFindings: emptyEchelonFindings(),
    executor: shownRef(viewer, detail.executor),
    createdBy: detail.createdBy?.kind === 'agent' && !sees(detail.createdBy.id) ? null : detail.createdBy,
    subtasks: detail.subtasks.map(s => maskLine(viewer, s, true)),
    log: shownLog(viewer, detail.log),
    requests: detail.requests.filter(r => sees(r.agent?.id)),
    files: detail.files.filter(f => f.fromPerson || sees(f.by?.id)),
  };
}

/* One task as this person reads it. */
export async function detailFor(ctx: Pick<Ctx, 'db' | 'templates' | 'config' | 'readCommit'>, viewer: AgentViewer, task: Task): Promise<TaskDetail> {
  const detail = await taskDetail(ctx, task, t => seesTask(viewer, t));
  return viewer.full ? detail : maskDetail(viewer, detail);
}

/* The facts a department's tree is drawn from, of the agents this person sees: a line, a review or a wait with anyone else
   at its end is not drawn, and a move someone else made says only that it happened. */
export function factsFor(viewer: AgentViewer, facts: TreeFacts): TreeFacts {
  if (viewer.full) return facts;
  const sees = (id: string | null | undefined) => seesAgentId(viewer, id);
  return {
    ...facts,
    tasks: facts.tasks.map(t => (t.waits ? { ...t, waits: maskWaits(viewer, t.waits) } : t)),
    agents: facts.agents.filter(a => sees(a.id)),
    events: facts.events.map(e => (sees(e.agentId) ? e : { ...e, text: '' })),
    requests: facts.requests.filter(r => sees(r.agentId)),
    signs: facts.signs.filter(s => sees(s.agentId)),
    jobs: facts.jobs.filter(j => sees(j.agentId)),
    turns: facts.turns?.filter(t => sees(t.agentId)),
  };
}
