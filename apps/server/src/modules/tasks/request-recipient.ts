import { and, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { runsDepartment } from '../../auth/departments.js';
import type { Person } from '../../auth/session.js';
import { requests, tasks, taskWaits } from '../../db/schema.js';
import { requireAnswersFor } from '../tracker/responsible.js';
import { decisionPerson } from './decision-people.js';
import { note, published } from './events.js';
import { CLOSED, refuse, requestSubject, taskSpot, type Request, type Task } from './state.js';
import { moveWaitOwner, requestSourceKey } from './wait-state.js';

export const canReaddress = (request: Pick<Request, 'kind' | 'decisionTopic'>) =>
  request.decisionTopic === 'task' && (request.kind === 'question' || request.kind === 'choice');

type Assignment = { request: string; expected: string | null; to: string };

/* Task and request are locked in the order the answer and close paths use. Moving a question neither answers it
   nor changes who does the work. A wait assigned separately keeps its owner. */
export async function readdress(ctx: Ctx, me: Person, seen: Task, change: Assignment): Promise<void> {
  if (me.via || me.assistant || !await runsDepartment(ctx.db, me, seen.departmentId)) {
    throw refuse(403, 'task_not_yours', 'Only someone who runs the department may assign this question.');
  }
  await ctx.db.transaction(async tx => {
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.companyId, me.companyId), eq(tasks.id, seen.id))).for('update');
    const [request] = await tx.select().from(requests).where(and(eq(requests.taskId, seen.id), eq(requests.id, change.request))).for('update');
    if (!task || !request) throw refuse(404, 'request_unknown', 'This task has no such question.');
    if (CLOSED.includes(task.status) || request.status !== 'open' || !canReaddress(request)) {
      throw refuse(409, 'task_invalid', 'Only an open question about the task can change who answers it.');
    }
    if (request.recipientPersonId === change.to) return;
    if (request.recipientPersonId !== change.expected) throw refuse(409, 'task_changed', 'Someone else is now responsible for answering this question.');
    await requireAnswersFor({ db: tx }, task.companyId, change.to, taskSpot(task));
    await tx.update(requests).set({ recipientPersonId: change.to, explained: null }).where(eq(requests.id, request.id));
    const [wait] = await tx.select().from(taskWaits).where(and(eq(taskWaits.taskId, task.id), eq(taskWaits.sourceKey, requestSourceKey(request.id)), inArray(taskWaits.state, ['active', 'legacy_needs_plan'])));
    if (wait?.ownerPersonId && wait.ownerPersonId === (request.recipientPersonId ?? await decisionPerson({ db: tx }, task.companyId, requestSubject(request, task)))) await moveWaitOwner(tx, wait, { personId: change.to }, { personId: me.id });
    await note(tx, task, { kind: 'edited', actor: { personId: me.id }, data: { fields: ['decisionRecipient'], requestId: request.id, from: request.recipientPersonId, to: change.to } });
  });
  published(ctx, seen);
  ctx.bus.publish(me.companyId, { type: 'requests', spot: taskSpot(seen) });
}
