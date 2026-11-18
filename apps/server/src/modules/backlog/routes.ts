import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireDepartmentHad } from '../../auth/departments.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { ApiError } from '../../errors.js';
import { orchestratorOf } from '../conversation/turn-records.js';
import { scheduleBacklog } from '../tasks/turns.js';
import { wakeAll } from '../tasks/wake.js';
import { addBacklogItem, backlogChanged, listBacklog, removeBacklogItem, reorderBacklog } from './store.js';

/* Every route names the department; the item routes name the item too. */
const Params = z.object({ id: z.uuid() });
const ItemParams = z.strictObject({ id: z.uuid(), item: z.uuid() });
const NewItem = z.strictObject({ title: z.string().trim().min(1).max(120), text: z.string().max(20000).default('') });
const Order = z.strictObject({ ids: z.array(z.uuid()).max(500) });
/* The items to give out now, as tasks of the department's head. */
const Chosen = z.strictObject({ ids: z.array(z.uuid()).min(1).max(20) });

/* A department's list of work kept for later turns: what its people put aside, in the order they want it, until they or
   the orchestrator put items into the next turn. Only people who have the department read or change it. */
export function backlogRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const departmentOf = (req: FastifyRequest, me: Person) => requireDepartmentHad(db, me, Params.parse(req.params).id);
  const items = (companyId: string, departmentId: string) => listBacklog(db, companyId, departmentId).then(list => ({ items: list }));

  app.get('/api/departments/:id/backlog', async req => {
    const me = await requirePerson(req, db);
    const department = await departmentOf(req, me);
    return items(me.companyId, department.id);
  });

  app.post('/api/departments/:id/backlog', async (req, reply) => {
    const me = await requirePerson(req, db);
    const department = await departmentOf(req, me);
    const body = NewItem.parse(req.body);
    const row = await addBacklogItem(db, me.companyId, department.id, me.id, body);
    backlogChanged(ctx, me.companyId, department.id);
    const item = (await listBacklog(db, me.companyId, department.id)).find(i => i.id === row.id)!;
    return reply.code(201).send({ item });
  });

  app.put('/api/departments/:id/backlog/order', async req => {
    const me = await requirePerson(req, db);
    const department = await departmentOf(req, me);
    const { ids } = Order.parse(req.body);
    await reorderBacklog(db, me.companyId, department.id, ids);
    backlogChanged(ctx, me.companyId, department.id);
    return items(me.companyId, department.id);
  });

  app.delete('/api/departments/:id/backlog/:item', async req => {
    const me = await requirePerson(req, db);
    const department = await departmentOf(req, me);
    const { item } = ItemParams.parse(req.params);
    await removeBacklogItem(db, me.companyId, department.id, item);
    backlogChanged(ctx, me.companyId, department.id);
    return items(me.companyId, department.id);
  });

  /* The chosen items go to work and leave the list: tasks given to the head of the department. */
  app.post('/api/departments/:id/backlog/schedule', async req => {
    const me = await requirePerson(req, db);
    const department = await departmentOf(req, me);
    const { ids } = Chosen.parse(req.body);
    const orchestrator = await orchestratorOf(ctx, me.companyId);
    if (!orchestrator) throw new ApiError(409, 'conflict', 'This company has no orchestrator to give the tasks.', 'no_head');
    const moved = await scheduleBacklog(ctx, { companyId: me.companyId, agentId: orchestrator.id, personId: me.id }, department.id, ids);
    await wakeAll(ctx, moved.wakes);
    return { tasks: moved.tasks.map(t => ({ id: t.id, number: t.number })) };
  });
}
