import { and, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { runsDepartment } from '../../auth/departments.js';
import type { Person } from '../../auth/session.js';
import { requests, tasks, taskWaits } from '../../db/schema.js';
import { requireAnswersFor } from '../tracker/responsible.js';
import { decisionPerson } from './decision-people.js';
import { note, published } from './events.js';
import { CLOSED, refuse, requestSubject, taskSpot, type Request, type Task, type Tx } from './state.js';
import { moveWaitOwner, requestSourceKey } from './wait-state.js';

export const canReaddress = (request: Pick<Request, 'kind' | 'decisionTopic'>) =>
  request.decisionTopic === 'task' && (request.kind === 'question' || request.kind === 'choice');

type Assignment = { request: string; expected: string | null; to: string };

export const mayAssignQuestions = (me: Person, manages: boolean) => manages && !me.via && !me.assistant;

function checkOpenQuestion(task: Task, request: Request | undefined): asserts request is Request {
  if (!request) throw refuse(404, 'request_unknown', 'This task has no such question.');
  if (CLOSED.includes(task.status) || request.status !== 'open' || !canReaddress(request)) {
    throw refuse(409, 'task_invalid', 'Only an open question about the task can change who answers it.');
  }
}

async function followRecipient(tx: Tx, task: Task, request: Request, to: string, personId: string): Promise<void> {
  const [wait] = await tx.select().from(taskWaits).where(and(eq(taskWaits.taskId, task.id), eq(taskWaits.sourceKey, requestSourceKey(request.id)), inArray(taskWaits.state, ['active', 'legacy_needs_plan'])));
  if (!wait?.ownerPersonId) return;
  const previous = request.recipientPersonId ?? await decisionPerson({ db: tx }, task.companyId, requestSubject(request, task));
  if (wait.ownerPersonId === previous) await moveWaitOwner(tx, wait, { personId: to }, { personId });
}

/* Task and request are locked in the order the answer and close paths use. Moving a question neither answers it
   nor changes who does the work. A wait assigned separately keeps its owner. */
export async function readdress(ctx: Ctx, me: Person, seen: Task, change: Assignment): Promise<void> {
  if (!mayAssignQuestions(me, await runsDepartment(ctx.db, me, seen.departmentId))) {
    throw refuse(403, 'task_not_yours', 'Only someone who runs the department may assign this question.');
  }
  await ctx.db.transaction(async tx => {
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.companyId, me.companyId), eq(tasks.id, seen.id))).for('update');
    const [request] = await tx.select().from(requests).where(and(eq(requests.taskId, seen.id), eq(requests.id, change.request))).for('update');
    if (!task) throw refuse(404, 'task_unknown', 'No such task.');
    checkOpenQuestion(task, request);
    if (request.recipientPersonId === change.to) return;
    if (request.recipientPersonId !== change.expected) throw refuse(409, 'task_changed', 'Someone else is now responsible for answering this question.');
    await requireAnswersFor({ db: tx }, task.companyId, change.to, taskSpot(task));
    await tx.update(requests).set({ recipientPersonId: change.to, explained: null }).where(eq(requests.id, request.id));
    await followRecipient(tx, task, request, change.to, me.id);
    await note(tx, task, { kind: 'edited', actor: { personId: me.id }, data: { fields: ['decisionRecipient'], requestId: request.id, from: request.recipientPersonId, to: change.to } });
  });
  published(ctx, seen);
  ctx.bus.publish(me.companyId, { type: 'requests', spot: taskSpot(seen) });
}
