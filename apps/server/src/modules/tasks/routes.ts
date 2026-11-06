import { turnCounts } from './turn-progress.js';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Text } from './long-text.js';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, type Access } from '../../auth/access.js';
import { viewerOf, type AgentViewer } from '../../auth/agent-view.js';
import { actorOf, requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agentEvents, agents, departments, jobs, requests, tasks, turns } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { orchestratorOf } from '../conversation/queue.js';
import { serverMachine } from '../computer/access.js';
import { deptName } from '../departments/templates.js';
import { departmentNames, visibleDecisions, type Decisions } from './decisions.js';
import { answer, cancel, CLOSED, comment, createTask, refuse, requestSubject, taskSpot, type Task } from './engine.js';
import { setUrgent } from './urgency.js';
import { requireDecision } from '../../auth/decisions.js';
import { delegationOf, lockedFor } from '../conversation/decision-context.js';
import type { DecidedBy } from '../../auth/decisions.js';
import { commitUrl, picturesOf } from './attachments.js';
import { departmentOf } from '../tools/staff.js';
import { workTree } from './tree.js';
import { treeFacts } from './tree-facts.js';
import { departmentPipeline } from './pipeline-report.js';
import { detailFor, factsFor, linesFor, seesTask } from './sight.js';
import { settle, tell, turnRows, type Turn } from './turns.js';
import { leaveIfOff, stopTurns, wakeAll } from './wake.js';

const IdParams = z.object({ id: z.uuid() });
const NewTaskBody = z.object({
  urgent: z.boolean().optional(),
  title: z.string().trim().min(1).max(120),
  brief: z.string().max(600).default(''),
  body: z.string().max(20000).default(''),
  department: z.uuid().optional(),
  product: z.uuid().optional(),
  /* Tasks of the turn, by number, that must be done first. */
  after: z.array(z.number().int().positive()).max(10).optional(),
  independentPart: z.strictObject({ title: z.string().trim().min(1).max(120), brief: z.string().max(600), body: z.string().trim().min(1).max(20000), executor: z.uuid() }).optional(),
  independentNone: z.string().trim().min(1).max(2000).optional(),
});
const ListQuery = z.object({ department: z.uuid().optional(), status: z.enum(['open', 'closed', 'all']).default('open') });
/* person: only the decisions this person owns, among those the viewer sees anyway. */
const DecisionsQuery = z.object({ person: z.uuid().optional() }).strict();
const PipelineQuery = z.object({ turn: z.coerce.number().int().positive().optional() });
const AnswerBody = z.union([
  z.object({ answer: Text.trim().min(1) }).strict(),
  z.object({ approve: z.boolean(), answer: Text.optional() }).strict(),
  z.object({ retry: z.literal(true) }).strict(),
  z.object({ pick: z.number().int().min(0).max(9), answer: Text.trim().optional() }).strict(),
]);

const reaches = (access: Access, t: Pick<Task, 'departmentId' | 'productId'>) => canReach(access, taskSpot(t));

/* The requests among these the orchestrator was asked to put into words, in a turn that waits or runs now. */
async function explainingOf(db: Ctx['db'], companyId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const asked = sql<string>`${agentEvents.data}->>'request'`;
  const rows = await db
    .select({ id: asked })
    .from(agentEvents)
    .innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
    .where(and(eq(agentEvents.companyId, companyId), eq(agentEvents.kind, 'message'), inArray(jobs.status, ['queued', 'running']), inArray(asked, ids)));
  return new Set(rows.map(r => r.id));
}

async function agentNames(db: Ctx['db'], ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  return new Map((await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids))).map(a => [a.id, a.name]));
}

type Places = Awaited<ReturnType<typeof departmentNames>>;

/* Whom people read a decision is for, with the department's name. */
function decidedByView(d: DecidedBy, places: Places) {
  const place = d.departmentId ? places.get(d.departmentId) : undefined;
  return { kind: d.kind, department: place ? { id: place.id, name: deptName(place) } : null };
}

/* The departments the cards are for and the requests' departments decide. */
function placesOf(cards: Decisions['proposals'], mine: Decisions['requests']): string[] {
  const ids = [...cards.map(c => c.proposal.departmentId), ...mine.map(r => r.decidedBy.departmentId)];
  return ids.filter((id): id is string => id !== null);
}

/* A decision this person may take on work they do not see: what is asked of them, the ways to answer and the pictures shown
   with it. This is the whole of it, written out field by field, so nothing of the task or the agent comes along: the right
   to answer is no right to read the work. */
