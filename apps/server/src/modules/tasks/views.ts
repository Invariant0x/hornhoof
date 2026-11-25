import type { TaskPriority } from '@hornhoof/protocol';
import { findingReport } from './review-findings.js';
import type { EchelonsSnapshot, EchelonFindingsView } from '@hornhoof/protocol/echelons';
import { routeSnapshots } from './route-records.js';
import type { TaskWaitView } from '@hornhoof/protocol/waits';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, people, requests, taskEvents, tasks, turns, type AgentKind, type RequestOption } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { commitUrl, filesOf, picturesOf } from './file-views.js';
import { deptName } from '../departments/templates.js';
import { commitProof, type CommitProof } from '../testruns/commit-proof.js';
import { taskEvidence, type RunEvidence } from '../testruns/evidence.js';
import type { Lang } from '../templates/load.js';
import { type Task } from './state.js';
import { queueFacts, queueOf, type Queued } from './slots.js';
import { independentViews, type IndependentPartInput, type IndependentRecord } from './independent.js';
import type { TaskWait } from './wait-state.js';
import { openWaitsOf, shownWaits } from './wait-views.js';
import { offlineMachine, type OfflineMachine } from '../nodes/offline.js';
import { trackerLookups, type GoalRef, type TrackerLookups } from '../tracker/task-view.js';
import { reviewerOf, type TimeFacts } from './time-facts.js';
/* Task log text and its automatic files have the same agent readership. */
export function agentSeesTask(agent: Pick<typeof agents.$inferSelect, 'id' | 'kind' | 'departmentId'>, task: Pick<Task, 'status' | 'departmentId' | 'assigneeAgentId' | 'executorAgentId'>): boolean {
  return agent.kind === 'orchestrator' || (agent.departmentId !== null && task.departmentId === agent.departmentId) || task.assigneeAgentId === agent.id || task.executorAgentId === agent.id;
}

export type AgentRef = { id: string; name: string; kind: AgentKind; role: Lang | null };
type Place = { id: string; name: string } | null;
export type TaskLine = {
  echelons: EchelonsSnapshot;
  id: string;
  number: number;
  title: string;
  brief: string;
  status: Task['status'];
  department: Place;
  product: Place;
  assignee: AgentRef | null;
  turn: number | null;
  parentId: string | null;
  /* The numbers of the tasks it comes after that are not done yet: until they are, it waits. */
  waitsFor: number[];
  /* Who answers for each thing it waits on, by when: what is open on it, of what this reader may see. */
  waits: TaskWaitView[];
  independentPart?: (Omit<IndependentPartInput, 'executor'> & { executor: AgentRef; task: AfterView }) | { reason: string } | null;
  externalWait?: Task['externalWait'];
  paused: Task['paused'];
  workKind: Task['workKind'];
  riskClass: Task['riskClass'];
  urgent: boolean;
  priority: TaskPriority;
  small: boolean;
  /* Where it waits for a turn with a free slot: how many turns ahead (the next is 1), its place in the queue and the open turn it
     waits behind; none for work given out. */
  queue: Queued | null;
  /* The goal it serves, through the task at the top of its work; who answers for it; why it exists; by when. */
  goal: GoalRef | null;
  responsible: { id: string; name: string } | null;
  /* The person whose request started the tree the task is in; none for work agents started themselves. */
  askedBy: { id: string; name: string } | null;
  why: string;
  dueAt: string | null;
  time: TimeFacts;
  /* Who does its work, while the assignee is whoever holds it now, such as a reviewer. */
  executor: AgentRef | null;
  /* The department's pipeline it goes along and the stage it stands in. */
  pipelineId: string | null;
  pipelineStageId: string | null;
  createdAt: string;
  updatedAt: string;
};
/* for: the person the orchestrator acted for, as in a request it answered for them. byOrchestrator: the person's answer, which
   the orchestrator gave of its own. */
