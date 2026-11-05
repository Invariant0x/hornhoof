import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { RunKind } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import { testParts, testRuns } from '../../db/schema.js';
import type { ToolJob } from '../tools/job.js';
import { runState } from '../testruns/runs.js';

const View = z.object({ parts: z.array(z.object({ part: z.number() }).passthrough()) }).passthrough();
const positionOf = (tail: string | null): number | null => {
  const found = /^Waiting for a machine check slot\. Position ([1-9][0-9]*)\.$/.exec(tail ?? '');
  return found ? Number(found[1]) : null;
};

/* Access is checked by runState before any queue data is added to its public result. */
export async function queuedRunState(ctx: Ctx, job: ToolJob, number: number, kind: RunKind = 'tests'): Promise<object> {
  const view = View.parse(await runState(ctx, job, number, kind));
  const rows = await ctx.db.select({ part: testParts.part, tail: testParts.tail }).from(testParts).innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .where(and(eq(testRuns.companyId, job.companyId), eq(testRuns.number, number), eq(testRuns.kind, kind), eq(testParts.status, 'running'), isNull(testParts.startedAt)));
  const positions = new Map(rows.map(row => [row.part, positionOf(row.tail)]));
  return { ...view, parts: view.parts.map(part => positions.get(part.part) ? { ...part, queuePosition: positions.get(part.part) } : part) };
}
