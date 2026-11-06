import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { requests, tasks } from '../src/db/schema.js';

/* Historical unversioned approvals for reader/answer regressions. This is not a
   substitute for the real classified producer of a new material source. */
export async function legacyApproval(db: Db, task: Pick<typeof tasks.$inferSelect, 'id' | 'companyId'>, agentId: string, source: { text: string; commit: string; link?: string }) {
  return db.transaction(async tx => {
    const [request] = await tx.insert(requests).values({ companyId: task.companyId, taskId: task.id, agentId, kind: 'approval', decisionTopic: 'release', ...source, materialRevision: null, materialDigest: null }).returning();
    await tx.update(tasks).set({ status: 'waiting', silent: 0 }).where(eq(tasks.id, task.id));
    return { request: request! };
  });
}