export type LogLine = { kind: string; text: string; data: unknown; by: { kind: 'person' | 'agent'; id: string; name: string; for?: { id: string; name: string }; byOrchestrator?: true } | null; at: string };
/* images: the pictures the agent showed, commitUrl: where its commit can be seen, proof: what test runs say of that very
   commit, picked: the way a person took in a choice, byOrchestrator: the orchestrator gave the answer. */
export type RequestView = {
  id: string;
  kind: (typeof requests.$inferSelect)['kind'];
  text: string;
  commit: string | null;
  commitUrl: string | null;
  proof: CommitProof | null;
  images: string[];
  options: RequestOption[];
  link: string | null;
  picked: number | null;
  status: string;
  answer: string | null;
  byOrchestrator: boolean;
  agent: AgentRef | null;
  at: string;
};
/* A task another one comes after, and where it stands. */
export type AfterView = { id: string; number: number; title: string; status: Task['status'] };
/* A file an agent put on the task, which any agent downloads by its name. */
/* fromPerson: by is a person, the file's author, not the agent it is kept under. */
export type FileView = { id: string; name: string; size: number; by: { id: string; name: string } | null; fromPerson: boolean; at: string };
export type TaskDetail = TaskLine & {
  echelonFindings: EchelonFindingsView;
  body: string;
  parent: { id: string; number: number; title: string } | null;
  after: AfterView[];
  /* The tasks that come after this one, of those the reader sees. */
  neededFor: AfterView[];
  createdBy: { kind: 'person' | 'agent'; id: string; name: string } | null;
  subtasks: TaskLine[];
  log: LogLine[];
  requests: RequestView[];
  files: FileView[];
  /* The newest test runs, each with the commit it pinned and whether it still proves its branch. */
  testEvidence: RunEvidence[];
  /* The machine the plan of whoever holds the task was heard from last while none of its machines is online. */
  assigneeOffline: OfflineMachine | null;
};

type Names = TrackerLookups & {
  route(t: Task): EchelonsSnapshot;
  queue(t: Pick<Task, 'id'>): Queued | null;
  agent(id: string | null): AgentRef | null;
  isOrchestrator(id: string | null): boolean;
  place(id: string | null): Place;
  turn(id: string | null): number | null;
  after(t: Pick<Task, 'after'>): Task[];
  independent(t: Pick<Task, 'id'>): IndependentRecord | undefined;
  waits(t: Pick<Task, 'id'>): TaskWait[];
};

/* Names for everything the tasks point at, read in one go. */
async function names(ctx: Pick<Ctx, 'db' | 'templates'>, rows: Task[], sees: (t: Task) => boolean, more: string[] = []): Promise<Names> {
  const independent = await independentViews(ctx.db, rows.map(t => t.id));
  const partExecutors = [...independent.values()].flatMap(record => record.kind === 'part' ? [record.part.executor] : []);
  const waits = await openWaitsOf(ctx.db, rows.map(t => t.id));
  const waitAgents = [...waits.values()].flat().map(wait =>
    wait.kind === 'external' && wait.sourceKey.startsWith('question:') ? wait.ownerAgentId : reviewerOf(wait));
  const employees = rows.flatMap(t => t.externalWait?.on?.kind === 'employee' ? [t.externalWait.on.employee] : []);
  const agentIds = [...new Set([...rows.flatMap(t => [t.assigneeAgentId, t.executorAgentId, t.createdByAgentId]), ...partExecutors, ...waitAgents, ...employees, ...more].filter((x): x is string => Boolean(x)))];
  const placeIds = [...new Set(rows.flatMap(t => [t.departmentId, t.productId]).filter((x): x is string => Boolean(x)))];
  const turnIds = [...new Set(rows.map(t => t.turnId).filter((x): x is string => Boolean(x)))];
  const agentRows = agentIds.length ? await ctx.db.select({ id: agents.id, name: agents.name, kind: agents.kind, roleKey: agents.roleKey }).from(agents).where(inArray(agents.id, agentIds)) : [];
  const placeRows = placeIds.length ? await ctx.db.select().from(departments).where(inArray(departments.id, placeIds)) : [];
  const turnRows = turnIds.length ? await ctx.db.select({ id: turns.id, number: turns.number }).from(turns).where(inArray(turns.id, turnIds)) : [];
  const afterIds = [...new Set(rows.flatMap(t => t.after))];
  const afterRows = afterIds.length ? await ctx.db.select().from(tasks).where(inArray(tasks.id, afterIds)) : [];
  const routes = await routeSnapshots(ctx.db, rows);
  const lookups = nameLookups(ctx, { agentRows, placeRows, turnRows, afterRows }, independent, waits);
  const seenAfter = new Map(afterRows.filter(t => t.status !== 'done' && sees(t)).map(t => [t.id, t.number]));
  const tracker = await trackerLookups(ctx.db, rows, lookups.waits, { agent: id => lookups.agent(id)?.name, task: id => seenAfter.get(id) });
  const queues = await queueFacts(ctx.db, rows);
  return { ...lookups, ...tracker, route: t => routes.get(t.id)!, queue: queueOf(queues) };
}