function addressedView({ request: r, ownerPersonId, canAnswer, decidedBy }: Decisions['requests'][number], images: string[], places: Places) {
  return {
    id: r.id,
    kind: r.kind,
    text: r.text,
    options: r.options,
    commit: r.commit,
    approval: r.approvalChannel ? { channel: r.approvalChannel, kind: r.approvalKind, amount: r.approvalAmount } : null,
    images,
    at: r.createdAt.toISOString(),
    ownerPersonId,
    canAnswer,
    decidedBy: decidedByView(decidedBy, places),
  };
}

/* An orchestrator's pending card, answered with its own build or staff click. */
function proposalView({ proposal: p, ownerPersonId, canAnswer, decidedBy }: Decisions['proposals'][number], names: Map<string, string>, places: Places) {
  const place = p.departmentId ? places.get(p.departmentId) : undefined;
  return {
    id: p.id,
    kind: p.kind,
    agent: { id: p.agentId, name: names.get(p.agentId) ?? '' },
    department: place ? { id: place.id, name: deptName(place) } : null,
    brief: p.brief,
    items: Array.isArray(p.items) ? p.items : [],
    at: p.createdAt.toISOString(),
    ownerPersonId,
    canAnswer,
    decidedBy: decidedByView(decidedBy, places),
  };
}

/* What the computer card shows, with the orchestrator's request; open and decline stay on /api/computer. */
async function computerView(ctx: Ctx, companyId: string, computer: NonNullable<Decisions['computer']>, names: Map<string, string>) {
  return {
    kind: 'computer_access' as const,
    id: 'server' as const,
    agent: { id: computer.agentId, name: names.get(computer.agentId) ?? '' },
    ownerPersonId: computer.ownerPersonId,
    canAnswer: computer.canAnswer,
    decidedBy: decidedByView(computer.decidedBy, new Map()),
    at: computer.asked.at,
    view: { ...ctx.computer.view(), asked: computer.asked, machine: await serverMachine(ctx, companyId), canAnswer: computer.canAnswer },
  };
}

/* The task a turn's work hangs under, for someone who sees it. */
async function turnTask(db: Db, turn: Turn, viewer: AgentViewer): Promise<string | null> {
  if (viewer.full || !turn.taskId) return turn.taskId;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, turn.taskId));
  return task && seesTask(viewer, task) ? task.id : null;
}

/* Turns belong to the whole company. The words they were laid out from only reach people with the full view. */
async function turnView(db: Db, turn: Turn | undefined, viewer: AgentViewer) {
  if (!turn) return null;
  return {
    id: turn.id,
    number: turn.number,
    title: turn.title || turn.goal,
    goal: turn.goal,
    status: turn.status,
    messages: viewer.full ? turn.messages.map(({ by, text, at }) => ({ by, text, at })) : [],
    taskId: await turnTask(db, turn, viewer),
    startedAt: (turn.openedAt ?? turn.createdAt).toISOString(),
    openedAt: turn.openedAt?.toISOString() ?? null,
    closedAt: turn.closedAt?.toISOString() ?? null,
    tasks: await turnCounts(db, turn, viewer),
  };
}

/* Tasks, what waits for people, and turns, as each person may see them: the work of the agents they see, in places they
   reach (sight.ts). */
