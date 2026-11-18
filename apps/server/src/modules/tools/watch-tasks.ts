import { externalWaitFact, isPersonWait } from '@hornhoof/protocol/waits';
import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { requests, tasks } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { openPersonRequests } from '../tasks/decisions.js';
import { CLOSED } from '../tasks/engine.js';

/* The watchdog sees wait facts, never dependency bodies or references outside the task's department, and with each task what
   decides whether it may open it. */
export async function watchedTasks(db: Db, companyId: string, holders: string[]) {
  const held = await db.select({ id: tasks.id, number: tasks.number, title: tasks.title, status: tasks.status,
    updatedAt: tasks.updatedAt, holder: tasks.assigneeAgentId, departmentId: tasks.departmentId, executorAgentId: tasks.executorAgentId,
    after: tasks.after, externalWait: tasks.externalWait }).from(tasks)
    .where(and(eq(tasks.companyId, companyId), inArray(tasks.assigneeAgentId, holders), notInArray(tasks.status, [...CLOSED])));
  if (!held.length) return [];
  const afterIds = [...new Set(held.flatMap(t => t.after))];
  const prerequisites = afterIds.length ? await db.select({ id: tasks.id, number: tasks.number, departmentId: tasks.departmentId }).from(tasks)
    .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, afterIds), isNotNull(tasks.departmentId), notInArray(tasks.status, [...CLOSED])))
    .orderBy(tasks.number) : [];
  const questions = new Set((await db.select(only(requests, 'taskId')).from(requests)
    .where(and(eq(requests.companyId, companyId), inArray(requests.taskId, held.map(t => t.id)), openPersonRequests()))).map(r => r.taskId));
  const now = Date.now();
  return held.map(({ id, departmentId, executorAgentId, after, externalWait, ...task }) => ({ ...task,
    sight: { status: task.status, departmentId, assigneeAgentId: task.holder, executorAgentId },
    waitsFor: prerequisites.filter(p => p.departmentId === departmentId && after.includes(p.id)).map(p => p.number),
    externalWait: externalWait ? { reason: externalWait.reason, since: externalWait.since, until: externalWait.until } : null,
    waitingForPerson: questions.has(id) || !!(externalWait && isPersonWait(externalWaitFact(externalWait, now))),
  }));
}