type NamedRows = {
  agentRows: Pick<typeof agents.$inferSelect, 'id' | 'name' | 'kind' | 'roleKey'>[];
  placeRows: (typeof departments.$inferSelect)[];
  turnRows: Pick<typeof turns.$inferSelect, 'id' | 'number'>[];
  afterRows: Task[];
};

function nameLookups(ctx: Pick<Ctx, 'templates'>, { agentRows, placeRows, turnRows, afterRows }: NamedRows, independent: Map<string, IndependentRecord>, waits: Map<string, TaskWait[]>): Omit<Names, 'route' | 'queue' | keyof TrackerLookups> {
  const orchestrators = new Set<string | null>(agentRows.filter(a => a.kind === 'orchestrator').map(a => a.id));
  return {
    isOrchestrator: id => orchestrators.has(id),
    agent: id => {
      const a = agentRows.find(r => r.id === id);
      return a ? { id: a.id, name: a.name, kind: a.kind, role: (a.roleKey && ctx.templates.roles.get(a.roleKey)?.title) || null } : null;
    },
    place: id => {
      const d = placeRows.find(r => r.id === id);
      return d ? { id: d.id, name: deptName(d) } : null;
    },
    turn: id => turnRows.find(r => r.id === id)?.number ?? null,
    after: t => t.after.flatMap(id => afterRows.filter(r => r.id === id)).sort((a, b) => a.number - b.number),
    independent: t => independent.get(t.id),
    waits: t => waits.get(t.id) ?? [],
  };
}

