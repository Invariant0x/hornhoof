import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { viewerOf } from '../../auth/agent-view.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { changeEntry, companyEntries, createEntry, entryById, entryLog, entryViews, EntryChange, NewEntry, notAllowed, parseBody, removeEntry, unknownEntry, type Entry } from './store.js';

/* The vault for people: any person of the company sees what entries there are and adds one; the person who added an entry
   and the CEO change and remove it. The orchestrator may act for a person too. Passwords and code secrets never go back
   out through these routes. */

const IdParams = z.strictObject({ id: z.string() });

/* The entry, when it is of this person's company; an entry of another company is refused, never told apart from ours. */
async function entryOf(ctx: Ctx, me: Person, id: string): Promise<Entry> {
  const entry = await entryById(ctx, id);
  if (!entry) throw unknownEntry();
  if (entry.companyId !== me.companyId) throw notAllowed('This entry is not of your company.');
  return entry;
}

function requireOwnOrCeo(me: Person, entry: Entry): void {
  if (entry.createdBy !== me.id && !actsAsCeo(me)) throw notAllowed('Only the person who added this entry and the CEO change or remove it.');
}

export function vaultRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/vault', async req => {
    const me = await requirePerson(req, ctx.db);
    return { entries: await entryViews(ctx, await companyEntries(ctx, me.companyId)) };
  });

  app.post('/api/vault', async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const input = parseBody(NewEntry, req.body);
    const [view] = await entryViews(ctx, [await createEntry(ctx, me.companyId, me.id, input)]);
    return reply.code(201).send(view);
  });

  app.patch('/api/vault/:id', async req => {
    const me = await requirePerson(req, ctx.db);
    const entry = await entryOf(ctx, me, IdParams.parse(req.params).id);
    requireOwnOrCeo(me, entry);
    const input = parseBody(EntryChange, req.body);
    const [view] = await entryViews(ctx, [await changeEntry(ctx, entry, me.id, input)]);
    return view;
  });

  app.delete('/api/vault/:id', async (req, reply) => {
    const me = await requirePerson(req, ctx.db);
    const entry = await entryOf(ctx, me, IdParams.parse(req.params).id);
    requireOwnOrCeo(me, entry);
    await removeEntry(ctx, entry, me.id);
    return reply.code(204).send();
  });

  app.get('/api/vault/:id/log', async req => {
    const me = await requirePerson(req, ctx.db);
    const entry = await entryOf(ctx, me, IdParams.parse(req.params).id);
    return { log: await entryLog(ctx, entry.id, await viewerOf(ctx.db, me)) };
  });
}
