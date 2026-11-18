import { MAX_OPEN_TASKS, type TaskStates } from '@hornhoof/protocol';
import { and, asc, eq, notInArray } from 'drizzle-orm';
import { only } from '../../db/selections.js';
import { tasks } from '../../db/schema.js';
import { CLOSED, type Tx } from './state.js';
import { lastTaskNumber } from './numbers.js';

/* The company's task numbers still open and the last number it gave, by which a node tells the worktrees of its closed tasks:
   none when more are open than a message carries, and then every worktree stays. */
export async function openTaskNumbers(db: Pick<Tx, 'select'>, companyId: string): Promise<TaskStates | null> {
  const open = await db.select(only(tasks, 'number')).from(tasks).where(and(eq(tasks.companyId, companyId), notInArray(tasks.status, [...CLOSED]))).orderBy(asc(tasks.number)).limit(MAX_OPEN_TASKS + 1);
  if (open.length > MAX_OPEN_TASKS) return null;
  return { open: open.map(t => t.number), upTo: await lastTaskNumber(db, companyId) };
}
