import { notificationMessage } from '../events/notifications.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { seesAgentId, viewerOf } from '../../auth/agent-view.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { ApiError } from '../../errors.js';
import { enqueueTurn, NoSubscription, orchestratorOf } from '../conversation/queue.js';
import { appendEvent } from '../events/store.js';
import { canViewComputer, onMachine, serverMachine } from './access.js';
import { STARTS_FIRST } from '../sources/requests.js';

/* The note that starts the orchestrator's turn once the CEO or the delegate opened access: the CEO's order, so it may use
   the computer. */
const openedNote = (by: Person, until: string, reason: string, machine: string | null) =>
  `${by.isOwner ? 'The CEO' : `The CEO delegate ${by.name}`} opened access to the computer the server runs on${machine ? ` (${machine})` : ''} until ${until}. Go on with what you asked it for: ${reason}`;

/* Access to the computer the server runs on: the CEO's or the delegate's own screen opens it for a day, closes it, or says
   no to the orchestrator's request. People who see the whole company see it. Never the orchestrator acting for the CEO. */
export function computerRoutes(app: FastifyInstance, ctx: Ctx): void {
  async function viewer(req: FastifyRequest) {
    const me = await requirePerson(req, ctx.db);
    if (!canViewComputer(me)) throw new ApiError(403, 'forbidden', 'Only people who see the whole company see access to the computer.', 'company_scope_only');
    return me;
  }
  async function ceo(req: FastifyRequest) {
    const me = await viewer(req);
    if (!actsAsCeo(me)) throw new ApiError(403, 'forbidden', 'Only the CEO or the CEO delegate opens and closes access to the computer.', 'decision_not_allowed');
    return me;
  }

  /* A line in the orchestrator's window, by the CEO when the CEO did it. */
  async function line(companyId: string, data: Record<string, string>, personId: string | null) {
    const orchestrator = await orchestratorOf(ctx, companyId);
    if (orchestrator) await appendEvent(ctx, { companyId, agentId: orchestrator.id, kind: 'computer', data, personId });
    return orchestrator;
  }

  /* What the orchestrator asked goes only to people who see him. */
  async function seenAsk(me: Person) {
    const shown = ctx.computer.view();
    const orchestrator = await orchestratorOf(ctx, me.companyId);
    return seesAgentId(await viewerOf(ctx.db, me), orchestrator?.id) ? shown : { ...shown, asked: null };
  }

  /* What people see: the state, which machine it is, the same from every screen, and whether they may change it. */
  const view = async (me: Person) => ({ ...(await seenAsk(me)), machine: await serverMachine(ctx, me.companyId), canAnswer: actsAsCeo(me) });
  /* The CEO's other screens fetch it again, once the file says the new state. */
  const changed = (companyId: string) => ctx.bus.publish(companyId, { type: 'computer' });

  app.get('/api/computer', async req => view(await viewer(req)));

  app.post('/api/computer/open', STARTS_FIRST, async req => {
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
      const message = await notificationMessage(ctx, me.companyId, 'computer_access', openedNote(me, until, asked.reason, machine), { actor: { personId: me.id } });
      await enqueueTurn(ctx, { companyId: me.companyId, agentId: orchestrator.id, prompt: message.text, createdBy: me.id, answersCeo: true, message }).catch(err => {
        if (!(err instanceof NoSubscription)) throw err;
      });
    }
    return view(me);
  });

  app.post('/api/computer/close', STARTS_FIRST, async req => {
    const me = await ceo(req);
    ctx.computer.close();
    changed(me.companyId);
    await line(me.companyId, { state: 'closed', ...onMachine(await serverMachine(ctx, me.companyId)) }, me.id);
    return view(me);
  });

  app.post('/api/computer/decline', STARTS_FIRST, async req => {
    const me = await ceo(req);
    if (ctx.computer.decline()) {
      changed(me.companyId);
      await line(me.companyId, { state: 'declined', ...onMachine(await serverMachine(ctx, me.companyId)) }, me.id);
    }
    return view(me);
  });
}
