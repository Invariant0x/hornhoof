import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { personOf, requirePerson, type Person } from '../../auth/session.js';
import { ApiError } from '../../errors.js';
import { computerLine } from './events.js';
import { canViewComputer, logName, onMachine, type AccessMachine, type AccessView } from './access.js';
import { seenAccess } from './seen.js';
import { STARTS_FIRST } from '../sources/requests.js';

const IdParams = z.object({ id: z.uuid() });
/* The machine card shows standing access and lets its owner close it or reopen it. */
export function computerRoutes(app: FastifyInstance, ctx: Ctx): void {
  async function seen(me: Person): Promise<AccessView[]> {
    if (me.viaHead) throw new ApiError(403, 'forbidden', "Computer access is visible to machine owners and people who see the whole company.", 'company_scope_only');
    return seenAccess(ctx, me);
  }

  async function seenOne(me: Person, machineId: string): Promise<AccessView> {
    const view = (await seen(me)).find(one => one.machine.id === machineId);
    if (!view) throw new ApiError(403, 'forbidden', "Only a machine's owner and people who see the whole company see access to it.", 'company_scope_only');
    return view;
  }

  async function change(me: Person, machineId: string, open: boolean): Promise<AccessView> {
    const { machine, changed } = await ctx.computer.setOpen(me, machineId, open);
    if (changed) {
      ctx.bus.publish(me.companyId, { type: 'computer' });
      await computerLine(ctx, me.companyId, { state: open ? 'reopened' : 'closed', ...onMachine(logName(machine)) }, personOf(me));
    }
    return seenOne(me, machineId);
  }

  const idOf = (req: FastifyRequest) => IdParams.parse(req.params).id;

  app.get('/api/machines/access', async req => ({ views: await seen(await requirePerson(req, ctx.db)) }));

  app.post('/api/machines/:id/access/open', STARTS_FIRST, async req => change(await requirePerson(req, ctx.db), idOf(req), true));
  app.post('/api/machines/:id/access/close', STARTS_FIRST, async req => change(await requirePerson(req, ctx.db), idOf(req), false));

  /* The machine the person sits at, and its access as they see it. */
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
  const asBefore = (view: AccessView) => ({ available: view.reachable, open: view.open, until: null, asked: null, machine: logName(view.machine), canAnswer: view.canOpen, machineId: view.machine.id });
  /* A server whose own machine has no core yet has no access to offer. */
  const NONE_YET = { available: false, open: false, until: null, asked: null, machine: null, canAnswer: false, machineId: null };

  app.get('/api/computer', async req => {
    const me = await requirePerson(req, ctx.db);
    const id = await ownMachine(me);
    return id ? asBefore(await seenOne(me, id)) : NONE_YET;
  });
  app.post('/api/computer/open', STARTS_FIRST, async req => {
    const me = await requirePerson(req, ctx.db);
    return asBefore(await change(me, await ownMachineOr404(me), true));
  });
  app.post('/api/computer/close', STARTS_FIRST, async req => {
    const me = await requirePerson(req, ctx.db);
    return asBefore(await change(me, await ownMachineOr404(me), false));
  });
}
