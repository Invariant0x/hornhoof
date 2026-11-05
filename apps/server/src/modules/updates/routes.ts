import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { ApiError, loggable } from '../../errors.js';
import { modeGate } from '../keeper/app-mode.js';
import type { UpdateRequest, UpdaterView } from './control.js';
import type { Build } from './registry.js';
import { sendToUpdater, UpdateWait } from './wait.js';

export const UpdateBody = z.object({ version: z.string().min(1).max(128), whenIdle: z.boolean().default(true) });
const FULL_SHA = /^[0-9a-f]{40}$/;

function updatesView(ctx: Ctx, wait: UpdateWait) {
  const { version, commit, migrations } = ctx.config;
  const state = ctx.updates.state();
  const updater: UpdaterView = { present: ctx.updater.present(), status: ctx.updater.status(), waiting: wait.shown() };
  return { current: { version, commit, migrations }, available: Boolean(state.latest?.commit && state.latest.commit !== commit), ...state, updater };
}

/* The image tag names the build: a version tag moves when that version is built again, a commit's does not. The
   digests pin it: the updater installs only the app image the app read, and the node and updater images of the
   same tag, read now. */
async function requestFor(ctx: Ctx, build: Build, id: string): Promise<UpdateRequest> {
  const tag = FULL_SHA.test(build.commit) ? build.commit : build.tag;
  const siblings = await ctx.updates.siblings(tag).catch(err => {
    ctx.log.warn({ error: loggable(err) }, 'Could not read the node and updater images of the build.');
    throw new ApiError(503, 'unavailable', 'Could not read this version from the registry. Check the internet connection, then try again.', 'registry_unreachable');
  });
  return { id, version: build.version || build.tag, commit: build.commit, tag, digest: build.digest, nodeDigest: siblings.node, updaterDigest: siblings.updater };
}

/* The running build summary is for every signed-in person. Published builds and update controls
   are for people who see the whole company. */
export function updateRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { version, commit } = ctx.config;
  const wait = new UpdateWait(ctx);
  ctx.mode.whenLeaving(() => wait.standDown());

  async function companyPerson(req: FastifyRequest) {
    const me = await requirePerson(req, ctx.db);
    requireCompanyScope(me);
    return me;
  }

  app.get('/api/updates/current', async req => {
    await requirePerson(req, ctx.db);
    return { version, commit: commit.slice(0, 7) };
  });

  app.get('/api/updates', async req => {
    await companyPerson(req);
    return updatesView(ctx, wait);
  });

  app.post('/api/updates/check', async req => {
    await companyPerson(req);
    await ctx.updates.now();
    return updatesView(ctx, wait);
  });

  app.post('/api/updates', async (req, reply) => {
    const me = await companyPerson(req);
    const body = UpdateBody.parse(req.body);
    if (!ctx.updater.present()) {
      throw new ApiError(503, 'unavailable', 'The updater is not running. Run install.sh server again to update.', 'updater_missing');
    }
    if (ctx.updater.status()?.state === 'running') throw new ApiError(409, 'conflict', 'An update is running already.', 'update_running');
    if (!ctx.updates.state().checkedAt) await ctx.updates.now();
    const { latest, versions } = ctx.updates.state();
    const build = body.version === 'latest' ? latest : versions.find(v => v.tag === body.version);
    if (!build) throw new ApiError(400, 'validation', `There is no published build ${body.version}.`, 'version_unknown');
    const request = await requestFor(ctx, build, randomUUID());
    /* Reading the registry takes a while, and the app may have stopped leading meanwhile. */
    await modeGate(ctx.mode)(req);
    wait.callOff();
    if (body.whenIdle) await wait.sendWhenIdle(me.companyId, request);
    else sendToUpdater(ctx, request);
    return reply.code(202).send({ id: request.id });
  });

  app.delete('/api/updates', async (req, reply) => {
    await companyPerson(req);
    wait.callOff();
    return reply.code(204).send();
  });
}
