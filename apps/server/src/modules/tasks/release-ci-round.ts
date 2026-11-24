import { and, asc, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { ciDispatches, tasks, turnReleases, turns } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { enqueueTurn } from '../conversation/queue.js';
import { repoAt } from '../departments/repository.js';
import type { CiAt } from '../testruns/github-ci.js';
import { ciLine, readCiOf } from './release-ci.js';
import { recordRelease } from './releases.js';
import type { Task } from './state.js';

/* The releases that wait for the CI the server started (release-dispatch.ts). Every minute each is looked at on its own: the
   release is recorded where CI is green, through the same refusals as release_turn, or the request ends with why it came to
   nothing, and the holder is told either way. */

type Row = typeof ciDispatches.$inferSelect;

/* How long a started request may go on with no run listed on its commit before it is ended. */
const NO_RUN_MS = 20 * 60_000;

/* What the holder is told once, in words and with the task, as a service message of the server. */
async function tell(ctx: Ctx, row: Row, text: string): Promise<void> {
  const [task] = await ctx.db.select({ id: tasks.id, number: tasks.number }).from(tasks).where(eq(tasks.id, row.taskId));
  const detail = { en: 'release CI', ru: 'CI выпуска' };
  await enqueueTurn(ctx, { companyId: row.companyId, agentId: row.agentId, prompt: text, createdBy: null, message: { personId: null, text, notification: { source: 'service', tasks: task ? [task] : [], detail } } });
}

const settle = (ctx: Ctx, row: Row, set: { state: 'recorded'; releaseId: string } | { state: 'ended'; note: string }) =>
  ctx.db.update(ciDispatches).set({ ...set, settledAt: new Date(ctx.clock()) }).where(and(eq(ciDispatches.id, row.id), eq(ciDispatches.state, 'waiting'))).returning();

/* What a request that waits does on what CI says of its commit: records the release, ends with why, or waits on. */
type Next = { do: 'record' } | { do: 'end'; note: string } | { do: 'wait' };
const RECORDS = new Set(['green', 'none']);
const NOTHING_WILL_COME = new Set(['red', 'idle', 'stripped', 'unnamed', 'unsupported']);
function nextOf(ci: CiAt, row: Row, now: number): Next {
  if (RECORDS.has(ci.state)) return { do: 'record' };
  if (NOTHING_WILL_COME.has(ci.state)) return { do: 'end', note: ciLine(ci) };
  const lost = ci.state === 'absent' && now - row.createdAt.getTime() > NO_RUN_MS;
  return lost ? { do: 'end', note: `no GitHub Actions run appeared on the commit within ${NO_RUN_MS / 60_000} minutes of starting it.` } : { do: 'wait' };
}

/* Whether the request has nothing to wait for: its turn was released, or its release task closed. */
const moved = (task: Task | undefined, turn: typeof turns.$inferSelect | undefined): boolean => !task || !turn || turn.status !== 'open' || task.status === 'done' || task.status === 'cancelled';

/* One request that waits: recorded where its release was recorded meanwhile or CI is green; ended where CI came to nothing, or
   the turn or the task moved on; otherwise it waits on. */
async function settleOne(ctx: Ctx, row: Row): Promise<void> {
  const [recorded] = await ctx.db.select().from(turnReleases).where(and(eq(turnReleases.turnId, row.turnId), eq(turnReleases.commit, row.commit))).limit(1);
  if (recorded) {
    await settle(ctx, row, { state: 'recorded', releaseId: recorded.id });
    return;
  }
  const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, row.taskId));
  const [turn] = await ctx.db.select().from(turns).where(eq(turns.id, row.turnId));
  if (moved(task, turn)) {
    await end(ctx, row, 'the turn was released, or the release task closed, before CI was green.', false);
    return;
  }
  const found = ctx.config ? await repoAt({ db: ctx.db, config: ctx.config }, [task!.productId, task!.departmentId]) : null;
  if (!found) return;
  const next = nextOf(await readCiOf(ctx, found.repo, row.commit), row, ctx.clock());
  if (next.do === 'record') await recordWaiting(ctx, row, task!);
  else if (next.do === 'end') await end(ctx, row, next.note);
}

async function end(ctx: Ctx, row: Row, note: string, say = true): Promise<void> {
  if (!(await settle(ctx, row, { state: 'ended', note })).length || !say) return;
  await tell(ctx, row, `CI on ${row.commit} ended with no release recorded: ${note} Hornhoof starts CI once for each commit: push a new commit to ${row.branch}, and record that one with release_turn.`);
}

async function recordWaiting(ctx: Ctx, row: Row, task: Task): Promise<void> {
  try {
    const view = await recordRelease(ctx, row.agentId, row.companyId, { task: task.number, commit: row.commit });
    /* Its own read of CI may have seen no run where the round saw green: nothing is recorded, and the request waits on. */
    if (!('release' in view)) return;
    if (!(await settle(ctx, row, { state: 'recorded', releaseId: view.release })).length) return;
    await tell(ctx, row, `CI is green on ${row.commit} and the release of it is recorded. ${'next' in view ? view.next : ''}`);
  } catch (error) {
    await end(ctx, row, error instanceof Error ? error.message : 'the release could not be recorded.');
  }
}

/* Every minute: each request that waits for CI is looked at on its own; one that fails keeps no other from it. */
export async function releaseCiRound(ctx: Ctx): Promise<void> {
  const waiting = await ctx.db.select().from(ciDispatches).where(eq(ciDispatches.state, 'waiting')).orderBy(asc(ciDispatches.createdAt));
  for (const row of waiting) {
    try {
      await settleOne(ctx, row);
    } catch (error) {
      ctx.log?.error({ error: loggable(error), companyId: row.companyId, commit: row.commit }, 'Looking at a release that waits for CI failed.');
    }
  }
}
