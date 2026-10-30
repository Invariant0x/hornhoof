import { and, asc, count, desc, eq, inArray, max, notInArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, type Access } from '../../auth/access.js';
import { requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import { agents, departments, requests, tasks, turns } from '../../db/schema.js';
import { orchestratorOf } from '../conversation/queue.js';
import { answer, cancel, CLOSED, comment, createTask, refuse, taskSpot, type Task } from './engine.js';
import { taskDetail, taskLines } from './views.js';
import { wakeAll } from './wake.js';

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

  app.get('/api/tasks', async req => {
    const me = await requirePerson(req, db);
    const q = ListQuery.parse(req.query);
    const access = await accessOf(db, me);
    const state = q.status === 'open' ? notInArray(tasks.status, [...CLOSED]) : q.status === 'closed' ? inArray(tasks.status, [...CLOSED]) : undefined;
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, me.companyId), state, q.department ? eq(tasks.departmentId, q.department) : undefined))
      .orderBy(desc(tasks.number))
      .limit(500);
    return { tasks: await taskLines(ctx, rows.filter(t => reaches(access, t))) };
  });

  app.get('/api/tasks/:id', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    return { task: await taskDetail(ctx, await reachable(me, id)) };
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
      [assignee] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.departmentId, dept.id), eq(agents.kind, 'head'))).orderBy(asc(agents.createdAt));
      if (!assignee) throw refuse(409, 'no_head', 'This department has no head yet. Hire one first.');
    }
    const moved = await createTask(ctx, { personId: me.id }, { title: body.title, brief: body.brief, body: body.body, departmentId: body.department ?? null, productId: body.product ?? null, assigneeAgentId: assignee.id });
    await wakeAll(ctx, moved.wakes);
    return reply.code(201).send({ task: await taskDetail(ctx, moved.task) });
  });

  app.post('/api/tasks/:id/comments', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
    const moved = await comment(ctx, { personId: me.id }, (await reachable(me, id)).id, text);
    await wakeAll(ctx, moved.wakes);
    return reply.code(201).send({ task: await taskDetail(ctx, moved.task) });
  });

  app.post('/api/tasks/:id/cancel', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const { why } = z.object({ why: z.string().max(1000).default('') }).parse(req.body ?? {});
    const moved = await cancel(ctx, { personId: me.id }, (await reachable(me, id)).id, why);
    return { task: await taskDetail(ctx, moved.task) };
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
    return {
      requests: mine.map((r, i) => ({
        id: r.request.id,
        kind: r.request.kind,
        text: r.request.text,
        commit: r.request.commit,
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
    const [found] = await db.select({ taskId: requests.taskId }).from(requests).where(and(eq(requests.id, id), eq(requests.companyId, me.companyId)));
    if (!found) throw refuse(404, 'request_unknown', 'There is no such request.');
    await reachable(me, found.taskId).catch(() => {
      throw refuse(404, 'request_unknown', 'There is no such request.');
    });
    const done = await answer(ctx, me.id, id, body);
    await wakeAll(ctx, done.wakes);
    return { request: { id: done.request.id, status: done.request.status } };
  });

  /* Turns belong to the whole company. */
  async function turnView(turn: typeof turns.$inferSelect | undefined) {
    if (!turn) return null;
    const [all] = await db.select({ n: count() }).from(tasks).where(eq(tasks.turnId, turn.id));
    const [done] = await db.select({ n: count() }).from(tasks).where(and(eq(tasks.turnId, turn.id), eq(tasks.status, 'done')));
    return { id: turn.id, number: turn.number, goal: turn.goal, status: turn.status, taskId: turn.taskId, startedAt: turn.createdAt.toISOString(), tasks: { total: Number(all?.n ?? 0), done: Number(done?.n ?? 0) } };
  }

  app.get('/api/turns/current', async req => {
    const me = await requirePerson(req, db);
    const [turn] = await db.select().from(turns).where(and(eq(turns.companyId, me.companyId), eq(turns.status, 'open')));
    return { turn: await turnView(turn) };
  });

  /* A turn starts as the orchestrator's task with its goal. */
  app.post('/api/turns', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const { goal } = z.object({ goal: z.string().trim().min(1).max(600) }).parse(req.body);
    const orchestrator = await orchestratorOf(ctx, me.companyId);
    if (!orchestrator) throw refuse(409, 'no_head', 'This company has no orchestrator.');
    const turn = await db.transaction(async tx => {
      const [open] = await tx.select({ id: turns.id }).from(turns).where(and(eq(turns.companyId, me.companyId), eq(turns.status, 'open')));
      if (open) throw refuse(409, 'turn_open', 'A turn is open. Close it before starting the next.');
      const [last] = await tx.select({ n: max(turns.number) }).from(turns).where(eq(turns.companyId, me.companyId));
      const [row] = await tx.insert(turns).values({ companyId: me.companyId, number: (last?.n ?? 0) + 1, goal, startedBy: me.id }).returning();
      return row!;
    }).catch((err: { code?: string }) => {
      /* Two starts at once: the one-open-turn index refuses the second. */
      if (err.code === '23505') throw refuse(409, 'turn_open', 'A turn is open. Close it before starting the next.');
      throw err;
    });
    const moved = await createTask(ctx, { personId: me.id }, { title: `Turn ${turn.number}: ${goal}`.slice(0, 120), brief: goal, body: goal, departmentId: null, assigneeAgentId: orchestrator.id });
    const [linked] = await db.update(turns).set({ taskId: moved.task.id }).where(eq(turns.id, turn.id)).returning();
    await wakeAll(ctx, moved.wakes);
    ctx.bus.publish(me.companyId, { type: 'org' });
    return reply.code(201).send({ turn: await turnView(linked) });
  });

  /* Open tasks of a closed turn stay open, without a turn. */
  app.post('/api/turns/:id/close', async req => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const { id } = IdParams.parse(req.params);
    const closed = await db.transaction(async tx => {
      const [row] = await tx
        .update(turns)
        .set({ status: 'closed', closedBy: me.id, closedAt: new Date() })
        .where(and(eq(turns.id, id), eq(turns.companyId, me.companyId), eq(turns.status, 'open')))
        .returning();
      if (!row) throw refuse(404, 'turn_unknown', 'There is no open turn with this id.');
      await tx.update(tasks).set({ turnId: null }).where(and(eq(tasks.turnId, id), notInArray(tasks.status, [...CLOSED])));
      return row;
    });
    ctx.bus.publish(me.companyId, { type: 'org' });
    return { turn: await turnView(closed) };
  });
}
