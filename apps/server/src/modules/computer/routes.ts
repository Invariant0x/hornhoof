import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { requirePerson } from '../../auth/session.js';
import { ApiError } from '../../errors.js';
import { enqueueTurn, NoSubscription, orchestratorOf } from '../conversation/queue.js';
import { appendEvent } from '../events/store.js';
import { onMachine, ownsComputer, serverMachine } from './access.js';

/* The note that starts the orchestrator's turn once the CEO opened access: the CEO's order, so it may use the computer. */
const openedNote = (until: string, reason: string, machine: string | null) =>
  `The CEO opened access to the computer the server runs on${machine ? ` (${machine})` : ''} until ${until}. Go on with what you asked it for: ${reason}`;

/* Access to the computer the server runs on: the CEO's own screen opens it for a day, closes it, or says no to the
   orchestrator's request. Never another person, and never the orchestrator acting for the CEO. */
export function computerRoutes(app: FastifyInstance, ctx: Ctx): void {
  async function ceo(req: FastifyRequest) {
    const me = await requirePerson(req, ctx.db);
    if (!ownsComputer(me)) throw new ApiError(403, 'forbidden', 'Only the CEO opens and closes access to the computer.', 'not_owner');
    return me;
  }

  /* A line in the orchestrator's window, by the CEO when the CEO did it. */
  async function line(companyId: string, data: Record<string, string>, personId: string | null) {
    const orchestrator = await orchestratorOf(ctx, companyId);
    if (orchestrator) await appendEvent(ctx, { companyId, agentId: orchestrator.id, kind: 'computer', data, personId });
    return orchestrator;
  }

  /* What the CEO sees: the state, and which machine it is, the same from every screen of theirs. */
  const view = async (companyId: string) => ({ ...ctx.computer.view(), machine: await serverMachine(ctx, companyId) });
  /* The CEO's other screens fetch it again, once the file says the new state. */
  const changed = (companyId: string) => ctx.bus.publish(companyId, { type: 'computer' });

  app.get('/api/computer', async req => {
    const me = await ceo(req);
    return view(me.companyId);
  });

  app.post('/api/computer/open', async req => {
    const me = await ceo(req);
    if (!ctx.computer.available()) {
      throw new ApiError(409, 'conflict', "Hornhoof cannot reach this computer: its updater does not run. Run this server's install command again, it adds it.", 'updater_missing');
    }
    const { until, asked } = ctx.computer.open();
    changed(me.companyId);
    const machine = await serverMachine(ctx, me.companyId);
    const orchestrator = await line(me.companyId, { state: 'opened', until, ...onMachine(machine) }, me.id);
    /* The note waits in his line while his machine is offline, and goes out when it is back. */
    if (orchestrator && asked) {
      await enqueueTurn(ctx, { companyId: me.companyId, agentId: orchestrator.id, prompt: openedNote(until, asked.reason, machine), createdBy: me.id, answersCeo: true }).catch(err => {
        if (!(err instanceof NoSubscription)) throw err;
      });
    }
    return view(me.companyId);
  });

  app.post('/api/computer/close', async req => {
    const me = await ceo(req);
    ctx.computer.close();
    changed(me.companyId);
    await line(me.companyId, { state: 'closed', ...onMachine(await serverMachine(ctx, me.companyId)) }, me.id);
    return view(me.companyId);
  });

  app.post('/api/computer/decline', async req => {
    const me = await ceo(req);
    if (ctx.computer.decline()) {
      changed(me.companyId);
      await line(me.companyId, { state: 'declined', ...onMachine(await serverMachine(ctx, me.companyId)) }, me.id);
    }
    return view(me.companyId);
  });
}
