import { notificationMessage } from '../events/notifications.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agentHidden, seesAgentId, viewerOf } from '../../auth/agent-view.js';
import { requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import { improvements, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { enqueueTurn, NoSubscription, orchestratorOf } from '../conversation/queue.js';
import { liveSubscription } from '../conversation/placement.js';
import { seesTask } from '../tasks/sight.js';
import { listImprovements, moveImprovement, requireOwnWork } from './store.js';

const Params = z.object({ id: z.uuid() });

/* What the orchestrator reads when the CEO takes an improvement into work. */
function takenPrompt(person: string, i: { id: string; title: string; text: string }): string {
  return (
    `${person} took an improvement into work: "${i.title}" (${i.id}).\n\n${i.text}\n\n` +
    'Do it with your tools, or give it as a task to the department that can. When it is done, or if it cannot be done, close it with close_improvement and say in a line what came of it.'
  );
}

/* What employees found to improve, for people who see the whole company: the CEO takes one into work, which the
   orchestrator then does, or sets it aside. */
export function improvementRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const person = async (req: FastifyRequest) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    return me;
  };

  /* Those of the agents this person sees, each with the tasks they see that came of it. */
  async function seenImprovements(me: Person) {
    const all = await listImprovements(ctx, me.companyId);
    const viewer = await viewerOf(db, me);
    if (viewer.full) return all;
    const mine = all.filter(i => seesAgentId(viewer, i.agent.id));
    const taskIds = [...new Set(mine.flatMap(i => i.tasks.map(t => t.id)))];
    const rows = taskIds.length ? await db.select().from(tasks).where(inArray(tasks.id, taskIds)) : [];
    const seen = new Set(rows.filter(t => seesTask(viewer, t)).map(t => t.id));
    return mine.map(i => ({ ...i, tasks: i.tasks.filter(t => seen.has(t.id)) }));
  }

  /* An improvement stays the business of whoever sees the agent who found it. */
  async function requireSeen(me: Person, id: string) {
    const [found] = await db.select({ agentId: improvements.agentId, scope: improvements.scope }).from(improvements).where(and(eq(improvements.id, id), eq(improvements.companyId, me.companyId)));
    if (found && !seesAgentId(await viewerOf(db, me), found.agentId)) throw agentHidden();
    return found;
  }

  app.get('/api/improvements', async req => ({ improvements: await seenImprovements(await person(req)) }));

  app.post('/api/improvements/:id/take', async req => {
    const me = await person(req);
    const { id } = Params.parse(req.params);
    const found = await requireSeen(me, id);
    if (found) requireOwnWork(found, ctx.config.feedbackInbox);
    /* Taken means the orchestrator has it, so it stays waiting while the orchestrator has nothing to run on. */
    const orchestrator = await orchestratorOf(ctx, me.companyId);
    const unable = () => new ApiError(409, 'conflict', 'The orchestrator has no subscription to run on. Pick one on its card first.', 'no_subscription');
    if (!orchestrator || !(await liveSubscription(ctx, orchestrator.id))) throw unable();
    const taken = await moveImprovement(ctx, me.companyId, id, 'open', { status: 'taken', decidedBy: me.id, result: null });
    const prompt = takenPrompt(me.name, taken);
    try {
      const message = await notificationMessage(ctx, me.companyId, 'improvement', prompt, { actor: { personId: me.id } });
      await enqueueTurn(ctx, { companyId: me.companyId, agentId: orchestrator.id, prompt: message.text, createdBy: me.id, message });
    } catch (err) {
      /* Undone only when no turn was stored: a stored one is the orchestrator's to finish and close. */
      if (!(err instanceof NoSubscription)) throw err;
      await moveImprovement(ctx, me.companyId, id, 'taken', { status: 'open', decidedBy: null });
      throw unable();
    }
    return { improvement: { id, status: taken.status } };
  });

  app.post('/api/improvements/:id/dismiss', async req => {
    const me = await person(req);
    const { id } = Params.parse(req.params);
    await requireSeen(me, id);
    const set = await moveImprovement(ctx, me.companyId, id, 'open', { status: 'dismissed', decidedBy: me.id });
    return { improvement: { id, status: set.status } };
  });
}
