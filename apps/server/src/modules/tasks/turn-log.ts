import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, taskEvents, tasks, type jobs } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { appendEvent } from '../events/store.js';
import { published } from './events.js';
import { saying } from '../../locales/index.js';

type Turn = Pick<typeof jobs.$inferSelect, 'id' | 'companyId' | 'agentId' | 'taskId'>;

/* Hornhoof's facts appear in both places people follow the work, without moving the task. */
export async function logTurnFact(ctx: Ctx, job: Turn, text: string, data: Record<string, unknown> = {}): Promise<void> {
  if (!job.agentId) return;
  await appendEvent(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id, kind: 'message', data: { ...data, text, turnFact: true, notification: { source: 'turn_fact', tasks: [], detail: saying(words => words.notices.turn(job.id)) } } });
  if (!job.taskId) return;
  const [agent] = await ctx.db.select(only(agents, 'name')).from(agents).where(eq(agents.id, job.agentId));
  await ctx.db.insert(taskEvents).values({ companyId: job.companyId, taskId: job.taskId, agentId: null, kind: 'comment', text: `${agent?.name ?? 'The agent'}: ${text}`, data: { ...data, job: job.id, agent: job.agentId } });
  const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, job.taskId));
  if (task) published(ctx, task);
}
