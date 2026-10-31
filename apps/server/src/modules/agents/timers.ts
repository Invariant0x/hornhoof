import { and, eq, gt, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { agents, jobs, tasks } from '../../db/schema.js';
import { appendEvent } from '../events/store.js';
import { agentState, insertTurn, liveSubscription, onAgent, pump, STOPPED_ON_PURPOSE } from '../conversation/queue.js';
import type { AgentRow } from './find.js';

export { TIMER_MAX, TIMER_MIN, TIMER_ORDER_MAX } from '../templates/load.js';
/* Hornhoof looks for due rounds this often. */
const TICK_MS = 60_000;

export const timerOf = (a: AgentRow) =>
  a.timerMinutes && a.timerOrder ? { minutes: a.timerMinutes, order: a.timerOrder, forWork: a.timerForWork, lastAt: a.timerAt?.toISOString() ?? null } : null;

const due = (a: AgentRow, now: Date) => !a.timerAt || now.getTime() - a.timerAt.getTime() >= a.timerMinutes! * 60_000;
/* Still timed, on and in the company. */
const timed = and(isNotNull(agents.timerMinutes), isNotNull(agents.subscriptionId), isNull(agents.removedAt), isNull(agents.switchedOffAt));

/* What a timer for work looks at: a task still open in the company, or a turn that failed since the last round. */
async function workFor(ctx: Ctx, a: AgentRow): Promise<boolean> {
  const [open] = await ctx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.companyId, a.companyId), notInArray(tasks.status, ['planned', 'done', 'cancelled'])))
    .limit(1);
  if (open) return true;
  const [failed] = await ctx.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.companyId, a.companyId),
        eq(jobs.status, 'failed'),
        or(isNull(jobs.error), notInArray(jobs.error, STOPPED_ON_PURPOSE)),
        a.timerAt ? gt(jobs.finishedAt, a.timerAt) : undefined,
      ),
    )
    .limit(1);
  return Boolean(failed);
}

const every = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}` : `${minutes} minutes`);

/* What a round tells the employee: why it woke, and its order. */
export const roundPrompt = (a: Pick<AgentRow, 'timerMinutes' | 'timerOrder'>) =>
  `Hornhoof woke you on your timer, which runs every ${every(a.timerMinutes ?? 0)}, outside any task. Do your round:\n\n${a.timerOrder ?? ''}`;

/* Starts a round for each employee whose timer is due at `now`: one that is on, ready to run and has no turn waiting or
   running, looked at again once its line is free. A busy one is tried again on the next tick; a timer for work with
   nothing to look at skips its round. Returns how many rounds it started. */
export async function timerTick(ctx: Ctx, now = new Date(), report: (err: unknown) => void = () => {}): Promise<number> {
  const { db } = ctx;
  let started = 0;
  for (const { id } of await db.select({ id: agents.id }).from(agents).where(timed)) {
    try {
      const queued = await onAgent(ctx, id, async () => {
        const [agent] = await db.select().from(agents).where(and(eq(agents.id, id), timed));
        if (!agent || !due(agent, now) || !(await liveSubscription(ctx, id)) || !(await agentState(ctx, id)).ready) return false;
        const [open] = await db
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.agentId, id), inArray(jobs.status, ['queued', 'running'])))
          .limit(1);
        if (open) return false;
        if (agent.timerForWork && !(await workFor(ctx, agent))) {
          await db.update(agents).set({ timerAt: now }).where(eq(agents.id, id));
          return false;
        }
        const prompt = roundPrompt(agent);
        const jobId = await insertTurn(ctx, { companyId: agent.companyId, agentId: id, prompt, createdBy: null });
        await appendEvent(ctx, { companyId: agent.companyId, agentId: id, jobId, kind: 'message', data: { text: prompt, timer: true } });
        await db.update(agents).set({ timerAt: now }).where(eq(agents.id, id));
        return true;
      });
      if (!queued) continue;
      started++;
      /* Outside the agent's line, which the pump waits on. */
      await pump(ctx, id);
    } catch (err) {
      /* One employee's trouble does not keep the others from their rounds. */
      report(err);
    }
  }
  return started;
}

/* Looks for due rounds every minute while the server runs. */
export function startTimers(app: FastifyInstance, ctx: Ctx): void {
  const timer = setInterval(() => void timerTick(ctx, new Date(), err => app.log.error(err, 'timer round failed')).catch(err => app.log.error(err, 'timer tick failed')), TICK_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
