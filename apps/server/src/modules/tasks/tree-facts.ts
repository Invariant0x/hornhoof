import type { TaskWaitView } from '@hornhoof/protocol/waits';
import { and, asc, eq, gte, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.js';
import { agentEvents, agents, departments, jobs, requests, taskEvents, tasks } from '../../db/schema.js';
import { CLOSED, type Task, type Tx } from './state.js';
import { NUDGES, treeOwnerSince, type FactJobState, type FactRequest, type FactSign, type FactTask, type FactTaskEvent, type TreeFacts } from './tree.js';

import { routeSnapshots } from './route-records.js';
import { countedFindings } from './review-findings.js';
import type { EchelonsSnapshot, EchelonFindingsView } from '@hornhoof/protocol/echelons';
import { readTurnHistory, upTo } from './tree-history.js';
import { openWaitsOf, shownWaits } from './wait-views.js';
import { openTurnOf, workOfOpenTurn } from './turn-department.js';

type Reader = Db | Tx;

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

/* Signs of life grouped by distinct minute per task and agent, keeping the minute's bounds for exact stall starts. */
async function readSigns(db: Reader, taskIds: string[], turnStarted: Date, until?: Date): Promise<FactSign[]> {
  const fromTasks = db
    .select({
      taskId: sql<string>`${taskEvents.taskId}`.as('task_id'),
      agentId: sql<string | null>`${taskEvents.agentId}`.as('agent_id'),
      createdAt: sql<Date>`${taskEvents.createdAt}`.as('created_at'),
    })
    .from(taskEvents)
    .where(and(inArray(taskEvents.taskId, taskIds), notInArray(taskEvents.kind, [...NUDGES]), gte(taskEvents.createdAt, turnStarted), upTo(taskEvents.createdAt, until)));

  const fromAgents = db
    .select({
      taskId: sql<string>`${jobs.taskId}`.as('task_id'),
      agentId: sql<string | null>`${agentEvents.agentId}`.as('agent_id'),
      createdAt: sql<Date>`${agentEvents.createdAt}`.as('created_at'),
    })
    .from(agentEvents)
    .innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
    .where(and(inArray(jobs.taskId, taskIds), gte(agentEvents.createdAt, turnStarted), upTo(agentEvents.createdAt, until)));

  const raw = unionAll(fromTasks, fromAgents).as('raw');
  const buckets = await db
    .select({
      taskId: raw.taskId,
      agentId: raw.agentId,
      firstAt: sql<Date | string>`min(${raw.createdAt})`,
      lastAt: sql<Date | string>`max(${raw.createdAt})`,
    })
    .from(raw)
    .groupBy(raw.taskId, raw.agentId, sql`date_trunc('minute', ${raw.createdAt})`);

  return buckets.flatMap(b => {
    const first = toDate(b.firstAt);
    const last = toDate(b.lastAt);
    return first.getTime() === last.getTime()
      ? [{ taskId: b.taskId, agentId: b.agentId, at: first }]
      : [
          { taskId: b.taskId, agentId: b.agentId, at: first },
          { taskId: b.taskId, agentId: b.agentId, at: last },
        ];
  });
}

async function readJobStates(db: Reader, taskIds: string[]): Promise<FactJobState[]> {
  const rows = await db
    .select({
      taskId: sql<string>`${jobs.taskId}`,
      agentId: sql<string>`${jobs.agentId}`,
      lastActionAt: sql<Date | string | null>`max(${agentEvents.createdAt})`,
      live: sql<boolean>`bool_or(${jobs.status} = 'running')`,
    })
    .from(jobs)
    .leftJoin(agentEvents, eq(agentEvents.jobId, jobs.id))
    .where(and(inArray(jobs.taskId, taskIds), isNotNull(jobs.agentId)))
    .groupBy(jobs.taskId, jobs.agentId);

  return rows.map(r => ({
    taskId: r.taskId,
    agentId: r.agentId,
    lastActionAt: r.lastActionAt ? toDate(r.lastActionAt) : null,
    live: Boolean(r.live),
  }));
}

function collectAgentIds(turnTasks: Task[], events: FactTaskEvent[], asks: FactRequest[], jobStates: FactJobState[]): string[] {
  const raw = [
    ...turnTasks.flatMap(t => [t.executorAgentId, t.assigneeAgentId]),
    ...asks.map(r => r.agentId),
    ...events.map(e => e.agentId),
    ...jobStates.map(job => job.agentId),
  ];
  return [...new Set(raw.filter((x): x is string => Boolean(x)))];
}

function extraTaskIdsOf(turnTasks: Task[], knownIds: Set<string>): string[] {
  const referenced = turnTasks.flatMap(t => (t.parentId ? [t.parentId, ...t.after] : t.after));
  return [...new Set(referenced)].filter(id => !knownIds.has(id));
}

function hasRepository(t: Task, repoIds: Set<string>): boolean {
  if (t.departmentId && repoIds.has(t.departmentId)) return true;
  return Boolean(t.productId && repoIds.has(t.productId));
}

const toFactTask = (t: Task, repoIds: Set<string>, sees: (t: Task) => boolean, waits: TaskWaitView[], echelons: EchelonsSnapshot, echelonFindings: EchelonFindingsView, events: FactTaskEvent[]): FactTask => ({
  waits,
  echelons,
  echelonFindings,
  ownerSince: treeOwnerSince({ ...t, echelons }, events),
  id: t.id,
  number: t.number,
  title: t.title,
  status: t.status,
  externalWait: t.externalWait,
  parentId: t.parentId,
  executorAgentId: t.executorAgentId,
  assigneeAgentId: t.assigneeAgentId,
  after: t.after,
  inRepository: hasRepository(t, repoIds),
  createdAt: t.createdAt,
  closedAt: t.closedAt,
  visible: sees(t),
});

const emptyFacts = (repository: boolean, turn: TreeFacts['turn']): TreeFacts => ({
  repository,
  turn,
  agents: [],
  tasks: [],
  related: [],
  events: [],
  requests: [],
  signs: [],
  jobs: [],
});

type StoredEvent = FactTaskEvent & Pick<typeof taskEvents.$inferSelect, 'id' | 'companyId'>;

function eventsByTask(events: StoredEvent[]): Map<string, StoredEvent[]> {
  const byTask = new Map<string, StoredEvent[]>();
  for (const event of events) {
    const own = byTask.get(event.taskId) ?? [];
    own.push(event);
    byTask.set(event.taskId, own);
  }
  return byTask;
}

type TaskFactsContext = {
  repoIds: Set<string>; sees: (task: Task) => boolean; seenAfter: Set<string>;
  waits: Awaited<ReturnType<typeof openWaitsOf>>; workflows: Awaited<ReturnType<typeof routeSnapshots>>;
  events: Map<string, StoredEvent[]>;
};

function currentTaskFacts(task: Task, context: TaskFactsContext): FactTask {
  const { repoIds, sees, seenAfter, waits, workflows } = context;
  const events = context.events.get(task.id) ?? [];
  return toFactTask(task, repoIds, sees, shownWaits(waits.get(task.id) ?? [], id => seenAfter.has(id)), workflows.get(task.id)!, countedFindings(events), events);
}

/* The department's facts in a turn. until: a turn that is over, whose agents went on to other work after it. */
export async function treeFactsOf(db: Reader, companyId: string, departmentId: string, sees: (t: Task) => boolean, turn: TreeFacts['turn'], until?: Date): Promise<TreeFacts> {
  const places = await db
    .select({ id: departments.id, repoUrl: departments.repoUrl })
    .from(departments)
    .where(and(eq(departments.companyId, companyId), or(eq(departments.id, departmentId), eq(departments.parentId, departmentId))));
  const repoIds = new Set(places.filter(p => p.repoUrl).map(p => p.id));
  const repository = repoIds.size > 0;
  if (!turn) return emptyFacts(repository, null);

  const turnTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, companyId), eq(tasks.departmentId, departmentId), until ? eq(tasks.turnId, turn.id) : or(eq(tasks.turnId, turn.id), and(workOfOpenTurn(turn.id), notInArray(tasks.status, [...CLOSED])))))
    .orderBy(asc(tasks.createdAt), asc(tasks.number));
  if (!turnTasks.length) return emptyFacts(repository, turn);

  const taskIds = turnTasks.map(t => t.id);
  const extraIds = extraTaskIdsOf(turnTasks, new Set(taskIds));
  const extraTasks = extraIds.length ? await db.select().from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.id, extraIds))) : [];

  const events = await db
    .select({
      id: taskEvents.id,
      companyId: taskEvents.companyId,
      taskId: taskEvents.taskId,
      agentId: taskEvents.agentId,
      kind: taskEvents.kind,
      text: taskEvents.text,
      data: taskEvents.data,
      createdAt: taskEvents.createdAt,
    })
    .from(taskEvents)
    .where(and(inArray(taskEvents.taskId, taskIds), notInArray(taskEvents.kind, [...NUDGES])))
    .orderBy(asc(taskEvents.createdAt), asc(taskEvents.id));

  const asks = await db
    .select({
      taskId: requests.taskId,
      agentId: requests.agentId,
      text: requests.text,
      status: requests.status,
      createdAt: requests.createdAt,
      answeredAt: requests.answeredAt,
    })
    .from(requests)
    .where(inArray(requests.taskId, taskIds))
    .orderBy(asc(requests.createdAt));

  const waits = await openWaitsOf(db, until ? [] : taskIds);
  const seenAfter = new Set([...turnTasks, ...extraTasks].filter(sees).map(t => t.id));
  const from = turn.openedAt ?? turn.createdAt;
  const signs = await readSigns(db, taskIds, from, until);
  const jobStates = await readJobStates(db, taskIds);
  const agentIds = collectAgentIds(turnTasks, events, asks, jobStates);
  const workflows = await routeSnapshots(db, turnTasks);
  const byTask = eventsByTask(events);
  const history = await readTurnHistory(db, companyId, agentIds, from, until);
  const agentRows = agentIds.length
    ? await db.select({ id: agents.id, name: agents.name, createdAt: agents.createdAt }).from(agents).where(inArray(agents.id, agentIds)).orderBy(asc(agents.createdAt))
    : [];

  return {
    repository,
    turn,
    agents: agentRows,
    tasks: turnTasks.map(task => currentTaskFacts(task, { repoIds, sees, seenAfter, waits, workflows, events: byTask })),
    related: extraTasks.map(t => ({ id: t.id, number: t.number, title: t.title, status: t.status, visible: sees(t) })),
    events,
    requests: asks,
    signs,
    jobs: jobStates,
    turns: history,
  };
}

/* The tree of the turn the department runs now, its top-level department's open one. */
export async function treeFacts(db: Db, companyId: string, departmentId: string, sees: (t: Task) => boolean): Promise<TreeFacts> {
  const turn = await openTurnOf(db, companyId, departmentId);
  return treeFactsOf(db, companyId, departmentId, sees, turn && { id: turn.id, number: turn.number, createdAt: turn.createdAt, openedAt: turn.openedAt });
}
