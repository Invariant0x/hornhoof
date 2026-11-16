import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { tasks } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { CLOSED } from '../tasks/engine.js';
import { departmentScope } from '../tasks/wait-observations.js';

/* Work is any task of the department or its products that is neither only planned nor closed, whatever it waits for now. */
export async function departmentHasWork(ctx: Pick<Ctx, 'db'>, companyId: string, departmentId: string): Promise<boolean> {
  const scope = await departmentScope(ctx, companyId, departmentId);
  const [found] = await ctx.db.select(idOnly(tasks)).from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.departmentId, scope), notInArray(tasks.status, [...CLOSED]))).limit(1);
  return Boolean(found);
}
