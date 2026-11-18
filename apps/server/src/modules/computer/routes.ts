import { notificationMessage } from '../events/notifications.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { actorOf, personOf, requirePerson, type Person } from '../../auth/session.js';
import { ApiError } from '../../errors.js';
import { enqueueTurn } from '../conversation/queue.js';
import { NoSubscription } from '../conversation/turn-records.js';
import { computerLine } from './expiry.js';
import { canViewComputer, logName, onMachine, type AccessMachine, type AccessView } from './access.js';
import { seenAccess } from './seen.js';
import { STARTS_FIRST } from '../sources/requests.js';

const IdParams = z.object({ id: z.uuid() });
const Signed = z.string().min(1).max(4096);
const OpenBody = z.object({ scope: z.enum(['orchestrator', 'all_agents']).default('orchestrator'), duration: z.enum(['1h', '8h', '24h']).default('1h'), grant: z.object({ payload: Signed, signature: Signed }).optional() });

/* Who opened it, as the orchestrator is told. */
const opener = (by: Person): string => (by.via ? 'The orchestrator' : by.isOwner ? 'The CEO' : actsAsCeo(by) ? `The CEO delegate ${by.name}` : by.name);

/* The note that starts the orchestrator's turn once a machine was opened for what it asked: the order of whoever opened
   it, so that turn may use the machine. */
const openedNote = (by: Person, until: string, reason: string, machine: string) => `${opener(by)} opened access to ${machine} until ${until}. Go on with what you asked it for: ${reason}`;

/* Computer access to each machine of the company that has its core. Its owner's own screen opens it for a day, closes it,
   or says no to the orchestrator's request; the CEO and the CEO delegate close any. People who see the whole company see
   every machine's access, and everyone sees their own machines'. The orchestrator sees and changes them all; never a head
   acting for anyone. */
export function computerRoutes(app: FastifyInstance, ctx: Ctx): void {
  async function seen(me: Person): Promise<AccessView[]> {
    if (me.viaHead) throw new ApiError(403, 'forbidden', "Only a person's own screen sees and changes computer access, or the orchestrator.", 'company_scope_only');
    return seenAccess(ctx, me);
  }

  async function seenOne(me: Person, machineId: string): Promise<AccessView> {
    const view = (await seen(me)).find(one => one.machine.id === machineId);
    if (!view) throw new ApiError(403, 'forbidden', "Only a machine's owner and people who see the whole company see access to it.", 'company_scope_only');
    return view;
  }

  /* Nothing of the server's own machine is changed before this app has taken over what an app from before left of its
     access. Every other machine is served meanwhile. */
  async function served(machineId: string): Promise<void> {
    if (!(await ctx.computer.served(machineId))) throw new ApiError(503, 'unavailable', 'This server does not serve computer access yet. Try again in a moment.');
  }

  /* Every person's screens fetch their own views again. */
  const changed = (companyId: string) => ctx.bus.publish(companyId, { type: 'computer' });

  async function open(me: Person, machineId: string, body: unknown): Promise<AccessView> {
    await served(machineId);
    const { machine, until, asked, scope } = await ctx.computer.open(me, machineId, OpenBody.parse(body ?? {}));
    changed(me.companyId);
    const orchestrator = await computerLine(ctx, me.companyId, { state: 'opened', until, scope, ...onMachine(logName(machine)) }, personOf(me));
    /* The note waits in his line while his machine is offline, and goes out when it is back. */
    if (orchestrator && asked) {
      const note = await notificationMessage(ctx, me.companyId, 'computer_access', openedNote(me, until, asked.reason, machine.name), { actor: actorOf(me) });
      const message = { ...note, computerAccess: { machineId: machine.id } };
      await enqueueTurn(ctx, { companyId: me.companyId, agentId: orchestrator.id, prompt: message.text, createdBy: personOf(me), answersCeo: !me.via, message }).catch(err => {
        if (!(err instanceof NoSubscription)) throw err;
      });
    }
    return seenOne(me, machineId);
  }

  async function close(me: Person, machineId: string): Promise<AccessView> {
    await served(machineId);
    const machine = await ctx.computer.close(me, machineId);
    changed(me.companyId);
    await computerLine(ctx, me.companyId, { state: 'closed', ...onMachine(logName(machine)) }, personOf(me));
    return seenOne(me, machineId);
  }

  async function decline(me: Person, machineId: string): Promise<AccessView> {
    await served(machineId);
    const machine = await ctx.computer.decline(me, machineId);
    if (machine) {
      changed(me.companyId);
      await computerLine(ctx, me.companyId, { state: 'declined', ...onMachine(logName(machine)) }, personOf(me));
    }
    return seenOne(me, machineId);
  }

  const idOf = (req: FastifyRequest) => IdParams.parse(req.params).id;

  app.get('/api/machines/access', async req => ({ views: await seen(await requirePerson(req, ctx.db)) }));

  app.post('/api/machines/:id/access/open', STARTS_FIRST, async req => open(await requirePerson(req, ctx.db), idOf(req), req.body));
  app.post('/api/machines/:id/access/close', STARTS_FIRST, async req => close(await requirePerson(req, ctx.db), idOf(req)));
  app.post('/api/machines/:id/access/decline', STARTS_FIRST, async req => decline(await requirePerson(req, ctx.db), idOf(req)));

  /* The machine the person sits at, and its access as they see it: the account menu offers it to its owner there. */
  app.get('/api/machines/here', async req => {
    const me = await requirePerson(req, ctx.db);
    const machine: AccessMachine | null = me.via ? null : await ctx.computer.here(req, me.companyId);
    const view = machine ? ((await seen(me)).find(one => one.machine.id === machine.id) ?? null) : null;
    return { machine: view ? machine : null, view };
  });

  /* The routes of before access was per machine, for a page loaded then: the machine this server runs on, for the
     people who saw it then. */
  function sawBefore(me: Person): void {
    if (!canViewComputer(me)) throw new ApiError(403, 'forbidden', 'Only people who see the whole company see access to the computer.', 'company_scope_only');
  }
  async function ownMachine(me: Person): Promise<string | null> {
    sawBefore(me);
    const machine = await ctx.computer.find(me.companyId);
    return machine === 'none' || machine === 'ambiguous' ? null : machine.id;
  }
  async function ownMachineOr404(me: Person): Promise<string> {
    const id = await ownMachine(me);
    if (!id) throw new ApiError(404, 'not_found', "This server's machine has none of the company's core yet.", 'no_core');
    return id;
  }
  const asBefore = (view: AccessView) => ({ available: view.reachable, until: view.until, asked: view.asked, machine: logName(view.machine), canAnswer: view.canOpen, machineId: view.machine.id });
  /* A server whose own machine has no core yet has no access to offer. */
  const NONE_YET = { available: false, until: null, asked: null, machine: null, canAnswer: false, machineId: null };

  app.get('/api/computer', async req => {
    const me = await requirePerson(req, ctx.db);
    const id = await ownMachine(me);
    return id ? asBefore(await seenOne(me, id)) : NONE_YET;
  });
  app.post('/api/computer/open', STARTS_FIRST, async req => {
    const me = await requirePerson(req, ctx.db);
    return asBefore(await open(me, await ownMachineOr404(me), req.body));
  });
  app.post('/api/computer/close', STARTS_FIRST, async req => {
    const me = await requirePerson(req, ctx.db);
    return asBefore(await close(me, await ownMachineOr404(me)));
  });
  app.post('/api/computer/decline', STARTS_FIRST, async req => {
    const me = await requirePerson(req, ctx.db);
    return asBefore(await decline(me, await ownMachineOr404(me)));
  });
}
