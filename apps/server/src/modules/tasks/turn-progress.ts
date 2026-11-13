import type { DepartmentTurnProgress } from '@hornhoof/protocol';
import { and, count, eq } from 'drizzle-orm';
import type { AgentViewer } from '../../auth/agent-view.js';
import type { Db } from '../../db/client.js';
import { tasks, type departments, type turns } from '../../db/schema.js';
import { seesTask } from './sight.js';

type CountedTurn = Pick<typeof turns.$inferSelect, 'id' | 'companyId'>;
type ProgressTurn = CountedTurn & { number: number };
type ProgressDepartment = Pick<typeof departments.$inferSelect, 'id' | 'workMode'>;

/* TurnView and the map count the same visible rows, roots and subtasks included.
   A department adds only its scope; another company's malformed references never count. */
export async function turnCounts(db: Db, turn: CountedTurn, viewer: AgentViewer, departmentId?: string): Promise<{ total: number; done: number }> {
  const scope = and(eq(tasks.companyId, turn.companyId), eq(tasks.turnId, turn.id), departmentId ? eq(tasks.departmentId, departmentId) : undefined);
  if (viewer.full) {
    const [all] = await db.select({ n: count() }).from(tasks).where(scope);
    const [done] = await db.select({ n: count() }).from(tasks).where(and(scope, eq(tasks.status, 'done')));
    return { total: Number(all!.n), done: Number(done!.n) };
  }
  const seen = (await db.select().from(tasks).where(scope)).filter(t => seesTask(viewer, t));
  return { total: seen.length, done: seen.filter(t => t.status === 'done').length };
}

/* How far a department is in the open turn, which the map shows everyone of the company. */
export async function departmentProgress(db: Db, turn: ProgressTurn | undefined, viewer: AgentViewer, department: ProgressDepartment): Promise<DepartmentTurnProgress | null> {
  if (!turn || department.workMode === 'continuous') return null;
  return { turnNumber: turn.number, ...await turnCounts(db, turn, viewer, department.id) };
}