/* sees: who reads it may see that task, so the line names what it waits for only of those. */
const line = (t: Task, n: Names, sees: (t: Task) => boolean): TaskLine => ({
  id: t.id,
  echelons: n.route(t),
  number: t.number,
  title: t.title,
  brief: t.brief,
  status: t.status,
  department: n.place(t.departmentId),
  product: n.place(t.productId),
  assignee: n.agent(t.assigneeAgentId),
  executor: n.agent(t.executorAgentId),
  turn: n.turn(t.turnId),
  parentId: t.parentId,
  waitsFor: n.after(t).filter(a => a.status !== 'done' && sees(a)).map(a => a.number),
  waits: shownWaits(n.waits(t), id => n.after(t).some(a => a.id === id && sees(a))),
  independentPart: (() => {
    const part = t.after.length ? n.independent(t) : null;
    if (!part) return null;
    if (part.kind === 'none') return { reason: part.reason };
    return sees(part.child) ? { title: part.part.title, brief: part.part.brief, body: part.part.body, executor: n.agent(part.part.executor)!, task: { id: part.child.id, number: part.child.number, title: part.child.title, status: part.child.status } } : null;
  })(),
  externalWait: t.externalWait,
  paused: t.paused,
  workKind: t.workKind,
  riskClass: t.riskClass,
  urgent: t.urgent,
  priority: t.priority ?? 'normal',
  small: t.small,
  queue: n.queue(t),
  goal: n.goal(t),
  responsible: n.person(t.responsiblePersonId),
  askedBy: n.person(t.askedByPersonId),
  why: t.why,
  dueAt: t.dueAt?.toISOString() ?? null,
  time: n.time(t),
  pipelineId: t.pipelineId,
  pipelineStageId: t.pipelineStageId,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export async function taskLines(ctx: Pick<Ctx, 'db' | 'templates'>, rows: Task[], sees: (t: Task) => boolean): Promise<TaskLine[]> {
  const n = await names(ctx, rows, sees);
  return rows.map(t => line(t, n, sees));
}

const LOG_SHOWN = 200;

/* The people the orchestrator acted for in these events, by id. */
async function forWhom(db: Ctx['db'], data: Record<string, unknown>[]): Promise<Map<string, { id: string; name: string }>> {
  const ids = [...new Set(data.flatMap(d => (typeof d.onBehalfOfPersonId === 'string' ? [d.onBehalfOfPersonId] : [])))];
  if (!ids.length) return new Map();
  return new Map((await db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, ids))).map(p => [p.id, p]));
}

/* A line of a history as it is kept, for a task and a goal alike. */
export type LogRow = { kind: string; text: string; data: Record<string, unknown>; personId: string | null; personName: string | null; agentId: string | null; at: Date };

/* A history as people read it, oldest first, from its rows newest first: who wrote each line, a person, or an agent with
   the person it acted for. */
export async function logOf(db: Ctx['db'], rows: LogRow[], agentName: (id: string) => string | undefined): Promise<LogLine[]> {
  const actedFor = await forWhom(db, rows.map(e => e.data));
  const by = ({ personId, personName, agentId, data }: LogRow): LogLine['by'] => {
    if (personId) return { kind: 'person', id: personId, name: personName ?? '', ...(data.byOrchestrator === true ? { byOrchestrator: true as const } : {}) };
    if (!agentId) return null;
    const whom = typeof data.onBehalfOfPersonId === 'string' ? actedFor.get(data.onBehalfOfPersonId) : undefined;
    return { kind: 'agent', id: agentId, name: agentName(agentId) ?? '', ...(whom ? { for: whom } : {}) };
  };
  return [...rows].reverse().map(e => ({ kind: e.kind, text: e.text, data: e.data, by: by(e), at: e.at.toISOString() }));
}

/* What test runs say of the commit each request names, for those that name one. */
const proofsOf = (db: Ctx['db'], task: Task, asks: Pick<typeof requests.$inferSelect, 'commit'>[]) =>
  Promise.all(asks.map(async r => (r.commit ? commitProof(db, task, r.commit) : null)));

/* Files retain the actual person author when their required agent field names a task recipient. */
async function fileViews(db: Ctx['db'], n: Names, files: Awaited<ReturnType<typeof filesOf>>): Promise<FileView[]> {
  const ids = files.flatMap(f => f.personId ? [f.personId] : []);
  const authors = ids.length ? await db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, ids)) : [];
  return files.map(f => {
    const a = n.agent(f.agentId);
    const author = authors.find(p => p.id === f.personId);
    return { id: f.id, name: f.name, size: f.size, by: author ?? (a && { id: a.id, name: a.name }), fromPerson: Boolean(author), at: f.at.toISOString() };
  });
}

/* One task as people and agents read it: the body, its required route, what it was split into, and its log.
   The task it serves and the tasks under it show only when the reader may see them too. */