export function taskRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  /* A task of the company this person sees: 404 for one that is not there, 403 for one they do not see. */
  async function shown(me: Person, id: string): Promise<Task> {
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.companyId, me.companyId)));
    if (!task) throw refuse(404, 'task_unknown', 'This task does not exist.');
    if (!seesTask(await viewerOf(db, me), task)) throw refuse(403, 'task_hidden', 'This task is not work of an employee you see.');
    return task;
  }

  /* The task as this person reads it. */
  const detail = async (me: Person, task: Task) => detailFor(ctx, await viewerOf(db, me), task);

  app.get('/api/tasks', async req => {
    const me = await requirePerson(req, db);
    const q = ListQuery.parse(req.query);
    const viewer = await viewerOf(db, me);
    const page = (state: SQL) =>
      db
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, me.companyId), state, q.department ? eq(tasks.departmentId, q.department) : undefined))
        .orderBy(desc(tasks.number))
        .limit(500);
    /* All of them: every open one stays even under many closed ones, the newest closed ones come with them. */
    const open = q.status === 'closed' ? [] : await page(notInArray(tasks.status, [...CLOSED]));
    const closed = q.status === 'open' ? [] : await page(inArray(tasks.status, [...CLOSED]));
    const rows = [...open, ...closed].sort((a, b) => b.number - a.number);
    return { tasks: await linesFor(ctx, viewer, rows.filter(t => seesTask(viewer, t))) };
  });

  app.get('/api/tasks/:id', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    return { task: await detail(me, await shown(me, id)) };
  });

  /* Without a department the task goes to the orchestrator; with one, to its head. */
  app.post('/api/tasks', async (req, reply) => {
    const me = await requirePerson(req, db);
    const body = NewTaskBody.parse(req.body);
    let assignee: { id: string } | null;
    if (!body.department) {
      requireCompanyScope(me);
      assignee = await orchestratorOf(ctx, me.companyId);
      if (!assignee) throw refuse(409, 'no_head', 'This company has no orchestrator.');
    } else {
      const [dept] = await db.select().from(departments).where(and(eq(departments.id, body.department), eq(departments.companyId, me.companyId)));
      if (!dept || dept.parentId || !canReach(await accessOf(db, me), { departmentId: dept.id })) throw refuse(404, 'department_unknown', 'This department does not exist.');
      if (body.product) {
        const [product] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, body.product), eq(departments.parentId, dept.id)));
        if (!product) throw refuse(404, 'department_unknown', 'This product does not exist.');
      }
      [assignee] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.departmentId, dept.id), eq(agents.kind, 'head'), isNull(agents.removedAt))).orderBy(asc(agents.createdAt));
      if (!assignee) throw refuse(409, 'no_head', 'This department has no head yet. Hire one first.');
    }
    /* A task the person does not see is no task to come after, as for anything else they name. */
    const viewer = await viewerOf(db, me);
    const after = body.after?.length ? (await db.select().from(tasks).where(and(eq(tasks.companyId, me.companyId), inArray(tasks.number, body.after)))).filter(t => seesTask(viewer, t)) : [];
    const missing = (body.after ?? []).find(n => !after.some(t => t.number === n));
    if (missing !== undefined) throw refuse(400, 'task_invalid', `There is no task #${missing} to come after.`);
    const moved = await createTask(ctx, actorOf(me), { title: body.title, brief: body.brief, body: body.body, departmentId: body.department ?? null, productId: body.product ?? null, assigneeAgentId: assignee.id, urgent: body.urgent, after: (body.after ?? []).map(n => after.find(t => t.number === n)!.id), independentPart: body.independentPart, independentNone: body.independentNone });
    await wakeAll(ctx, moved.wakes);
    return reply.code(201).send({ task: await detail(me, moved.task) });
  });

  app.post('/api/tasks/:id/comments', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const { text } = z.object({ text: Text.trim().min(1) }).parse(req.body);
    const moved = await comment(ctx, actorOf(me), (await shown(me, id)).id, text);
    await wakeAll(ctx, moved.wakes);
    return reply.code(201).send({ task: await detail(me, moved.task) });
  });

  /* Only the CEO or the CEO delegate says so, as the engine checks. */
  app.put('/api/tasks/:id/urgent', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const { urgent } = z.object({ urgent: z.boolean() }).strict().parse(req.body);
    const moved = await setUrgent(ctx, actorOf(me), (await shown(me, id)).id, urgent);
    return { task: await detail(me, moved.task) };
  });

  app.post('/api/tasks/:id/cancel', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const { why } = z.object({ why: z.string().max(1000).default('') }).parse(req.body ?? {});
    const moved = await cancel(ctx, actorOf(me), (await shown(me, id)).id, why);
    await stopTurns(ctx, moved.closed);
    const settled = await settle(ctx, moved.task);
    await wakeAll(ctx, tell(moved.wakes, settled, (await orchestratorOf(ctx, me.companyId))?.id ?? null, moved.task.id));
    return { task: await detail(me, moved.task) };
  });

  app.get('/api/requests', async req => {
    const me = await requirePerson(req, db);
    const { person } = DecisionsQuery.parse(req.query);
    const viewer = await viewerOf(db, me);
    /* Counts come from everything the person sees; the filter only picks what the lists show. */
    const decisions = await visibleDecisions(ctx, me);
    const picked = (owner: string) => !person || owner === person;
    const shown = decisions.requests.filter(r => picked(r.ownerPersonId));
    const mine = shown.filter(r => r.known);
    const lines = await linesFor(ctx, viewer, mine.map(r => r.task));
    const cards = decisions.proposals.filter(p => picked(p.ownerPersonId));
    const computer = decisions.computer && picked(decisions.computer.ownerPersonId) ? decisions.computer : null;
    const names = await agentNames(db, [...mine.map(r => r.request.agentId), ...cards.map(c => c.proposal.agentId), ...(computer ? [computer.agentId] : [])]);
    const places = await departmentNames(ctx, placesOf(cards, shown));
    const pictures = await picturesOf(db, shown.map(r => r.request));
    const commits = await Promise.all(mine.map(r => commitUrl(db, r.task, r.request.commit)));
    const explaining = await explainingOf(db, me.companyId, mine.filter(r => !r.request.explained).map(r => r.request.id));
    return {
      requests: mine.map((r, i) => ({
        id: r.request.id,
        kind: r.request.kind,
        text: r.request.text,
        commit: r.request.commit,
        commitUrl: commits[i],
        images: pictures.get(r.request.id) ?? [],
        options: r.request.options,
        link: r.request.link,
        explained: r.request.explained,
        explaining: explaining.has(r.request.id),
        at: r.request.createdAt.toISOString(),
        agent: { id: r.request.agentId, name: names.get(r.request.agentId) ?? '' },
        task: { id: lines[i]!.id, number: lines[i]!.number, title: lines[i]!.title, department: lines[i]!.department },
        ownerPersonId: r.ownerPersonId,
        canAnswer: r.canAnswer,
        decidedBy: decidedByView(r.decidedBy, places),
      })),
      addressed: shown.filter(r => !r.known).map(r => addressedView(r, pictures.get(r.request.id) ?? [], places)),
      proposals: cards.map(c => proposalView(c, names, places)),
      computerAccess: computer && (await computerView(ctx, me.companyId, computer, names)),
      counts: decisions.counts,
    };
  });

  app.post('/api/requests/:id', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const body = AnswerBody.parse(req.body);
    const [found] = await db.select().from(requests).where(and(eq(requests.id, id), eq(requests.companyId, me.companyId)));
    if (!found) throw refuse(404, 'request_unknown', 'There is no such request.');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, found.taskId));
    if (!task) throw refuse(404, 'request_unknown', 'There is no such request.');
    /* The orchestrator answers only for the person its turn answers, under its input lock, checked again as it is kept. */
    const on = delegationOf(me);
    requireDecision(requestSubject(found, task), me, await accessOf(db, me), me.companyId);
    const done = await lockedFor(ctx, on, () => answer(ctx, actorOf(me), id, body, on));
    await wakeAll(ctx, done.wakes);
    /* An agent switched off while it waited for this answer leaves the work now. */
    await leaveIfOff(ctx, done.request.agentId);
    return { request: { id: done.request.id, status: done.request.status, picked: done.request.picked, answer: done.request.answer } };
  });

  /* The orchestrator puts what an employee asks into plain words for the people who answer it. */
  app.post('/api/requests/:id/explained', async req => {
    const me = await requirePerson(req, db);
    if (!me.via) throw new ApiError(403, 'forbidden', 'Only the orchestrator puts a request into words for people. Answer it instead.', 'orchestrator_only');
    const { id } = IdParams.parse(req.params);
    const { text } = z.object({ text: z.string().trim().min(1).max(3000) }).parse(req.body);
    const [row] = await db
      .update(requests)
      .set({ explained: text })
      .where(and(eq(requests.id, id), eq(requests.companyId, me.companyId), eq(requests.status, 'open')))
      .returning();
    if (!row) throw refuse(404, 'request_unknown', 'There is no such open request.');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, row.taskId));
    ctx.bus.publish(me.companyId, { type: 'requests', spot: taskSpot(task!) });
    return { request: { id: row.id, explained: row.explained } };
  });

  app.get('/api/turns', async req => {
    const me = await requirePerson(req, db);
    const viewer = await viewerOf(db, me);
    return { turns: await Promise.all((await turnRows(ctx, me.companyId)).map(t => turnView(db, t, viewer))) };
  });

  app.get('/api/turns/current', async req => {
    const me = await requirePerson(req, db);
    const [turn] = await db.select().from(turns).where(and(eq(turns.companyId, me.companyId), eq(turns.status, 'open')));
    return { turn: await turnView(db, turn, await viewerOf(db, me)) };
  });

  app.get('/api/departments/:id/tree', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const dept = await departmentOf(db, me.companyId, id);
    if (!dept) throw refuse(404, 'department_unknown', 'This department does not exist.');
    const viewer = await viewerOf(db, me);
    if (!canReach(viewer.access, { departmentId: dept.id, parentId: null })) {
      const spots = await db
        .selectDistinct({ departmentId: tasks.departmentId, productId: tasks.productId })
        .from(tasks)
        .where(and(eq(tasks.companyId, me.companyId), eq(tasks.departmentId, dept.id)));
      if (!spots.some(t => reaches(viewer.access, t))) throw refuse(403, 'not_your_department', 'This department is not one you have.');
    }
    const facts = await treeFacts(db, me.companyId, dept.id, t => seesTask(viewer, t));
    return { tree: workTree(factsFor(viewer, facts), new Date()) };
  });

  /* The numbers add up all of a department, its agents' work whoever's plan they are on, so they go only with the full view. */
  app.get('/api/departments/:id/pipeline', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const { turn } = PipelineQuery.parse(req.query);
    const dept = await departmentOf(db, me.companyId, id);
    if (!dept || dept.parentId) throw refuse(404, 'department_unknown', 'This department does not exist.');
    if (!(await viewerOf(db, me)).full) throw refuse(403, 'ceo_view_only', 'Only the CEO and the CEO delegate read the numbers of a whole department.');
    return { report: await departmentPipeline(db, me.companyId, dept.id, turn) };
  });
}
