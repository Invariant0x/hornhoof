import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { tasks } from '../../db/schema.js';
import { type Task } from './state.js';
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
