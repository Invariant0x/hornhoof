import type { DepartmentTurnProgress } from '@hornhoof/protocol';
import { and, count, eq } from 'drizzle-orm';
import { canReach } from '../../auth/access.js';
import type { AgentViewer } from '../../auth/agent-view.js';
import type { Db } from '../../db/client.js';
import { tasks, type departments, type teams, type turns } from '../../db/schema.js';
import { seesTask } from './sight.js';

type CountedTurn = Pick<typeof turns.$inferSelect, 'id' | 'companyId'>;
type ProgressTurn = CountedTurn & { number: number };
type ProgressDepartment = Pick<typeof departments.$inferSelect, 'id' | 'workMode'>;
type DepartmentPlaces = { departments: readonly Pick<typeof departments.$inferSelect, 'id' | 'parentId'>[]; teams: readonly Pick<typeof teams.$inferSelect, 'id' | 'departmentId'>[] };

/* Reaching one product or team lets the map show its parent department's visible
   count, but never changes the viewer used by seesTask or the settings owner rule. */
function reachesDepartment(viewer: AgentViewer, departmentId: string, places: DepartmentPlaces): boolean {
  const spots = [
    { departmentId },
    ...places.departments.filter(p => p.parentId === departmentId).map(p => ({ departmentId: p.id, parentId: departmentId })),
    ...places.teams.filter(t => t.departmentId === departmentId).map(t => ({ departmentId, teamId: t.id })),
  ];
  return spots.some(spot => canReach(viewer.access, spot));
}

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

export async function departmentProgress(db: Db, turn: ProgressTurn | undefined, viewer: AgentViewer, department: ProgressDepartment, places: DepartmentPlaces): Promise<DepartmentTurnProgress | null> {
  if (!turn || department.workMode === 'continuous' || !reachesDepartment(viewer, department.id, places)) return null;
  return { turnNumber: turn.number, ...await turnCounts(db, turn, viewer, department.id) };
}
