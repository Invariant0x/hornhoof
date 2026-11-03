import { and, asc, eq, gte, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.js';
import { agentEvents, agents, departments, jobs, requests, taskEvents, tasks, turns } from '../../db/schema.js';
import type { Task } from './engine.js';
import { NUDGES, type FactJobState, type FactRequest, type FactSign, type FactTask, type FactTaskEvent, type TreeFacts } from './tree.js';

import { readTurnHistory } from './tree-history.js';

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

/* Signs of life grouped by distinct minute per task and agent, keeping the minute's bounds for exact stall starts. */
async function readSigns(db: Db, taskIds: string[], turnStarted: Date): Promise<FactSign[]> {
  const fromTasks = db
    .select({
      taskId: sql<string>`${taskEvents.taskId}`.as('task_id'),
      agentId: sql<string | null>`${taskEvents.agentId}`.as('agent_id'),
      createdAt: sql<Date>`${taskEvents.createdAt}`.as('created_at'),
    })
    .from(taskEvents)
    .where(and(inArray(taskEvents.taskId, taskIds), notInArray(taskEvents.kind, [...NUDGES]), gte(taskEvents.createdAt, turnStarted)));

  const fromAgents = db
    .select({
      taskId: sql<string>`${jobs.taskId}`.as('task_id'),
      agentId: sql<string | null>`${agentEvents.agentId}`.as('agent_id'),
      createdAt: sql<Date>`${agentEvents.createdAt}`.as('created_at'),
    })
    .from(agentEvents)
    .innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
    .where(and(inArray(jobs.taskId, taskIds), gte(agentEvents.createdAt, turnStarted)));

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

async function readJobStates(db: Db, taskIds: string[]): Promise<FactJobState[]> {
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

function panelFromEvent(e: FactTaskEvent): string[] {
  if (e.kind !== 'created' || !Array.isArray(e.data.panel)) return [];
  return e.data.panel.filter((p): p is string => typeof p === 'string');
}

function collectAgentIds(turnTasks: Task[], events: FactTaskEvent[], asks: FactRequest[]): string[] {
  const raw = [
    ...turnTasks.flatMap(t => [t.executorAgentId, t.assigneeAgentId]),
    ...asks.map(r => r.agentId),
    ...events.flatMap(e => [e.agentId, ...panelFromEvent(e)]),
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

const toFactTask = (t: Task, repoIds: Set<string>, sees: (t: Task) => boolean): FactTask => ({
  id: t.id,
  number: t.number,
  title: t.title,
  status: t.status,
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

export async function treeFacts(db: Db, companyId: string, departmentId: string, sees: (t: Task) => boolean): Promise<TreeFacts> {
  const places = await db
    .select({ id: departments.id, repoUrl: departments.repoUrl })
    .from(departments)
    .where(and(eq(departments.companyId, companyId), or(eq(departments.id, departmentId), eq(departments.parentId, departmentId))));
  const repoIds = new Set(places.filter(p => p.repoUrl).map(p => p.id));
  const repository = repoIds.size > 0;

  const [turn] = await db
    .select({ id: turns.id, number: turns.number, createdAt: turns.createdAt, openedAt: turns.openedAt })
    .from(turns)
    .where(and(eq(turns.companyId, companyId), eq(turns.status, 'open')));
  if (!turn) return emptyFacts(repository, null);

  const turnTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, companyId), eq(tasks.turnId, turn.id), eq(tasks.departmentId, departmentId)))
    .orderBy(asc(tasks.createdAt), asc(tasks.number));
  if (!turnTasks.length) return emptyFacts(repository, turn);

  const taskIds = turnTasks.map(t => t.id);
  const extraIds = extraTaskIdsOf(turnTasks, new Set(taskIds));
  const extraTasks = extraIds.length ? await db.select().from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.id, extraIds))) : [];

  const events = await db
    .select({
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

  const signs = await readSigns(db, taskIds, turn.openedAt ?? turn.createdAt);
  const jobStates = await readJobStates(db, taskIds);
  const agentIds = collectAgentIds(turnTasks, events, asks);
  const history = await readTurnHistory(db, companyId, agentIds, turn.openedAt ?? turn.createdAt);
  const agentRows = agentIds.length
    ? await db.select({ id: agents.id, name: agents.name, createdAt: agents.createdAt }).from(agents).where(inArray(agents.id, agentIds)).orderBy(asc(agents.createdAt))
    : [];

  return {
    repository,
    turn,
    agents: agentRows,
    tasks: turnTasks.map(t => toFactTask(t, repoIds, sees)),
    related: extraTasks.map(t => ({ id: t.id, number: t.number, title: t.title, status: t.status, visible: sees(t) })),
    events,
    requests: asks,
    signs,
    jobs: jobStates,
    turns: history,
  };
}
