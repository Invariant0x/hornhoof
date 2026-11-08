import { randomUUID } from 'node:crypto';
import { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { taskEvents } from '../../db/schema.js';
import { refuse, type Task } from './engine.js';
import type { Route } from './echelons-store.js';
import type { CheckerIdentity } from './echelons-policy.js';
import type { Review } from './review-context.js';

export function producedCandidate(route: Route, producer: CheckerIdentity, review: Review | null): EchelonCandidate {
  if (!review?.commit || !review.branch || !review.source) throw refuse(409, 'task_invalid', 'A handoff needs the exact candidate commit, branch and base comparison.');
  return EchelonCandidate.parse({ id: randomUUID(), parentId: route.state.candidateId, revision: route.revision + 1,
    baseCommit: review.source.baseCommit, commit: review.commit, branch: review.branch, paths: review.source.paths,
    producedBy: { ...producer, stage: route.state.stage },
  });
}

export async function currentCandidate(db: Ctx['db'], task: Task, route: Route): Promise<EchelonCandidate> {
  const [event] = await db.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.companyId, task.companyId),
    sql`${taskEvents.data}->'candidate'->>'id' = ${route.state.candidateId}`)).orderBy(desc(taskEvents.id)).limit(1);
  const parsed = EchelonCandidate.safeParse(event?.data.candidate);
  if (!parsed.success) throw refuse(409, 'task_invalid', 'The current candidate has no immutable source event.');
  return parsed.data;
}
