import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { runsDepartment } from '../../auth/departments.js';
import { people, tasks, type TaskPause } from '../../db/schema.js';
import { requireTaskHead } from './echelons-update.js';
import { CLOSED, loadTask, refuse, type Actor, type Moved, type Task, type Tx, type Wake } from './state.js';
import { note, published } from './events.js';
import { dropEarlierWakes, keepWakes } from './outbox.js';

/* A paused task's own work refuses: its executor waits for the resume, which wakes it once. */
export function refusePaused(task: Pick<Task, 'number' | 'paused'>): void {
  if (task.paused) throw refuse(409, 'task_paused', `#${task.number} is paused: ${task.paused.reason} Its work waits until whoever paused it resumes it.`);
}

/* The department head, the orchestrator, a person who acts as the CEO or the department's owner stops and resumes work. */
async function requirePauser(ctx: Pick<Ctx, 'db'>, task: Task, actor: Actor): Promise<void> {
  if (actor.agentId !== undefined) return requireTaskHead(ctx, task, actor.agentId);
  const [person] = await ctx.db.select().from(people).where(and(eq(people.id, actor.personId), eq(people.companyId, task.companyId)));
  if (!person || !(await runsDepartment(ctx.db, person, task.departmentId))) throw refuse(403, 'task_not_yours', 'Only the CEO, the CEO delegate, the department\'s owner, the department head or the orchestrator pauses work.');
}

/* The task and every open task under it, held for this change, the task first and then level by level. */
async function openTree(tx: Tx, task: Task): Promise<Task[]> {
  const [root] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).for('update');
  if (!root || CLOSED.includes(root.status)) throw refuse(409, 'task_changed', `#${task.number} changed meanwhile. Read it again.`);
  const tree = [root];
  for (let level = [root.id]; level.length;) {
    const below = await tx.select().from(tasks).where(and(inArray(tasks.parentId, level), notInArray(tasks.status, [...CLOSED]))).orderBy(asc(tasks.id)).for('update');
    tree.push(...below);
    level = below.map(t => t.id);
  }
  return tree;
}

const resumeWake = (task: Task): Wake | null => {
  if (!task.assigneeAgentId || !['open', 'working', 'review'].includes(task.status)) return null;
  return { agentId: task.assigneeAgentId, taskId: task.id, why: task.status === 'review' ? 'review' : 'assigned', text: `#${task.number} was resumed. Read it again and go on from where it stands.` };
};

/* Pausing ends any standing wait and the wakes kept for the tree, so neither a deadline nor a queued turn reaches anybody. */
export async function setPaused(ctx: Pick<Ctx, 'db' | 'bus'>, actor: Actor, taskId: string, paused: boolean, reason: string): Promise<Moved & { tree: string[] }> {
  const task = await loadTask(ctx.db, taskId);
  await requirePauser(ctx, task, actor);
  if (CLOSED.includes(task.status)) throw refuse(409, 'task_invalid', `#${task.number} is ${task.status}.`);
  if (paused && !reason.trim()) throw refuse(400, 'task_invalid', 'Say why the work is paused.');
  if (!paused && task.paused && task.paused.root !== task.id) throw refuse(409, 'task_invalid', `#${task.number} is paused with the task above it. Resume that task.`);
  if (paused === Boolean(task.paused)) return { task, wakes: [], tree: [] };
  const record: TaskPause | null = paused ? { at: new Date().toISOString(), reason: reason.trim(), by: actor.agentId !== undefined ? { agentId: actor.agentId } : { personId: actor.personId }, root: task.id } : null;
  const wakes: Wake[] = [];
  const changed = await ctx.db.transaction(async tx => {
    const tree = (await openTree(tx, task)).filter(t => paused ? !t.paused : t.paused?.root === task.id);
    const rows: Task[] = [];
    for (const t of tree) {
      const [row] = await tx.update(tasks).set({ paused: record, ...(paused ? { externalWait: null } : {}), version: sql`${tasks.version} + 1`, updatedAt: new Date() }).where(eq(tasks.id, t.id)).returning();
      await note(tx, row!, { kind: 'updated', actor, text: paused ? `Paused: ${record!.reason}` : 'Resumed.', data: { fields: ['paused'], paused: record } });
      await dropEarlierWakes(tx, t.id);
      const wake = paused ? null : resumeWake(row!);
      if (wake) wakes.push(wake);
      rows.push(row!);
    }
    await keepWakes(tx, task.companyId, wakes);
    return rows;
  });
  for (const row of changed) published(ctx, row);
  return { task: changed.find(row => row.id === task.id) ?? task, wakes, tree: changed.map(row => row.id) };
}
