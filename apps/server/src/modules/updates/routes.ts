import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyPerson, requirePerson } from '../../auth/session.js';
import { ApiError, loggable } from '../../errors.js';
import type { UpdateState } from './check.js';
import { modeGate } from '../keeper/app-mode.js';
import { movingTo } from '../copies/move.js';
import type { UpdateRequest, UpdaterView } from './control.js';
import { FULL_SHA, type Build } from './registry.js';
import { drainWork, serverNodes } from './drain-work.js';
import { nodeWaits } from './node-drain.js';
import { IDLE_WAIT_MINUTES, sendToUpdater, UpdateWait } from './wait.js';
import { STARTS_FIRST } from '../sources/requests.js';

/* urgent: a security update, which goes in at once and waits for no turn, and asks nobody about them. idleWaitMinutes:
   how long an update that waits for the agents waits at most before it is called off. */
export const UpdateBody = z.object({
  version: z.string().min(1).max(128),
  whenIdle: z.boolean().default(true),
  idleWaitMinutes: z.number().int().min(1).max(240).optional().describe(`With whenIdle: how many minutes to wait at most for the agents to finish, ${IDLE_WAIT_MINUTES} if left out.`),
  confirmTurns: z.number().int().nonnegative().optional(),
  urgent: z.boolean().optional(),
});

const onOffer = (state: UpdateState, commit: string): boolean => Boolean(state.latest?.commit && state.latest.commit !== commit);

async function updatesView(ctx: Ctx, wait: UpdateWait, companyId: string) {
  const { version, commit, migrations } = ctx.config;
  const state = ctx.updates.state();
  const updater: UpdaterView = { present: ctx.updater.present(), status: ctx.updater.status(), waiting: await wait.shown(companyId), calledOff: wait.shownCalledOff(companyId) };
  return { current: { version, commit, migrations }, available: onOffer(state, commit), ...state, updater, nodeWaits: await nodeWaits(ctx, companyId) };
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

/* An update now stops the turns that run, on this server's computer in any company, so it goes only for as many as the
   person saw. */
async function requireConfirmed(ctx: Ctx, confirmed: number): Promise<void> {
  const work = await Promise.all((await serverNodes(ctx)).map(node => drainWork(ctx, node)));
  const turns = work.reduce((n, w) => n + w.turnsLeft, 0);
  if (turns > confirmed) throw new ApiError(409, 'conflict', 'Confirm how many running turns this update will stop.', 'turns_would_stop', { turns });
}

/* The updater is claimed for this update in one step, so an update and a restore asked at once never both go on. */
function claimUpdater(ctx: Ctx, id: string): void {
  if (!ctx.updater.present()) {
    throw new ApiError(503, 'unavailable', 'The updater is not running. Run install.sh server again to update.', 'updater_missing');
  }
  const holder = ctx.updater.claim('update', id);
  if (holder === 'restore') throw new ApiError(409, 'conflict', 'A restore is running.', 'restore_running');
  if (holder) throw new ApiError(409, 'conflict', 'An update is running already.', 'update_running');
}

async function publishedBuild(ctx: Ctx, wanted: string): Promise<Build> {
  if (!ctx.updates.state().checkedAt) await ctx.updates.now();
  const { latest, versions } = ctx.updates.state();
  const build = wanted === 'latest' ? latest : versions.find(v => v.tag === wanted);
  if (!build) throw new ApiError(400, 'validation', `There is no published build ${wanted}.`, 'version_unknown');
  return build;
}

function howFast(body: z.infer<typeof UpdateBody>): Pick<UpdateRequest, 'urgent' | 'immediate'> {
  if (body.urgent) return { urgent: true };
  return body.whenIdle ? {} : { immediate: true };
}

/* The running build summary is for every signed-in person. Published builds and update controls
   are for people who see the whole company. */
export function updateRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { version, commit } = ctx.config;
  const wait = new UpdateWait(ctx);
  ctx.mode.whenLeaving(() => wait.standDown());

  app.get('/api/updates/current', async req => {
    await requirePerson(req, ctx.db);
    return { version, commit: commit.slice(0, 7) };
  });

  app.get('/api/updates', async req => {
    return updatesView(ctx, wait, (await requireCompanyPerson(req, ctx.db)).companyId);
  });

  app.post('/api/updates/check', async req => {
    const me = await requireCompanyPerson(req, ctx.db);
    await ctx.updates.now();
    return updatesView(ctx, wait, me.companyId);
  });

  app.post('/api/updates', STARTS_FIRST, async (req, reply) => {
    const me = await requireCompanyPerson(req, ctx.db);
    const body = UpdateBody.parse(req.body);
    if (!body.whenIdle && !body.urgent) await requireConfirmed(ctx, body.confirmTurns ?? 0);
    /* Migrations could part the shapes of the two databases a merge reads. */
    if (await ctx.merger.pending()) {
      throw new ApiError(409, 'conflict', 'A database from before a restore is still being brought back. Wait for it, or leave it out in Settings, under Company & access.', 'merge_pending');
    }
    /* An update would stop the copy the server is to move with. */
    const moving = await movingTo(ctx.db);
    if (moving !== null) throw new ApiError(409, 'conflict', `The server is moving to ${moving || 'another machine'}. Update once it moved.`, 'moving', { host: moving });
    const id = randomUUID();
    claimUpdater(ctx, id);
    try {
      const request = { ...(await requestFor(ctx, await publishedBuild(ctx, body.version), id)), ...howFast(body) };
      /* Reading the registry takes a while, and the app may have stopped leading meanwhile. */
      await modeGate(ctx.mode)(req);
      wait.callOff();
      if (request.urgent || request.immediate) sendToUpdater(ctx, request);
      else await wait.sendWhenIdle(me.companyId, request, body.idleWaitMinutes);
    } catch (err) {
      ctx.updater.free(id);
      /* An update that waited before this one still waits, and holds the updater as it did. */
      wait.keepClaim();
      throw err;
    }
    /* What it waits for, when it waits: the agents' turns and until when. */
    return reply.code(202).send({ id, waiting: await wait.shown(me.companyId) });
  });

  app.delete('/api/updates', STARTS_FIRST, async (req, reply) => {
    await requireCompanyPerson(req, ctx.db);
    wait.callOff();
    return reply.code(204).send();
  });
}
