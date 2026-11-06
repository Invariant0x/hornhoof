import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { requests, tasks } from '../../db/schema.js';
import { CLOSED } from '../tasks/engine.js';

/* The watchdog sees wait facts, never dependency bodies or references outside the task's department. */
export async function watchedTasks(db: Db, companyId: string, holders: string[]) {
  const held = await db.select({ id: tasks.id, number: tasks.number, title: tasks.title, status: tasks.status,
    updatedAt: tasks.updatedAt, holder: tasks.assigneeAgentId, departmentId: tasks.departmentId,
    after: tasks.after, externalWait: tasks.externalWait }).from(tasks)
    .where(and(eq(tasks.companyId, companyId), inArray(tasks.assigneeAgentId, holders), notInArray(tasks.status, [...CLOSED, 'planned'])));
  if (!held.length) return [];
  const afterIds = [...new Set(held.flatMap(t => t.after))];
  const prerequisites = afterIds.length ? await db.select({ id: tasks.id, number: tasks.number, departmentId: tasks.departmentId }).from(tasks)
    .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, afterIds), isNotNull(tasks.departmentId), notInArray(tasks.status, [...CLOSED, 'planned'])))
    .orderBy(tasks.number) : [];
  const questions = new Set((await db.select({ taskId: requests.taskId }).from(requests)
    .where(and(eq(requests.companyId, companyId), inArray(requests.taskId, held.map(t => t.id)), eq(requests.status, 'open')))).map(r => r.taskId));
  return held.map(({ id, departmentId, after, externalWait, ...task }) => ({ ...task,
    waitsFor: prerequisites.filter(p => p.departmentId === departmentId && after.includes(p.id)).map(p => p.number),
    externalWait: externalWait ? { reason: externalWait.reason, since: externalWait.since, until: externalWait.until } : null,
    waitingForPerson: questions.has(id),
  }));
}
