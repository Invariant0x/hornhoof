import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { RunKind } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import { testParts, testRuns } from '../../db/schema.js';
import type { ToolJob } from '../tools/job.js';
import { runState } from '../testruns/runs.js';
import { partCheckWait } from './check-slot-details.js';

const View = z.object({ parts: z.array(z.object({ part: z.number() }).passthrough()) }).passthrough();

/* Access is checked by runState before any queue data is added to its public result. */
export async function queuedRunState(ctx: Ctx, job: ToolJob, number: number, kind: RunKind = 'tests'): Promise<object> {
  const view = View.parse(await runState(ctx, job, number, kind));
  const rows = await ctx.db.select({ part: testParts }).from(testParts).innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .where(and(eq(testRuns.companyId, job.companyId), eq(testRuns.number, number), eq(testRuns.kind, kind), eq(testParts.status, 'running'), isNull(testParts.startedAt)));
  const waits = new Map(await Promise.all(rows.map(async row => [row.part.part, await partCheckWait(ctx, job, row.part)] as const)));
  return { ...view, parts: view.parts.map(part => ({ ...part, ...waits.get(part.part) })) };
}
