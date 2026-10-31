import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { agents, jobs } from '../../db/schema.js';
import { appendEvent } from '../events/store.js';
import { insertTurn, liveSubscription, onAgent, pump } from '../conversation/queue.js';
import type { AgentRow } from './find.js';

/* How often, in minutes, an employee may wake on its timer, and how long its order may be. */
export const TIMER_MIN = 5;
export const TIMER_MAX = 1440;
export const TIMER_ORDER_MAX = 2000;
/* Hornhoof looks for due rounds this often. */
const TICK_MS = 60_000;

export const timerOf = (a: AgentRow) => (a.timerMinutes && a.timerOrder ? { minutes: a.timerMinutes, order: a.timerOrder, lastAt: a.timerAt?.toISOString() ?? null } : null);

const every = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}` : `${minutes} minutes`);

/* What a round tells the employee: why it woke, and its order. */
export const roundPrompt = (a: Pick<AgentRow, 'timerMinutes' | 'timerOrder'>) =>
  `Hornhoof woke you on your timer, which runs every ${every(a.timerMinutes ?? 0)}, outside any task. Do your round:\n\n${a.timerOrder ?? ''}`;

/* Starts a round for each employee whose timer is due at `now`: one that is on, has a subscription and has no turn waiting
   or running. A busy one is tried again on the next tick. Returns how many rounds it started. */
export async function timerTick(ctx: Ctx, now = new Date()): Promise<number> {
  const { db } = ctx;
  const timed = await db
    .select()
    .from(agents)
    .where(and(isNotNull(agents.timerMinutes), isNotNull(agents.subscriptionId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  let started = 0;
  for (const agent of timed) {
    if (agent.timerAt && now.getTime() - agent.timerAt.getTime() < agent.timerMinutes! * 60_000) continue;
    if (!(await liveSubscription(ctx, agent.id))) continue;
    const queued = await onAgent(ctx, agent.id, async () => {
      const [open] = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.agentId, agent.id), inArray(jobs.status, ['queued', 'running'])))
        .limit(1);
      if (open) return false;
      const prompt = roundPrompt(agent);
      const jobId = await insertTurn(ctx, { companyId: agent.companyId, agentId: agent.id, prompt, createdBy: null });
      await appendEvent(ctx, { companyId: agent.companyId, agentId: agent.id, jobId, kind: 'message', data: { text: prompt, timer: true } });
      await db.update(agents).set({ timerAt: now }).where(eq(agents.id, agent.id));
      return true;
    });
    if (!queued) continue;
    started++;
    /* Outside the agent's line, which the pump waits on. */
    await pump(ctx, agent.id);
  }
  return started;
}

/* Looks for due rounds every minute while the server runs. */
export function startTimers(app: FastifyInstance, ctx: Ctx): void {
  const timer = setInterval(() => void timerTick(ctx).catch(err => app.log.error(err, 'timer round failed')), TICK_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
