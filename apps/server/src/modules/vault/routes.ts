import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { changeEntry, companyEntries, createEntry, entryById, entryLog, entryViews, EntryChange, NewEntry, notAllowed, parseBody, removeEntry, unknownEntry, type Entry } from './store.js';

/* The vault for people: any person of the company sees what entries there are and adds one; the person who added an entry
   and the CEO change and remove it. A password or code secret comes in only from a person at the form, never from an
   agent acting as one, and never goes back out. */

const IdParams = z.strictObject({ id: z.string() });

/* A person at the form, not an agent acting for one. */
async function requireTyping(req: FastifyRequest, ctx: Ctx): Promise<Person> {
  const me = await requirePerson(req, ctx.db);
  if (me.via) throw notAllowed('Only a person types a password into the vault, at its form in Hornhoof.');
  return me;
}

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
    const me = await requireTyping(req, ctx);
    const input = parseBody(NewEntry, req.body);
    const [view] = await entryViews(ctx, [await createEntry(ctx, me.companyId, me.id, input)]);
    return reply.code(201).send(view);
  });

  app.patch('/api/vault/:id', async req => {
    const me = await requireTyping(req, ctx);
    const entry = await entryOf(ctx, me, IdParams.parse(req.params).id);
    requireOwnOrCeo(me, entry);
    const input = parseBody(EntryChange, req.body);
    const [view] = await entryViews(ctx, [await changeEntry(ctx, entry, me.id, input)]);
    return view;
  });

  app.delete('/api/vault/:id', async (req, reply) => {
    const me = await requireTyping(req, ctx);
    const entry = await entryOf(ctx, me, IdParams.parse(req.params).id);
    requireOwnOrCeo(me, entry);
    await removeEntry(ctx, entry, me.id);
    return reply.code(204).send();
  });

  app.get('/api/vault/:id/log', async req => {
    const me = await requirePerson(req, ctx.db);
    const entry = await entryOf(ctx, me, IdParams.parse(req.params).id);
    return { log: await entryLog(ctx, entry.id) };
  });
}
