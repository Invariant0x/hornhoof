import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, canReach } from '../../auth/access.js';
import { changedBy, requirePerson } from '../../auth/session.js';
import { departments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { BriefingBody, briefingView, writeBriefing } from './briefing.js';

const Params = z.object({ id: z.uuid() });

/* A department's record for its agents, and each of its products', for people who may change that department's
   employees, as for its notebook: a team of the department is not enough. */
export function briefingRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  async function placeFor(req: FastifyRequest) {
    const me = await requirePerson(req, db);
    const { id } = Params.parse(req.params);
    const [dept] = await db.select().from(departments).where(and(eq(departments.id, id), eq(departments.companyId, me.companyId)));
    if (!dept) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    if (me.scopeKind !== 'company' && !canReach({ ...(await accessOf(db, me)), teams: new Set() }, { departmentId: dept.id, parentId: dept.parentId })) {
      throw new ApiError(403, 'forbidden', 'Only people with access to this department or the whole company can read and change what it keeps for its agents.', 'not_your_department');
    }
    return { me, dept };
  }

  app.get('/api/departments/:id/briefing', async req => {
    const { dept } = await placeFor(req);
    return { briefing: await briefingView(db, dept) };
  });

  app.put('/api/departments/:id/briefing', async req => {
    const { me, dept } = await placeFor(req);
    await writeBriefing(db, dept, BriefingBody.parse(req.body), changedBy(me));
    return { briefing: await briefingView(db, dept) };
  });
}
