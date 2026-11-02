import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, people, requests, taskEvents, tasks, turns, type RequestOption } from '../../db/schema.js';
import { commitUrl, filesOf, picturesOf } from './attachments.js';
import { deptName } from '../departments/templates.js';
import type { Lang } from '../templates/load.js';
import { CLOSED, type Task } from './engine.js';

export type AgentRef = { id: string; name: string; kind: 'orchestrator' | 'head' | 'worker'; role: Lang | null };
type Place = { id: string; name: string } | null;
export type TaskLine = {
  id: string;
  number: number;
  title: string;
  brief: string;
  status: Task['status'];
  department: Place;
  product: Place;
  assignee: AgentRef | null;
  stage: number;
  gateCount: number;
  /* It passed its gates and its executor merges it. */
  merging: boolean;
  bounces: number;
  turn: number | null;
  parentId: string | null;
  /* The numbers of the tasks it comes after that are not done yet: until they are, it waits. */
  waitsFor: number[];
  createdAt: string;
  updatedAt: string;
};
/* In the review of a turn, returned: a reviewer who found what blocks; skipped: one who did not check it, for want of a
   subscription or having left it. */
export type GateView = AgentRef & { state: 'passed' | 'current' | 'next' | 'returned' | 'skipped' };
export type LogLine = { kind: string; text: string; data: unknown; by: { kind: 'person' | 'agent'; id: string; name: string } | null; at: string };
/* images: the pictures the agent showed, commitUrl: where its commit can be seen, picked: the way a person took in a choice. */
export type RequestView = {
  id: string;
  kind: (typeof requests.$inferSelect)['kind'];
  text: string;
  commit: string | null;
  commitUrl: string | null;
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
export type FileView = { id: string; name: string; size: number; by: { id: string; name: string } | null; at: string };
export type TaskDetail = TaskLine & {
  body: string;
  parent: { id: string; number: number; title: string } | null;
  after: AfterView[];
  executor: AgentRef | null;
  gates: GateView[];
  /* A review of a department's turn: every reviewer checks at once, and the head who gets the verdicts did no work. */
  turnReview: boolean;
  createdBy: { kind: 'person' | 'agent'; id: string; name: string } | null;
  subtasks: TaskLine[];
  log: LogLine[];
  requests: RequestView[];
  files: FileView[];
};

type Names = { agent(id: string | null): AgentRef | null; place(id: string | null): Place; turn(id: string | null): number | null; after(t: Pick<Task, 'after'>): Task[] };

/* Names for everything the tasks point at, read in one go. */
async function names(ctx: Pick<Ctx, 'db' | 'templates'>, rows: Pick<Task, 'assigneeAgentId' | 'executorAgentId' | 'gates' | 'departmentId' | 'productId' | 'turnId' | 'createdByAgentId' | 'after'>[], more: string[] = []): Promise<Names> {
  const agentIds = [...new Set([...rows.flatMap(t => [t.assigneeAgentId, t.executorAgentId, t.createdByAgentId, ...t.gates]), ...more].filter((x): x is string => Boolean(x)))];
  const placeIds = [...new Set(rows.flatMap(t => [t.departmentId, t.productId]).filter((x): x is string => Boolean(x)))];
  const turnIds = [...new Set(rows.map(t => t.turnId).filter((x): x is string => Boolean(x)))];
  const agentRows = agentIds.length ? await ctx.db.select({ id: agents.id, name: agents.name, kind: agents.kind, roleKey: agents.roleKey }).from(agents).where(inArray(agents.id, agentIds)) : [];
  const placeRows = placeIds.length ? await ctx.db.select().from(departments).where(inArray(departments.id, placeIds)) : [];
  const turnRows = turnIds.length ? await ctx.db.select({ id: turns.id, number: turns.number }).from(turns).where(inArray(turns.id, turnIds)) : [];
  const afterIds = [...new Set(rows.flatMap(t => t.after))];
  const afterRows = afterIds.length ? await ctx.db.select().from(tasks).where(inArray(tasks.id, afterIds)) : [];
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
  };
}

