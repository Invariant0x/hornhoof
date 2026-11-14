import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyPerson } from '../../auth/session.js';
import { linkOf } from './link.js';
import { STARTS_FIRST } from '../sources/requests.js';

/* A name for the link, or none for a long random one. */
export const LinkBody = z.object({ name: z.string().trim().max(200).optional() }).strict();
const NameParams = z.object({ name: z.string().max(200) });

/* The company's public link at hornhoof.org: what it is, whether a name is free, and taking, changing or removing it.
   Only for people who see the whole company. */
export function linkRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/link', async req => {
    await requireCompanyPerson(req, ctx.db);
    return { link: await linkOf(ctx.db), domain: ctx.links.domain(), tls: await ctx.tls.view() };
  });

  app.get('/api/link/names/:name', async req => {
    await requireCompanyPerson(req, ctx.db);
    return ctx.links.check(NameParams.parse(req.params).name);
  });

  app.put('/api/link', STARTS_FIRST, async req => {
    const me = await requireCompanyPerson(req, ctx.db);
    const { name } = LinkBody.parse(req.body);
    return { link: await ctx.links.set(me.companyId, name) };
  });

  app.delete('/api/link', STARTS_FIRST, async (req, reply) => {
    const me = await requireCompanyPerson(req, ctx.db);
    await ctx.links.remove(me.companyId);
    return reply.code(204).send();
  });
}
