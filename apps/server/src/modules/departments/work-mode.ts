import { DepartmentWorkModeChange } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, listsDepartment } from '../../auth/access.js';
import { requirePerson } from '../../auth/session.js';
import { departments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { mayChangeRules, ownDepartment } from './approval-policy.js';

const IdParams = z.strictObject({ id: z.uuid() });
const view = (department: Pick<typeof departments.$inferSelect, 'id' | 'workMode'>, canChangeWorkMode: boolean) => ({ departmentId: department.id, workMode: department.workMode, canChangeWorkMode });

export function workModeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  app.get('/api/departments/:id/work-mode', async req => {
    const me = await requirePerson(req, db);
    const department = await ownDepartment(db, me.companyId, IdParams.parse(req.params).id);
    if (!listsDepartment(await accessOf(db, me), department.id)) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    return view(department, await mayChangeRules(db, me, department.id));
  });
  app.put('/api/departments/:id/work-mode', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const body = DepartmentWorkModeChange.parse(req.body);
    const saved = await db.transaction(async tx => {
      const department = await ownDepartment(tx, me.companyId, id);
      if (!(await mayChangeRules(tx, me, department.id))) throw new ApiError(403, 'forbidden', 'Only this department\'s owner, the CEO or the CEO delegate changes its work mode.', 'not_owner');
      await tx.update(departments).set({ workMode: body.workMode }).where(eq(departments.id, department.id));
      return view({ ...department, workMode: body.workMode }, true);
    });
    ctx.bus.publish(me.companyId, { type: 'org' });
    return saved;
  });
}