/* sees: who reads it may see that task, so the line names what it waits for only of those. */
const line = (t: Task, n: Names, sees: (t: Task) => boolean): TaskLine => ({
  id: t.id,
  number: t.number,
  title: t.title,
  brief: t.brief,
  status: t.status,
  department: n.place(t.departmentId),
  product: n.place(t.productId),
  assignee: n.agent(t.assigneeAgentId),
  stage: t.stage,
  gateCount: t.gates.length,
  merging: t.merging,
  bounces: t.bounces,
  turn: n.turn(t.turnId),
  parentId: t.parentId,
  waitsFor: n.after(t).filter(a => a.status !== 'done' && sees(a)).map(a => a.number),
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export async function taskLines(ctx: Pick<Ctx, 'db' | 'templates'>, rows: Task[], sees: (t: Task) => boolean): Promise<TaskLine[]> {
  const n = await names(ctx, rows);
  return rows.map(t => line(t, n, sees));
}

const LOG_SHOWN = 200;

/* One task as people and agents read it: the body, its gates with where it stands, what it was split into, and its log.
   The task it serves and the tasks under it show only when the reader may see them too. */
export async function taskDetail(ctx: Pick<Ctx, 'db' | 'templates'>, task: Task, sees: (t: Task) => boolean): Promise<TaskDetail> {
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
  const files = await filesOf(db, task.id);
  /* The review of a turn names everyone who checks it as it opens, and each one's verdict says where they stand. */
  const [made] = await db.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'created'))).limit(1);
  const reviewers = made?.data.turnReview === true && Array.isArray(made.data.panel) ? [...(made.data.panel as string[]), ...((made.data.unable as string[] | undefined) ?? [])] : null;
  const verdicts = reviewers ? await db.select({ agentId: taskEvents.agentId, data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict'))) : [];
  const [creator] = task.createdByPersonId ? await db.select({ id: people.id, name: people.name }).from(people).where(eq(people.id, task.createdByPersonId)) : [];
  const n = await names(ctx, [task, ...subs], [...(reviewers ?? []), ...events.map(e => e.agentId), ...asks.map(r => r.agentId), ...files.map(f => f.agentId)].filter((x): x is string => Boolean(x)));
  /* Only what this reader may see of what the task comes after. */
  const after = n.after(task).filter(sees);
  const by = (personId: string | null, personName: string | null, agentId: string | null): LogLine['by'] =>
    personId ? { kind: 'person', id: personId, name: personName ?? '' } : agentId ? { kind: 'agent', id: agentId, name: n.agent(agentId)?.name ?? '' } : null;
  return {
    ...line(task, n, sees),
    body: task.body,
    parent,
    after: after.map(a => ({ id: a.id, number: a.number, title: a.title, status: a.status })),
    executor: n.agent(task.executorAgentId),
    gates: reviewers
      ? reviewers.flatMap(id => {
          const a = n.agent(id);
          const given = verdicts.find(v => v.agentId === id);
          if (!a) return [];
          return [{ ...a, state: given ? (given.data.pass === true ? 'passed' : 'returned') : CLOSED.includes(task.status) || !task.panel.includes(id) ? 'skipped' : 'current' }];
        })
      : task.gates.flatMap((id, i) => {
          const a = n.agent(id);
          if (!a) return [];
          const at = i + 1;
          return [{ ...a, state: task.status === 'done' || task.merging || at < task.stage ? 'passed' : at === task.stage && !['cancelled'].includes(task.status) ? 'current' : 'next' }];
        }),
    turnReview: reviewers !== null,
    createdBy: creator ? { kind: 'person', ...creator } : task.createdByAgentId ? { kind: 'agent', id: task.createdByAgentId, name: n.agent(task.createdByAgentId)?.name ?? '' } : null,
    subtasks: subs.map(t => line(t, n, sees)),
    log: events.reverse().map(e => ({ kind: e.kind, text: e.text, data: e.data, by: by(e.personId, e.personName, e.agentId), at: e.at.toISOString() })),
    requests: asks.map((r, i) => ({
      id: r.id,
      kind: r.kind,
      text: r.text,
      commit: r.commit,
      commitUrl: commits[i]!,
      images: pictures.get(r.id) ?? [],
      options: r.options,
      link: r.link,
      picked: r.picked,
      status: r.status,
      answer: r.answer,
      agent: n.agent(r.agentId),
      at: r.createdAt.toISOString(),
    })),
    files: files.map(f => {
      const a = n.agent(f.agentId);
      return { id: f.id, name: f.name, size: f.size, by: a && { id: a.id, name: a.name }, at: f.at.toISOString() };
    }),
  };
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
