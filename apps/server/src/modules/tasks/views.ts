import { findingReport } from './review-findings.js';
import type { EchelonsSnapshot, EchelonFindingsView } from '@hornhoof/protocol/echelons';
import { routeSnapshots } from './echelons-store.js';
import type { TaskWaitView } from '@hornhoof/protocol/waits';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, people, requests, taskEvents, tasks, turns, type AgentKind, type RequestOption } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { commitUrl, filesOf, picturesOf } from './attachments.js';
import { deptName } from '../departments/templates.js';
import { commitProof, type CommitProof } from '../testruns/commit-proof.js';
import { taskEvidence, type RunEvidence } from '../testruns/evidence.js';
import type { Lang } from '../templates/load.js';
import { type Task } from './engine.js';
import { independentViews, type IndependentPartInput, type IndependentRecord } from './independent.js';
import type { TaskWait } from './wait-state.js';
import { openWaitsOf, shownWaits } from './wait-views.js';
import { offlineMachine, type OfflineMachine } from '../nodes/offline.js';

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
  small: boolean;
  createdAt: string;
  updatedAt: string;
};
/* for: the person the orchestrator acted for, as in a request it answered for them. */
export type LogLine = { kind: string; text: string; data: unknown; by: { kind: 'person' | 'agent'; id: string; name: string; for?: { id: string; name: string } } | null; at: string };
/* images: the pictures the agent showed, commitUrl: where its commit can be seen, proof: what test runs say of that very
   commit, picked: the way a person took in a choice. */
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
  executor: AgentRef | null;
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

type Names = {
  route(t: Task): EchelonsSnapshot;
  agent(id: string | null): AgentRef | null;
  place(id: string | null): Place;
  turn(id: string | null): number | null;
  after(t: Pick<Task, 'after'>): Task[];
  independent(t: Pick<Task, 'id'>): IndependentRecord | undefined;
  waits(t: Pick<Task, 'id'>): TaskWait[];
};

/* Names for everything the tasks point at, read in one go. */
async function names(ctx: Pick<Ctx, 'db' | 'templates'>, rows: Pick<Task, 'companyId' | 'id' | 'assigneeAgentId' | 'executorAgentId' | 'departmentId' | 'productId' | 'turnId' | 'createdByAgentId' | 'after'>[], more: string[] = []): Promise<Names> {
  const independent = await independentViews(ctx.db, rows.map(t => t.id));
  const partExecutors = [...independent.values()].flatMap(record => record.kind === 'part' ? [record.part.executor] : []);
  const agentIds = [...new Set([...rows.flatMap(t => [t.assigneeAgentId, t.executorAgentId, t.createdByAgentId]), ...partExecutors, ...more].filter((x): x is string => Boolean(x)))];
  const placeIds = [...new Set(rows.flatMap(t => [t.departmentId, t.productId]).filter((x): x is string => Boolean(x)))];
  const turnIds = [...new Set(rows.map(t => t.turnId).filter((x): x is string => Boolean(x)))];
  const agentRows = agentIds.length ? await ctx.db.select({ id: agents.id, name: agents.name, kind: agents.kind, roleKey: agents.roleKey }).from(agents).where(inArray(agents.id, agentIds)) : [];
  const placeRows = placeIds.length ? await ctx.db.select().from(departments).where(inArray(departments.id, placeIds)) : [];
  const turnRows = turnIds.length ? await ctx.db.select({ id: turns.id, number: turns.number }).from(turns).where(inArray(turns.id, turnIds)) : [];
  const afterIds = [...new Set(rows.flatMap(t => t.after))];
  const afterRows = afterIds.length ? await ctx.db.select().from(tasks).where(inArray(tasks.id, afterIds)) : [];
  const waits = await openWaitsOf(ctx.db, rows.map(t => t.id));
  const routes = await routeSnapshots(ctx.db, rows);
  return { ...nameLookups(ctx, { agentRows, placeRows, turnRows, afterRows }, independent, waits), route: t => routes.get(t.id)! };
}

