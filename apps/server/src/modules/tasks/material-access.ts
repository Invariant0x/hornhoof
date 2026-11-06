import { and, eq } from 'drizzle-orm';
import { viewerOf } from '../../auth/agent-view.js';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { requestInternal, requests, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { knowsRequest, mayOpenRequest } from './decisions.js';

export type MaterialRequest = {
  request: typeof requests.$inferSelect;
  task: typeof tasks.$inferSelect;
  known: boolean;
};

/* Reading a picture keeps the original decision boundary; the opaque material
   id grants nothing and is resolved again on every content/download request. */
export async function materialRequest(db: Db, me: Person, id: string): Promise<MaterialRequest> {
  const [found] = await db.select({ request: requests, task: tasks }).from(requests)
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(and(eq(requests.id, id), eq(requests.companyId, me.companyId), eq(tasks.companyId, me.companyId)));
  if (!found) throw new ApiError(404, 'not_found', 'There is no such question.', 'request_unknown');
  if (!(await mayOpenRequest(db, me, found.request, found.task))) throw new ApiError(403, 'forbidden', 'This question belongs to work you do not see.', 'attachment_hidden');
  return { ...found, known: knowsRequest(await viewerOf(db, me), found.request, found.task) };
}

/* A new/staged snapshot must never fall back to legacy picture permission.
   The current classification/disclosure producer is a required integration. */
export async function requireLegacyMaterials(db: Db, source: MaterialRequest): Promise<void> {
  const [privateRow] = await db.select({ snapshot: requestInternal.materialSnapshot }).from(requestInternal)
    .where(and(eq(requestInternal.requestId, source.request.id), eq(requestInternal.companyId, source.request.companyId)));
  if (source.request.materialRevision !== null || source.request.materialDigest !== null || privateRow?.snapshot != null) {
    throw new ApiError(503, 'unavailable', 'The materials for this question are not available yet. Keep your answer and try again later.', 'source_producer_unavailable');
  }
}
