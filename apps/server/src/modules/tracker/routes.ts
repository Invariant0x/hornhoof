import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, canReach } from '../../auth/access.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { actorOf, requirePerson, type Person } from '../../auth/session.js';
import { GOAL_STATUSES } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { refuse } from '../tasks/engine.js';
import { createGoal, editGoal, goalLog, goalViews, loadGoal, setGoalStatus, type GoalChange, type GoalGuard } from './goals.js';

const IdParams = z.object({ id: z.uuid() });
const Version = z.number().int().min(0);
const GoalFields = {
  title: z.string().trim().min(1).max(120),
  why: z.string().trim().max(300),
  parent: z.uuid().nullable(),
  responsible: z.uuid(),
  target: z.number().positive().nullable(),
  current: z.number().min(0).nullable(),
  unit: z.string().trim().max(40),
  due: z.iso.datetime({ offset: true }).nullable(),
};
const NewGoalBody = z.strictObject({ ...GoalFields, department: z.uuid().nullable().default(null) }).partial({ why: true, parent: true, responsible: true, target: true, current: true, unit: true, due: true });
const GoalPatch = z.strictObject({ ...GoalFields, version: Version }).partial().required({ version: true });
const GoalStatusBody = z.strictObject({ status: z.enum(GOAL_STATUSES), version: Version });

/* The names of a goal's fields on its card, as the table keeps them. */
function goalChange(body: Partial<z.infer<typeof GoalPatch>>): GoalChange {
  return {
    title: body.title,
    why: body.why,
    parentGoalId: body.parent,
    responsiblePersonId: body.responsible,
    targetValue: body.target,
    currentValue: body.current,
    unit: body.unit,
    dueAt: body.due === undefined ? undefined : body.due === null ? null : new Date(body.due),
  };
}

/* A person sets the company's goals as the CEO or the CEO's delegate, and a department's goals when they reach it. */
export const personGuard = (ctx: Pick<Ctx, 'db'>, me: Person): GoalGuard => async spot => {
  if (actsAsCeo(me)) return;
  if (!spot.departmentId) throw new ApiError(403, 'forbidden', "Only the CEO or the CEO delegate sets the company's goals.", 'company_scope_only');
  if (!canReach(await accessOf(ctx.db, me), spot)) throw refuse(403, 'not_your_department', 'This department is not one you have.');
};

/* Goals and pipelines: everyone of the company reads them, as they read its tasks; who writes depends on their place. */
export function trackerRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  app.get('/api/goals', async req => {
    const me = await requirePerson(req, db);
    return { goals: await goalViews(ctx, me.companyId) };
  });

  app.get('/api/goals/:id', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const goal = await loadGoal(db, me.companyId, id);
    return { goal: (await goalViews(ctx, me.companyId)).find(g => g.id === goal.id), log: await goalLog(ctx, goal) };
  });

  app.post('/api/goals', async (req, reply) => {
    const me = await requirePerson(req, db);
    const body = NewGoalBody.parse(req.body);
    const goal = await createGoal(ctx, me.companyId, actorOf(me), personGuard(ctx, me), { ...goalChange(body), title: body.title, departmentId: body.department });
    reply.code(201);
    return { goal: (await goalViews(ctx, me.companyId)).find(g => g.id === goal.id) };
  });

  app.patch('/api/goals/:id', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const body = GoalPatch.parse(req.body);
    await editGoal(ctx, me.companyId, actorOf(me), personGuard(ctx, me), id, goalChange(body), body.version);
    return { goal: (await goalViews(ctx, me.companyId)).find(g => g.id === id) };
  });

  app.put('/api/goals/:id/status', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const body = GoalStatusBody.parse(req.body);
    await setGoalStatus(ctx, me.companyId, actorOf(me), personGuard(ctx, me), id, body.status, body.version);
    return { goal: (await goalViews(ctx, me.companyId)).find(g => g.id === id) };
  });
}
