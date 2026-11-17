import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { taskEvents } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { refuse, type Moved, type Task } from './engine.js';

export type Submission = { summary: string; evidence: string; review?: { baseCommit: string; branch?: string; commit?: string }; operationId?: string };

export function submissionOperation(input: Submission): { id: string; digest: string } | null {
  if (!input.operationId) return null;
  if (!z.uuid().safeParse(input.operationId).success) throw refuse(400, 'task_invalid', 'The operation ID must be a UUID.');
  const digest = createHash('sha256').update(JSON.stringify([input.summary, input.evidence, input.review ?? null])).digest('hex');
  return { id: input.operationId, digest };
}

export async function replayedSubmission(db: Ctx['db'], task: Task, agentId: string, operation: ReturnType<typeof submissionOperation>): Promise<Moved | null> {
  if (!operation) return null;
  const [event] = await db.select(only(taskEvents, 'data')).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.companyId, task.companyId),
    eq(taskEvents.agentId, agentId), eq(taskEvents.kind, 'submitted'), sql`${taskEvents.data}->'operation'->>'id' = ${operation.id}`)).limit(1);
  if (!event) return null;
  const prior = event.data.operation as { digest?: unknown };
  if (prior.digest !== operation.digest) throw refuse(409, 'task_changed', 'This operation ID already belongs to a different submission.');
  return { task, wakes: [] };
}
