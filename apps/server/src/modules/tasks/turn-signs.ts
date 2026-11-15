import { and, inArray, max } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents } from '../../db/schema.js';

/* What a turn's program streams of its work through its node: its answer, its tools and their results, its list of steps. */
const WORK = ['text', 'tool', 'tool_result', 'todo'] as const;

/* When each running turn last showed that it goes on, besides what its node reports of its program: an event of its work
   its node streamed, or a call of a Hornhoof tool with its token. A program with no screen reports nothing else. Kept in
   memory; after a restart of the server the events of its work stored before stand for it. */
const signs = new WeakMap<Ctx, Map<string, number>>();

function signsOf(ctx: Ctx): Map<string, number> {
  const map = signs.get(ctx) ?? new Map<string, number>();
  signs.set(ctx, map);
  return map;
}

export function turnSign(ctx: Ctx, jobId: string, at = Date.now()): void {
  const map = signsOf(ctx);
  map.set(jobId, Math.max(map.get(jobId) ?? at, at));
}

export function dropTurnSign(ctx: Ctx, jobId: string): void {
  signsOf(ctx).delete(jobId);
}

/* The last sign of each of these turns, in ms; none for a turn that gave none. */
export async function lastTurnSigns(ctx: Ctx, jobIds: readonly string[]): Promise<Map<string, number>> {
  const last = new Map<string, number>();
  if (!jobIds.length) return last;
  const stored = await ctx.db.select({ jobId: agentEvents.jobId, at: max(agentEvents.createdAt) }).from(agentEvents)
    .where(and(inArray(agentEvents.jobId, [...jobIds]), inArray(agentEvents.kind, [...WORK]))).groupBy(agentEvents.jobId);
  for (const { jobId, at } of stored) if (jobId && at) last.set(jobId, at.getTime());
  const kept = signsOf(ctx);
  for (const jobId of jobIds) {
    const at = kept.get(jobId);
    if (at !== undefined) last.set(jobId, Math.max(last.get(jobId) ?? at, at));
  }
  return last;
}
