import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { linkOf } from './link.js';

/* A name for the link, or none for a long random one. */
export const LinkBody = z.object({ name: z.string().trim().max(200).optional() }).strict();
const NameParams = z.object({ name: z.string().max(200) });

/* The company's public link at hornhoof.org: what it is, whether a name is free, and taking, changing or removing it.
   Only for people who see the whole company. */
export function linkRoutes(app: FastifyInstance, ctx: Ctx): void {
  async function companyPerson(req: FastifyRequest) {
    const me = await requirePerson(req, ctx.db);
    requireCompanyScope(me);
    return me;
  }

  app.get('/api/link', async req => {
    await companyPerson(req);
    return { link: await linkOf(ctx.db), domain: ctx.links.domain() };
  });

  app.get('/api/link/names/:name', async req => {
    await companyPerson(req);
    return ctx.links.check(NameParams.parse(req.params).name);
  });

  app.put('/api/link', async req => {
    const me = await companyPerson(req);
    const { name } = LinkBody.parse(req.body);
    return { link: await ctx.links.set(me.companyId, name) };
  });

  app.delete('/api/link', async (req, reply) => {
    const me = await companyPerson(req);
    await ctx.links.remove(me.companyId);
    return reply.code(204).send();
  });
}