type NamedRows = {
  agentRows: Pick<typeof agents.$inferSelect, 'id' | 'name' | 'kind' | 'roleKey'>[];
  placeRows: (typeof departments.$inferSelect)[];
  turnRows: Pick<typeof turns.$inferSelect, 'id' | 'number'>[];
  afterRows: Task[];
};

function nameLookups(ctx: Pick<Ctx, 'templates'>, { agentRows, placeRows, turnRows, afterRows }: NamedRows, independent: Map<string, IndependentRecord>, waits: Map<string, TaskWait[]>): Omit<Names, 'route'> {
  return {
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
  small: t.small,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export async function taskLines(ctx: Pick<Ctx, 'db' | 'templates'>, rows: Task[], sees: (t: Task) => boolean): Promise<TaskLine[]> {
  const n = await names(ctx, rows);
  return rows.map(t => line(t, n, sees));
}

const LOG_SHOWN = 200;

/* The people the orchestrator acted for in these events, by id. */
async function forWhom(db: Ctx['db'], data: Record<string, unknown>[]): Promise<Map<string, { id: string; name: string }>> {
  const ids = [...new Set(data.flatMap(d => (typeof d.onBehalfOfPersonId === 'string' ? [d.onBehalfOfPersonId] : [])))];
  if (!ids.length) return new Map();
  return new Map((await db.select({ id: people.id, name: people.name }).from(people).where(inArray(people.id, ids))).map(p => [p.id, p]));
}

/* Who wrote a line of the log: a person, or an agent with the person it acted for. */
function byOf(n: Names, actedFor: Map<string, { id: string; name: string }>) {
  return (personId: string | null, personName: string | null, agentId: string | null, data: Record<string, unknown>): LogLine['by'] => {
    if (personId) return { kind: 'person', id: personId, name: personName ?? '' };
    if (!agentId) return null;
    const whom = typeof data.onBehalfOfPersonId === 'string' ? actedFor.get(data.onBehalfOfPersonId) : undefined;
    return { kind: 'agent', id: agentId, name: n.agent(agentId)?.name ?? '', ...(whom ? { for: whom } : {}) };
  };
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
  const n = await names(ctx, [task, ...subs], [...events.map(e => e.agentId), ...asks.map(r => r.agentId), ...files.map(f => f.agentId)].filter((x): x is string => Boolean(x)));
  /* Only what this reader may see of what the task comes after. */
  const after = n.after(task).filter(sees);
  const by = byOf(n, await forWhom(db, events.map(e => e.data)));
  return {
    ...line(task, n, sees),
    echelonFindings: await findingReport(db, [task.id]),
    body: task.body,
    parent,
    after: after.map(a => ({ id: a.id, number: a.number, title: a.title, status: a.status })),
    executor: n.agent(task.executorAgentId),
    createdBy: creator ? { kind: 'person', ...creator } : task.createdByAgentId ? { kind: 'agent', id: task.createdByAgentId, name: n.agent(task.createdByAgentId)?.name ?? '' } : null,
    subtasks: subs.map(t => line(t, n, sees)),
    log: events.reverse().map(e => ({ kind: e.kind, text: e.text, data: e.data, by: by(e.personId, e.personName, e.agentId, e.data), at: e.at.toISOString() })),
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

/* The task a reference names in the company: its number (12 or "#12") or its id. */
export async function taskByRef(ctx: Pick<Ctx, 'db'>, companyId: string, ref: number | string): Promise<Task | null> {
  const number = typeof ref === 'number' ? ref : /^#?\d+$/.test(ref) ? Number(ref.replace('#', '')) : null;
  if (number === null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(ref))) return null;
  const [task] = await ctx.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, companyId), number !== null ? eq(tasks.number, number) : eq(tasks.id, String(ref))));
  return task ?? null;
}
