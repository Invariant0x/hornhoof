import type { EchelonFindingsView, EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import { inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { canReach } from '../../auth/access.js';
import { knowsAgentId, ownsPlace, seesAgentId, type AgentViewer } from '../../auth/agent-view.js';
import { tasks } from '../../db/schema.js';
import { taskSpot, type Task } from './engine.js';
import type { TreeFacts } from './tree.js';
import { maskWaits } from './wait-views.js';
import { taskDetail, taskLines, type AgentRef, type LogLine, type TaskDetail, type TaskLine } from './views.js';

/* What a person reads of tasks (auth/agent-view.ts): every task of the company, with every employee named in it and its
   stages, as the tasks are the company's work. What an agent said in them is its own, for the people who open that agent;
   what the repository says stays with the CEO's view and the owner of the task's department. Changing a task goes by who
   acts on its work. Agents' own tools do not come this way. */

export type TaskPlace = Pick<Task, 'departmentId' | 'productId' | 'createdByPersonId' | 'createdByAgentId' | 'assigneeAgentId' | 'executorAgentId'>;

/* Every task of the company, but the work of another person's assistant's own agent. */
export function seesTask(viewer: Pick<AgentViewer, 'apart'>, task: TaskPlace): boolean {
  return [task.assigneeAgentId, task.executorAgentId].every(id => !id || knowsAgentId(viewer, id));
}

/* Whether the person changes the task: the work of the agents they open in a place they reach, and what they gave themselves. */
export function actsOnTask(viewer: AgentViewer, task: TaskPlace): boolean {
  if (!canReach(viewer.access, taskSpot(task))) return false;
  if (viewer.full || task.createdByPersonId === viewer.personId) return true;
  return [task.assigneeAgentId, task.executorAgentId, task.createdByAgentId].some(id => seesAgentId(viewer, id));
}

const shownRef = (viewer: AgentViewer, agent: AgentRef | null) => (agent && knowsAgentId(viewer, agent.id) ? agent : null);

/* A wait says what its holder wrote, so it goes with whoever opens the holder, and whom it is on goes when that is someone
   not known. */
function shownWait(viewer: AgentViewer, line: TaskLine): TaskLine['externalWait'] {
  const wait = line.externalWait;
  if (!wait || !line.assignee || !seesAgentId(viewer, line.assignee.id)) return null;
  if (wait.on?.kind !== 'employee' || knowsAgentId(viewer, wait.on.employee)) return wait;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- whom it waits on is not this reader's to know
  const { on: _on, ...rest } = wait;
  return rest;
}

function shownIndependent(viewer: AgentViewer, part: TaskLine['independentPart']): TaskLine['independentPart'] {
  if (!part || 'reason' in part) return part;
  return shownRef(viewer, part.executor) ? part : null;
}

/* Whether this person owns the department the task is in (its products' tasks name it too), and so reads its repository
   side, as the rest of that department. */
const ownsTaskDepartment = (viewer: AgentViewer, departmentId: string | null | undefined): boolean =>
  Boolean(departmentId) && ownsPlace(viewer, { departmentId: departmentId! });

/* Route history is shared, with whoever owns each stage, but repository candidates remain private: to the CEO's view and to
   the owner of the task's department. */
export function shownEchelons(viewer: AgentViewer, route: EchelonsSnapshot, departmentId: string | null): EchelonsSnapshot {
  if (viewer.full) return route;
  const owner = (id: string | null) => knowsAgentId(viewer, id) ? id : null;
  const own = ownsTaskDepartment(viewer, departmentId);
  const candidate = (id: string | null) => (own ? id : null);
  return { ...route, ownerAgentId: owner(route.ownerAgentId), candidateId: candidate(route.candidateId),
    assignment: own && route.assignment && knowsAgentId(viewer, route.assignment.agentId) ? route.assignment : null,
    security: { ...route.security, addedBy: owner(route.security.addedBy) },
    stages: route.stages.map(step => ({ ...step, ownerAgentId: owner(step.ownerAgentId), inputCandidateId: candidate(step.inputCandidateId), candidateId: candidate(step.candidateId) })),
  };
}

/* A person who sees the task reads how many findings each stage reported and confirmed, never what they say: their paths,
   lines, harm, commits and candidates are the repository's. The owner of the task's department reads them whole. */
function shownFindings<T extends EchelonFindingsView & { byVendor?: { vendor: string; count: number; findingIds: string[] }[] }>(viewer: AgentViewer, findings: T, departmentId: string | null): T {
  if (viewer.full || ownsTaskDepartment(viewer, departmentId)) return findings;
  return { ...findings, issues: [], ...(findings.byVendor ? { byVendor: findings.byVendor.map(vendor => ({ ...vendor, findingIds: [] })) } : {}) };
}

/* Whom a task waits for, as whom its waits answer to shows: no employee the reader does not know of, and no other person. */
const shownWho = (viewer: AgentViewer, who: TaskLine['time']['waitsOn'][number]['who']) =>
  !who || (who.kind === 'agent' ? knowsAgentId(viewer, who.id) : who.id === viewer.personId) ? who : null;
const shownTime = (viewer: AgentViewer, time: TaskLine['time'], externalWait: TaskLine['externalWait']): TaskLine['time'] => ({
  ...time, waitsOn: time.waitsOn.map(w => ({ ...w, who: shownWho(viewer, w.who), reason: w.kind === 'external' && !externalWait ? null : w.reason })),
});

function maskLine<T extends TaskLine>(viewer: AgentViewer, line: T, parentSeen: boolean): T {
  const externalWait = shownWait(viewer, line);
  return { ...line, echelons: shownEchelons(viewer, line.echelons, line.department?.id ?? null), waits: maskWaits(viewer, line.waits), assignee: shownRef(viewer, line.assignee), executor: shownRef(viewer, line.executor), parentId: parentSeen ? line.parentId : null, externalWait, independentPart: shownIndependent(viewer, line.independentPart), time: shownTime(viewer, line.time, externalWait) };
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

/* Log data names agents by id, among much else: only this person's own id, those of agents they know of and the line's own
   files stay. */
function scrubbed(viewer: AgentViewer, data: unknown): unknown {
  const text = JSON.stringify(data);
  if (text === undefined) return data;
  const own = filesOfLine(data);
  return JSON.parse(text.replace(IDS, id => (id === viewer.personId || own.has(id) || knowsAgentId(viewer, id) ? id : 'hidden')));
}

/* What people and agents they open said. A line nobody signed goes too: Hornhoof's own lines name who they are about. A
   line of an agent they do not open says only who did what kind of thing and when, as the tree does: its words are that
   agent's own. */
function shownLog(viewer: AgentViewer, log: LogLine[]): LogLine[] {
  return log
    .filter(l => l.by?.kind !== 'agent' || knowsAgentId(viewer, l.by.id))
    .map(l => (l.by?.kind === 'agent' && !seesAgentId(viewer, l.by.id) ? { ...l, text: '', data: {} } : { ...l, data: scrubbed(viewer, l.data) }));
}

/* Which machine of the holder is offline goes only to who may open the holder, as its card. */
const shownOffline = (viewer: AgentViewer, detail: TaskDetail) => (seesAgentId(viewer, detail.assignee?.id) ? detail.assigneeOffline : null);

function maskDetail(viewer: AgentViewer, detail: TaskDetail): TaskDetail {
  const sees = (id: string | undefined) => seesAgentId(viewer, id);
  return {
    ...maskLine(viewer, detail, detail.parent !== null),
    echelonFindings: shownFindings(viewer, detail.echelonFindings, detail.department?.id ?? null),
    createdBy: detail.createdBy?.kind === 'agent' && !knowsAgentId(viewer, detail.createdBy.id) ? null : detail.createdBy,
    subtasks: detail.subtasks.map(s => maskLine(viewer, s, true)),
    log: shownLog(viewer, detail.log),
    requests: detail.requests.filter(r => sees(r.agent?.id)),
    files: detail.files.filter(f => f.fromPerson || sees(f.by?.id)),
    assigneeOffline: shownOffline(viewer, detail),
  };
}

/* One task as this person reads it. */
export async function detailFor(ctx: Pick<Ctx, 'db' | 'templates' | 'config' | 'readCommit'> & Partial<Pick<Ctx, 'hub'>>, viewer: AgentViewer, task: Task): Promise<TaskDetail> {
  const detail = await taskDetail(ctx, task, t => seesTask(viewer, t));
  return viewer.full ? detail : maskDetail(viewer, detail);
}

/* The facts a department's tree is drawn from, with every agent of it: a move or a question of an agent this person does not
   open says only that it happened, as its words are that agent's own. departmentId: the department its tasks are in. */
export function factsFor(viewer: AgentViewer, facts: TreeFacts, departmentId: string): TreeFacts {
  if (viewer.full) return facts;
  const sees = (id: string | null | undefined) => seesAgentId(viewer, id);
  const knows = (id: string | null | undefined) => !id || knowsAgentId(viewer, id);
  return {
    ...facts,
    tasks: facts.tasks.map(t => ({ ...t, echelons: shownEchelons(viewer, t.echelons, departmentId), echelonFindings: shownFindings(viewer, t.echelonFindings, departmentId), waits: t.waits ? maskWaits(viewer, t.waits) : [] })),
    agents: facts.agents.filter(a => knows(a.id)),
    events: facts.events.filter(e => knows(e.agentId)).map(e => (sees(e.agentId) ? e : { ...e, text: '' })),
    requests: facts.requests.filter(r => knows(r.agentId)).map(r => (sees(r.agentId) ? r : { ...r, text: '' })),
    signs: facts.signs.filter(s => knows(s.agentId)),
    jobs: facts.jobs.filter(j => knows(j.agentId)),
    turns: facts.turns?.filter(t => knows(t.agentId)),
  };
}
