import type { Db } from '../../db/client.js';
import type { agents } from '../../db/schema.js';
import { topDepartment } from '../tasks/turn-department.js';

export type Reader = Pick<typeof agents.$inferSelect, 'id' | 'kind' | 'departmentId'>;

/* Whether an agent works inside a department: the orchestrator for the whole company, any other agent for the top-level
   department it is placed in, with that department's products and sub-units. What a department keeps to itself, as its
   branches and the machines of its employees, goes to no agent of another one, even one given a task of it. */
export async function worksIn(db: Pick<Db, 'select'>, reader: Reader, departmentId: string | null): Promise<boolean> {
  if (reader.kind === 'orchestrator') return true;
  if (!reader.departmentId || !departmentId) return false;
  const [mine, theirs] = await Promise.all([topDepartment(db, reader.departmentId), topDepartment(db, departmentId)]);
  return mine !== null && mine.id === theirs?.id;
}
