import { eq } from 'drizzle-orm';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agents } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { mayChangeRules } from '../departments/approval-policy.js';

/* Who runs a department's messages: its owner, everyone given the department, the CEO and the delegate, and the
   department's own head carrying out the word of one of them. A head reaches nothing of another department: there it is
   told what it would be told of nothing at all, so that it cannot even learn what is there. */

const notYours = () => new ApiError(403, 'forbidden', 'Only this department\'s owner, the CEO or the CEO delegate does this.', 'outbound_not_allowed');

/* The department of the head a call comes through; null when it comes through no head. */
async function headDepartment(db: Pick<Db, 'select'>, me: Person): Promise<string | null> {
  if (!me.viaHead || !me.via) return null;
  const [head] = await db.select(only(agents, 'departmentId')).from(agents).where(eq(agents.id, me.via));
  return head?.departmentId ?? null;
}

export async function requireRunner(db: Pick<Db, 'select'>, me: Person, departmentId: string, unknown: () => ApiError): Promise<void> {
  if (me.viaHead && (await headDepartment(db, me)) !== departmentId) throw unknown();
  if (!(await mayChangeRules(db, me, departmentId))) throw notYours();
}
