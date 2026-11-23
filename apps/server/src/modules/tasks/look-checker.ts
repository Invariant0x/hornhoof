import { and, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { CLOSED, type Task } from './state.js';

type Checker = Pick<typeof agents.$inferSelect, 'id' | 'kind'>;
type Checked = Pick<Task, 'status' | 'externalWait' | 'assigneeAgentId' | 'executorAgentId' | 'createdByAgentId'>;

/* The holder of a task names the employee its open wait is on, as with track_work for the head of Design's final look
   check. A head named so, in any department, reads that task and comments on it while that wait stands, and its holder
   writes to that head about it. The head moves nothing on it. The first comment that ends the wait also ends that reach. */
function namedOnWait(agent: Checker, task: Pick<Task, 'status' | 'externalWait'>): boolean {
  const on = task.externalWait?.on;
  return agent.kind === 'head' && on?.kind === 'employee' && on.employee === agent.id && !CLOSED.includes(task.status);
}

/* A task that a person's own assistant holds, does or gave out stays that person's. */
async function personal(db: Ctx['db'], task: Checked): Promise<boolean> {
  const ids = [task.assigneeAgentId, task.executorAgentId, task.createdByAgentId].filter((id): id is string => Boolean(id));
  if (!ids.length) return false;
  return (await db.select(idOnly(agents)).from(agents).where(and(inArray(agents.id, ids), eq(agents.kind, 'assistant'))).limit(1)).length > 0;
}

/* Whether this agent is the named checker of this task now: a head on its open wait, on a task no assistant is part of. */
export async function checksTask(db: Ctx['db'], agent: Checker, task: Checked): Promise<boolean> {
  return namedOnWait(agent, task) && !(await personal(db, task));
}