export async function taskDetail(ctx: Pick<Ctx, 'db' | 'templates' | 'config' | 'readCommit'> & Partial<Pick<Ctx, 'hub'>>, task: Task, sees: (t: Task) => boolean): Promise<TaskDetail> {
  const { db } = ctx;
  const subs = (await db.select().from(tasks).where(eq(tasks.parentId, task.id)).orderBy(asc(tasks.number))).filter(sees);
  const [above] = task.parentId ? await db.select().from(tasks).where(eq(tasks.id, task.parentId)) : [];
  const parent = above && sees(above) ? { id: above.id, number: above.number, title: above.title } : null;
  const events = await db
    .select({ kind: taskEvents.kind, text: taskEvents.text, data: taskEvents.data, personId: taskEvents.personId, personName: people.name, agentId: taskEvents.agentId, at: taskEvents.createdAt })
    .from(taskEvents)
    .leftJoin(people, eq(people.id, taskEvents.personId))
    .where(eq(taskEvents.taskId, task.id))
    .orderBy(desc(taskEvents.id))
    .limit(LOG_SHOWN);
  const asks = await db.select().from(requests).where(eq(requests.taskId, task.id)).orderBy(asc(requests.createdAt));
  const pictures = await picturesOf(db, asks);
  const commits = await Promise.all(asks.map(r => commitUrl(db, task, r.commit)));
  const proofs = await proofsOf(db, task, asks);
  const files = await filesOf(db, task.id);
  const [creator] = task.createdByPersonId ? await db.select({ id: people.id, name: people.name }).from(people).where(eq(people.id, task.createdByPersonId)) : [];
  const n = await names(ctx, [task, ...subs], sees, [...events.map(e => e.agentId), ...asks.flatMap(r => [r.agentId, r.answeredByAgentId]), ...files.map(f => f.agentId)].filter((x): x is string => Boolean(x)));
  /* Only what this reader may see of what the task comes after. */
  const after = n.after(task).filter(sees);
  return {
    ...line(task, n, sees),
    echelonFindings: await findingReport(db, [task.id]),
    body: task.body,
    parent,
    after: after.map(a => ({ id: a.id, number: a.number, title: a.title, status: a.status })),
    neededFor: (await db.select().from(tasks).where(sql`${tasks.after} @> ${JSON.stringify([task.id])}::jsonb`).orderBy(asc(tasks.number))).filter(sees).map(a => ({ id: a.id, number: a.number, title: a.title, status: a.status })),
    createdBy: creator ? { kind: 'person', ...creator } : task.createdByAgentId ? { kind: 'agent', id: task.createdByAgentId, name: n.agent(task.createdByAgentId)?.name ?? '' } : null,
    subtasks: subs.map(t => line(t, n, sees)),
    log: await logOf(db, events, id => n.agent(id)?.name),
    requests: asks.map((r, i) => ({
      id: r.id,
      kind: r.kind,
      text: r.text,
      commit: r.commit,
      commitUrl: commits[i]!,
      proof: proofs[i]!,
      images: pictures.get(r.id) ?? [],
      options: r.options,
      link: r.link,
      picked: r.picked,
      status: r.status,
      answer: r.answer,
      byOrchestrator: n.isOrchestrator(r.answeredByAgentId),
      agent: n.agent(r.agentId),
      at: r.createdAt.toISOString(),
    })),
    files: await fileViews(db, n, files),
    testEvidence: await taskEvidence(ctx, task),
    assigneeOffline: await holderOffline(ctx, task.assigneeAgentId),
  };
}

/* Without the hub, as in a reader that knows no machine, nothing is said of one. */
async function holderOffline(ctx: Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'hub'>>, agentId: string | null): Promise<OfflineMachine | null> {
  if (!ctx.hub || !agentId) return null;
  const [holder] = await ctx.db.select(only(agents, 'subscriptionId')).from(agents).where(eq(agents.id, agentId));
  return offlineMachine({ db: ctx.db, hub: ctx.hub }, holder?.subscriptionId ?? null);
}
export { taskByRef } from './lookup.js';
