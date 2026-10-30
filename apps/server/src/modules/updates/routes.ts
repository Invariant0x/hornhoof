import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';

/* The updater is the separate service that swaps the images; Task 3 fills this in. */
export type UpdaterView = { present: boolean; status: null };

/* Which build runs, which are published, and whether a newer one is out. Only for people who see the whole company. */
export function updateRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { version, commit, migrations } = ctx.config;

  async function view(req: FastifyRequest) {
    requireCompanyScope(await requirePerson(req, ctx.db));
    const state = ctx.updates.state();
    const updater: UpdaterView = { present: false, status: null };
    return {
      current: { version, commit, migrations },
      available: Boolean(state.latest?.commit && state.latest.commit !== commit),
      ...state,
      updater,
    };
  }

  app.get('/api/updates', view);

  app.post('/api/updates/check', async req => {
    await view(req);
    await ctx.updates.now();
    return view(req);
  });
}
