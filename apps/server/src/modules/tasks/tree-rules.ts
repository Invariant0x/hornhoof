import { and, eq, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { SUBTASK_REASONS, tasks, type AgentKind, type SubtaskReason } from '../../db/schema.js';
import { refuse, type Task } from './state.js';

/* The rules a new task tree keeps (research #2057, A1 to A5, A9 and A10). They bind the doors work is made through: the
   create_task tool, a person's route and a coordination task's report. Existing trees stay as they are: a rule never closes
   or moves what was made before it. */

/* Goal or top task, sub-task, step task. */
export const MAX_DEPTH = 3;
/* Under a task, without the head's approval: a head may make more, up to the cap under any parent. */
export const CHILDREN_OF_A_WORKER = 3;
export const CHILDREN_UNDER_ANY = 5;

const REASONS_TEXT = 'independent_result (a result a person can check on its own), other_owner (other skills, another department or an independent checker) or parallel_block (work that runs at the same time as its siblings and shortens the whole)';

export type Creator = { id: string; kind: AgentKind; departmentId: string | null };

/* How deep a task stands: 1 for one with nothing above it. */
export async function depthOf(db: Ctx['db'], task: Pick<Task, 'parentId'>): Promise<number> {
  let depth = 1;
  let up = task.parentId;
  while (up && depth <= MAX_DEPTH + 1) {
    const [parent] = await db.select({ parentId: tasks.parentId }).from(tasks).where(eq(tasks.id, up));
    depth += 1;
    up = parent?.parentId ?? null;
  }
  return depth;
}

async function childrenOf(db: Ctx['db'], parentId: string): Promise<number> {
  const rows = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.parentId, parentId), ne(tasks.status, 'cancelled')));
  return rows.length;
}

/* A5: who may make a task, and for what. A person: anything in their reach (their own checks live elsewhere). The orchestrator:
   top-level tasks, naming the person who asked for them. A head: tasks and sub-tasks of its own department. A worker: sub-tasks
   of its own task. */
function requireRight(creator: Creator, parent: Task | null): void {
  if (creator.kind === 'orchestrator') return;
  if (creator.kind === 'worker') {
    if (!parent) throw refuse(403, 'tree_rule', 'A worker makes sub-tasks of its own task, never a task with nothing above it: ask your head for new work.');
    if (parent.assigneeAgentId !== creator.id && parent.executorAgentId !== creator.id) throw refuse(403, 'tree_rule', `#${parent.number} is not your task, so you make no sub-task under it. Ask its holder or your head.`);
    return;
  }
  if (parent && parent.departmentId !== creator.departmentId) throw refuse(403, 'tree_rule', `#${parent.number} belongs to another department. Ask its head, or write to the orchestrator for a request to another department.`);
}

/* A1, A2, A4 and A5 for a task about to be made by an agent under `parent` (none: a task with nothing above it). */
export async function requireTreeRules(ctx: Pick<Ctx, 'db'>, creator: Creator, parent: Task | null, reason: SubtaskReason | undefined): Promise<void> {
  requireRight(creator, parent);
  if (!parent) return;
  const depth = await depthOf(ctx.db, parent);
  if (depth >= MAX_DEPTH) throw refuse(400, 'tree_rule', `Tasks go ${MAX_DEPTH} levels deep at most: a task, a sub-task and a step task under it. #${parent.number} is already level ${depth}. Put this work in the body of #${parent.number} as a checklist line, or ask its head.`);
  if (!reason || !SUBTASK_REASONS.includes(reason)) throw refuse(400, 'tree_rule', `A sub-task needs its reason: subtaskReason ${REASONS_TEXT}. Anything else is a step in the body of #${parent.number}, not a task.`);
  const have = await childrenOf(ctx.db, parent.id);
  if (have >= CHILDREN_UNDER_ANY) throw refuse(400, 'tree_rule', `#${parent.number} already has ${have} sub-tasks, the most any task has. A sixth sibling means a second parent, split by owner: ask your head.`);
  if (have >= CHILDREN_OF_A_WORKER && creator.kind !== 'head') throw refuse(403, 'tree_rule', `#${parent.number} already has ${have} sub-tasks, the most without the head's approval. Ask the head of the department to make the next one.`);
}

/* The depth and budget a person's route keeps: the same A1 and A4 caps, and no reason asked of them. */
export async function requirePersonTreeRules(ctx: Pick<Ctx, 'db'>, parent: Task | null): Promise<void> {
  if (!parent) return;
  const depth = await depthOf(ctx.db, parent);
  if (depth >= MAX_DEPTH) throw refuse(400, 'tree_rule', `Tasks go ${MAX_DEPTH} levels deep at most. #${parent.number} is already level ${depth}.`);
  const have = await childrenOf(ctx.db, parent.id);
  if (have >= CHILDREN_UNDER_ANY) throw refuse(400, 'tree_rule', `#${parent.number} already has ${have} sub-tasks, the most any task has.`);
}

/* A9: a coordination task of a tree made under these rules, that ends with one child, is that child's task: it is assigned directly. */
export async function requireMoreThanOneChild(ctx: Pick<Ctx, 'db'>, task: Task): Promise<void> {
  /* A tree made under the rules gave every sub-task its reason, so a lone child without one is of an older tree and closes as it always did. */
  const children = await ctx.db.select({ reason: tasks.subtaskReason }).from(tasks).where(and(eq(tasks.parentId, task.id), ne(tasks.status, 'cancelled')));
  if (children.length === 1 && children[0]!.reason) throw refuse(400, 'tree_rule', `#${task.number} has one sub-task only, so it is that task's own work: a coordination task holds two or more. Cancel #${task.number} with a comment naming its sub-task, and assign that task directly.`);
}

/* A10: a parent's title above its child's where the child is made, so a title that does not belong to the whole shows. */
export const underText = (parent: Pick<Task, 'number' | 'title'>, child: Pick<Task, 'number' | 'title'>): string =>
  `Under #${parent.number} "${parent.title}" (the whole result): #${child.number} "${child.title}" is a part of it.`;
