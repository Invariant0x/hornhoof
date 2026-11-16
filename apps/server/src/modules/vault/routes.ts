import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { viewerOf } from '../../auth/agent-view.js';
import { actorOf, requirePerson, type Person } from '../../auth/session.js';
import { changeEntry, companyEntries, createEntry, entryById, entryLog, entryViews, EntryChange, NewEntry, notAllowed, parseBody, removeEntry, unknownEntry, type Entry } from './store.js';

/* The vault for people: any person of the company, or the orchestrator acting for one, sees what entries there are, adds,
   changes and removes one. A password or code secret never goes back out here. */

const IdParams = z.strictObject({ id: z.string() });

/* The entry, when it is of this person's company; an entry of another company is refused, never told apart from ours. */
async function entryOf(ctx: Ctx, me: Person, id: string): Promise<Entry> {
  const entry = await entryById(ctx, id);
  if (!entry) throw unknownEntry();
  if (entry.companyId !== me.companyId) throw notAllowed('This entry is not of your company.');
  return entry;
}

export function vaultRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/vault', async req => {
    const me = await requirePerson(req, ctx.db);
    return { entries: await entryViews(ctx, await companyEntries(ctx, me.companyId), await viewerOf(ctx.db, me)) };
  });

  app.post('/api/vault', async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const input = parseBody(NewEntry, req.body);
    const [view] = await entryViews(ctx, [await createEntry(ctx, me.companyId, actorOf(me), input)], await viewerOf(ctx.db, me));
    return reply.code(201).send(view);
  });

  app.patch('/api/vault/:id', async req => {
    const me = await requirePerson(req, ctx.db);
    const entry = await entryOf(ctx, me, IdParams.parse(req.params).id);
    const input = parseBody(EntryChange, req.body);
    const [view] = await entryViews(ctx, [await changeEntry(ctx, entry, actorOf(me), input)], await viewerOf(ctx.db, me));
    return view;
  });

  app.delete('/api/vault/:id', async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const entry = await entryOf(ctx, me, IdParams.parse(req.params).id);
    await removeEntry(ctx, entry, actorOf(me));
    return reply.code(204).send();
  });

  app.get('/api/vault/:id/log', async req => {
    const me = await requirePerson(req, ctx.db);
    const entry = await entryOf(ctx, me, IdParams.parse(req.params).id);
    return { log: await entryLog(ctx, entry.id, await viewerOf(ctx.db, me)) };
  });
}
