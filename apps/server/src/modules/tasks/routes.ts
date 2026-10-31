import { and, asc, count, desc, eq, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, type Access } from '../../auth/access.js';
import { actorOf, requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import { agentEvents, agents, departments, jobs, requests, tasks, turns } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { orchestratorOf } from '../conversation/queue.js';
import { answer, cancel, CLOSED, comment, createTask, refuse, taskSpot, type Task } from './engine.js';
import { commitUrl, picturesOf } from './attachments.js';
import { taskDetail, taskLines } from './views.js';
import { settle, tell, turnRows, type Turn } from './turns.js';
import { leaveIfOff, stopTurns, wakeAll } from './wake.js';

const IdParams = z.object({ id: z.uuid() });
const NewTaskBody = z.object({
  title: z.string().trim().min(1).max(120),
  brief: z.string().max(600).default(''),
  body: z.string().max(20000).default(''),
  department: z.uuid().optional(),
  product: z.uuid().optional(),
});
const ListQuery = z.object({ department: z.uuid().optional(), status: z.enum(['open', 'closed', 'all']).default('open') });
const AnswerBody = z.union([
  z.object({ answer: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ approve: z.boolean(), answer: z.string().max(4000).optional() }).strict(),
  z.object({ retry: z.literal(true) }).strict(),
  z.object({ pick: z.number().int().min(0).max(9), answer: z.string().trim().max(4000).optional() }).strict(),
]);

const reaches = (access: Access, t: Pick<Task, 'departmentId' | 'productId'>) => canReach(access, taskSpot(t));

/* Tasks, what waits for people, and turns, as each person may see them: the departments they reach, and the
   orchestrator's tasks and turns for people with the whole company. */
export function taskRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  async function reachable(me: Person, id: string): Promise<Task> {
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.companyId, me.companyId)));
    if (!task || !reaches(await accessOf(db, me), task)) throw refuse(404, 'task_unknown', 'This task does not exist.');
    return task;
  }

  /* The task as this person reads it. */
  async function detail(me: Person, task: Task) {
    const access = await accessOf(db, me);
    return taskDetail(ctx, task, t => reaches(access, t));
  }

  app.get('/api/tasks', async req => {
    const me = await requirePerson(req, db);
    const q = ListQuery.parse(req.query);
    const access = await accessOf(db, me);
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
    return { tasks: await taskLines(ctx, rows.filter(t => reaches(access, t))) };
  });

  app.get('/api/tasks/:id', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    return { task: await detail(me, await reachable(me, id)) };
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
    const moved = await createTask(ctx, actorOf(me), { title: body.title, brief: body.brief, body: body.body, departmentId: body.department ?? null, productId: body.product ?? null, assigneeAgentId: assignee.id });
    await wakeAll(ctx, moved.wakes);
    return reply.code(201).send({ task: await detail(me, moved.task) });
  });

  app.post('/api/tasks/:id/comments', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
    const moved = await comment(ctx, actorOf(me), (await reachable(me, id)).id, text);
    await wakeAll(ctx, moved.wakes);
    return reply.code(201).send({ task: await detail(me, moved.task) });
  });

  app.post('/api/tasks/:id/cancel', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const { why } = z.object({ why: z.string().max(1000).default('') }).parse(req.body ?? {});
    const moved = await cancel(ctx, actorOf(me), (await reachable(me, id)).id, why);
    await stopTurns(ctx, moved.closed);
    const settled = await settle(ctx, moved.task);
    await wakeAll(ctx, tell(moved.wakes, settled, (await orchestratorOf(ctx, me.companyId))?.id ?? null, moved.task.id));
    return { task: await detail(me, moved.task) };
  });

  app.get('/api/requests', async req => {
    const me = await requirePerson(req, db);
    const access = await accessOf(db, me);
    const rows = await db
      .select({ request: requests, task: tasks })
      .from(requests)
      .innerJoin(tasks, eq(tasks.id, requests.taskId))
      .where(and(eq(requests.companyId, me.companyId), eq(requests.status, 'open')))
      .orderBy(asc(requests.createdAt));
    const mine = rows.filter(r => reaches(access, r.task));
    const lines = await taskLines(
      ctx,
      mine.map(r => r.task),
    );
    const names = new Map((mine.length ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, mine.map(r => r.request.agentId))) : []).map(a => [a.id, a.name]));
    const pictures = await picturesOf(db, mine.map(r => r.request));
    const commits = await Promise.all(mine.map(r => commitUrl(db, r.task, r.request.commit)));
    /* Requests the orchestrator was asked to put into words, in a turn that waits or runs now. */
    const unexplained = mine.filter(r => !r.request.explained).map(r => r.request.id);
    const asked = sql<string>`${agentEvents.data}->>'request'`;
    const explaining = new Set(
      unexplained.length
        ? (
            await db
              .select({ id: asked })
              .from(agentEvents)
              .innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
              .where(and(eq(agentEvents.companyId, me.companyId), eq(agentEvents.kind, 'message'), inArray(jobs.status, ['queued', 'running']), inArray(asked, unexplained)))
          ).map(r => r.id)
        : [],
    );
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
      })),
    };
  });

  app.post('/api/requests/:id', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const body = AnswerBody.parse(req.body);
    const [found] = await db.select({ taskId: requests.taskId, kind: requests.kind }).from(requests).where(and(eq(requests.id, id), eq(requests.companyId, me.companyId)));
    if (!found) throw refuse(404, 'request_unknown', 'There is no such request.');
    await reachable(me, found.taskId).catch(() => {
      throw refuse(404, 'request_unknown', 'There is no such request.');
    });
    /* The people of the department see a commit waiting for approval; only someone who sees the whole company lets it into main. */
    if (found.kind === 'approval') requireCompanyScope(me);
    const done = await answer(ctx, actorOf(me), id, body);
    await wakeAll(ctx, done.wakes);
    /* An agent switched off while it waited for this answer leaves the work now. */
    await leaveIfOff(ctx, done.request.agentId);
    return { request: { id: done.request.id, status: done.request.status } };
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

  /* Turns belong to the whole company. The words they were laid out from only reach people who see all of it. */
  async function turnView(turn: Turn | undefined, whole: boolean) {
    if (!turn) return null;
    const [all] = await db.select({ n: count() }).from(tasks).where(eq(tasks.turnId, turn.id));
    const [done] = await db.select({ n: count() }).from(tasks).where(and(eq(tasks.turnId, turn.id), eq(tasks.status, 'done')));
    return {
      id: turn.id,
      number: turn.number,
      title: turn.title || turn.goal,
      goal: turn.goal,
      status: turn.status,
      messages: whole ? turn.messages.map(({ by, text, at }) => ({ by, text, at })) : [],
      taskId: turn.taskId,
      startedAt: (turn.openedAt ?? turn.createdAt).toISOString(),
      openedAt: turn.openedAt?.toISOString() ?? null,
      closedAt: turn.closedAt?.toISOString() ?? null,
      tasks: { total: Number(all?.n ?? 0), done: Number(done?.n ?? 0) },
    };
  }

  app.get('/api/turns', async req => {
    const me = await requirePerson(req, db);
    const whole = me.scopeKind === 'company';
    return { turns: await Promise.all((await turnRows(ctx, me.companyId)).map(t => turnView(t, whole))) };
  });

  app.get('/api/turns/current', async req => {
    const me = await requirePerson(req, db);
    const [turn] = await db.select().from(turns).where(and(eq(turns.companyId, me.companyId), eq(turns.status, 'open')));
    return { turn: await turnView(turn, me.scopeKind === 'company') };
  });
}
