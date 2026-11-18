import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { taskEvents, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import type { Tx } from './state.js';

const IndependentPartSchema = z.strictObject({ title: z.string().trim().min(1), brief: z.string(), body: z.string().trim().min(1), executor: z.uuid() });
export type IndependentPartInput = z.infer<typeof IndependentPartSchema>;
export type IndependentDeclaration = { kind: 'part'; part: IndependentPartInput } | { kind: 'none'; reason: string };
export type IndependentRecord = { kind: 'part'; part: IndependentPartInput; child: typeof tasks.$inferSelect } | { kind: 'none'; reason: string };

const invalid = (message: string) => new ApiError(400, 'validation', message, 'task_invalid');
const REQUIRED = 'A task with after needs independentPart or independentNone.';

function existingIndependent(part: IndependentPartInput | undefined, none: string | undefined, current: IndependentDeclaration | null): IndependentDeclaration | null {
  if (current?.kind !== 'part') return null;
  if (none !== undefined) throw invalid('The independent part already exists.');
  if (part && JSON.stringify(part) !== JSON.stringify(current.part)) throw invalid('The independent part already exists.');
  return current;
}

function withoutAfter(part: IndependentPartInput | undefined, none: string | undefined): null {
  if (part || none !== undefined) throw invalid('independentPart and independentNone need a nonempty after.');
  return null;
}

function independentReason(none: string): IndependentDeclaration {
  if (!none.trim()) throw invalid('independentNone needs a reason.');
  return { kind: 'none', reason: none.trim() };
}

export function checkIndependent(after: string[], part: IndependentPartInput | undefined, none: string | undefined, current: IndependentDeclaration | null): IndependentDeclaration | null {
  if (part && none !== undefined) throw invalid(REQUIRED);
  if (!after.length) return withoutAfter(part, none);
  const existing = existingIndependent(part, none, current);
  if (existing) return existing;
  if (part) return { kind: 'part', part: IndependentPartSchema.parse(part) };
  if (current) return current;
  if (none !== undefined) return independentReason(none);
  throw invalid(REQUIRED);
}

export async function independentViews(db: Db | Tx, taskIds: string[]): Promise<Map<string, IndependentRecord>> {
  const found = new Map<string, IndependentRecord>();
  if (!taskIds.length) return found;
  const events = await db.select({ taskId: taskEvents.taskId, data: taskEvents.data }).from(taskEvents)
    .where(and(inArray(taskEvents.taskId, taskIds), or(isNotNull(sql`${taskEvents.data}->'independentPart'`), isNotNull(sql`${taskEvents.data}->'independentNone'`))))
    .orderBy(desc(taskEvents.id));
  const latest = new Map<string, Record<string, unknown>>();
  for (const event of events) if (!latest.has(event.taskId)) latest.set(event.taskId, event.data);
  const parentIds = [...latest].filter(([, data]) => IndependentPartSchema.safeParse(data.independentPart).success).map(([taskId]) => taskId);
  const links = parentIds.length ? await db.select({ child: tasks, parentId: sql<string>`${taskEvents.data}->>'independentPartOf'` }).from(taskEvents).innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
    .where(and(eq(taskEvents.kind, 'created'), inArray(sql`${taskEvents.data}->>'independentPartOf'`, parentIds))) : [];
  const children = new Map(links.map(link => [link.parentId, link.child]));
  for (const [taskId, data] of latest) {
    const part = IndependentPartSchema.safeParse(data.independentPart);
    if (part.success) {
      const child = children.get(taskId);
      if (child) found.set(taskId, { kind: 'part', part: part.data, child });
    } else if (typeof data.independentNone === 'string') found.set(taskId, { kind: 'none', reason: data.independentNone });
  }
  return found;
}

export async function currentIndependent(db: Db | Tx, taskId: string): Promise<IndependentRecord | null> {
  return (await independentViews(db, [taskId])).get(taskId) ?? null;
}
