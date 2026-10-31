import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { enqueueTurn, orchestratorOf } from '../conversation/queue.js';
import { listImprovements, moveImprovement } from './store.js';

const Params = z.object({ id: z.uuid() });

/* What the orchestrator reads when the CEO takes an improvement into work. */
export function takenPrompt(person: string, i: { id: string; title: string; text: string }): string {
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

  app.get('/api/improvements', async req => ({ improvements: await listImprovements(ctx, (await person(req)).companyId) }));

  app.post('/api/improvements/:id/take', async req => {
    const me = await person(req);
    const { id } = Params.parse(req.params);
    const taken = await moveImprovement(ctx, me.companyId, id, 'open', { status: 'taken', decidedBy: me.id, result: null });
    const orchestrator = await orchestratorOf(ctx, me.companyId);
    if (orchestrator) {
      const prompt = takenPrompt(me.name, taken);
      await enqueueTurn(ctx, { companyId: me.companyId, agentId: orchestrator.id, prompt, createdBy: me.id, message: { personId: null, text: prompt } });
    }
    return { improvement: { id, status: taken.status } };
  });

  app.post('/api/improvements/:id/dismiss', async req => {
    const me = await person(req);
    const { id } = Params.parse(req.params);
    const set = await moveImprovement(ctx, me.companyId, id, 'open', { status: 'dismissed', decidedBy: me.id });
    return { improvement: { id, status: set.status } };
  });
}
