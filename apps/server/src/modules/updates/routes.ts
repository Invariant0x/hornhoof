import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { ApiError, loggable } from '../../errors.js';
import { pumpWaiting } from '../conversation/queue.js';
import { workingCount } from '../events/store.js';
import { holdTurns } from './drain.js';
import type { UpdateRequest, UpdaterView } from './control.js';
import { FULL_SHA, type Build } from './registry.js';
import { drainWork, serverNodes } from './drain-work.js';
import { cancelServerDrain, pauseNodeWork, requestServerDrain, restartServerNodes } from './node-drain.js';

export const UpdateBody = z.object({ version: z.string().min(1).max(128), whenIdle: z.boolean().default(true), confirmTurns: z.number().int().nonnegative().optional() });
/* While an update waits for the agents, the working count is checked when it changes and this often besides. */
const IDLE_CHECK_MS = 30_000;
/* An update handed over restarts Hornhoof within minutes; one that did not keeps no turns waiting longer. */
const HELD_AFTER_MS = 10 * 60_000;

type Waiting = { companyId: string; request: UpdateRequest; stop: () => void };

/* The running build summary is for every signed-in person. Published builds and update controls
   are for people who see the whole company. */
export function updateRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { version, commit, migrations } = ctx.config;
  let waiting: Waiting | null = null;

  async function companyPerson(req: FastifyRequest) {
    const me = await requirePerson(req, ctx.db);
    requireCompanyScope(me);
    return me;
  }

  function view() {
    const state = ctx.updates.state();
    const updater: UpdaterView = {
      present: ctx.updater.present(),
      status: ctx.updater.status(),
      waiting: waiting && { version: waiting.request.version, commit: waiting.request.commit },
    };
    return { current: { version, commit, migrations }, available: Boolean(state.latest?.commit && state.latest.commit !== commit), ...state, updater };
  }

  /* release: the turns held for the update start again; an update handed over keeps them for the restart. */
  function callOff(release = true) {
    waiting?.stop();
    if (waiting && release) letTurnsGo(waiting.companyId);
    waiting = null;
  }

  function letTurnsGo(companyId: string) {
    holdTurns(ctx, companyId, false);
    cancelServerDrain(ctx);
    void pumpWaiting(ctx).catch(err => app.log.error({ error: loggable(err) }, 'Could not start the turns held for an update.'));
  }

  /* The image tag names the build: a version tag moves when that version is built again, a commit's does not. The
     digests pin it: the updater installs only the app image the app read, and the node and updater images of the
     same tag, read now. */
  async function requestFor(build: Build, id: string): Promise<UpdateRequest> {
    const tag = FULL_SHA.test(build.commit) ? build.commit : build.tag;
    const siblings = await ctx.updates.siblings(tag).catch(err => {
      app.log.warn({ error: loggable(err) }, 'Could not read the node and updater images of the build.');
      throw new ApiError(503, 'unavailable', 'Could not read this version from the registry. Check the internet connection, then try again.', 'registry_unreachable');
    });
    return { id, version: build.version || build.tag, commit: build.commit, tag, digest: build.digest, nodeDigest: siblings.node, updaterDigest: siblings.updater };
  }

  function send(request: UpdateRequest) {
    const { id, ...rest } = request;
    ctx.updater.request(rest, id);
  }

  async function sendImmediately(request: UpdateRequest, confirmed: number): Promise<void> {
    const targets = await serverNodes(ctx);
    const resume = pauseNodeWork(ctx, targets);
    try {
      const turns = (await drainWork(ctx, targets)).turnsLeft;
      if (turns > confirmed) throw new ApiError(409, 'conflict', 'Confirm how many running turns this update will stop.', 'turns_would_stop', { turns });
      callOff();
      restartServerNodes(ctx, targets);
      try { send({ ...request, immediate: true }); }
      catch (err) { cancelServerDrain(ctx); throw err; }
    } finally { resume(); }
  }

  /* The request is still the one waiting after the count, since a person may call it off or ask for another meanwhile.
     It stops waiting only once the updater has it: a request that could not be written is tried again on the next
     check, and the failure goes to the log instead of taking the server down. */
  async function sendWhenIdle(companyId: string, request: UpdateRequest) {
    let done = false;
    const wanted = () => !done && waiting?.request.id === request.id;
    const check = async () => {
      if (!wanted()) return;
      const drain = await requestServerDrain(ctx, companyId);
      if (!wanted() || (await workingCount(ctx.db, companyId)) > 0 || !wanted() || drain.state !== 'restarting') return;
      send(request);
      done = true;
      callOff(false);
      setTimeout(() => waiting?.companyId === companyId || letTurnsGo(companyId), HELD_AFTER_MS).unref();
    };
    const tryCheck = () => check().catch(err => app.log.error({ error: loggable(err) }, 'Could not hand the waiting update to the updater.'));
    const unsubscribe = ctx.bus.subscribe(companyId, m => m.type === 'working' && m.working === 0 && void tryCheck());
    const timer = setInterval(() => void tryCheck(), Math.min(IDLE_CHECK_MS, ctx.config.nodeDrainMs, ctx.config.nodeUpdateRetryMs));
    timer.unref();
    waiting = { companyId, request, stop: () => (unsubscribe(), clearInterval(timer)) };
    /* No new turn starts meanwhile, so the running ones can end. */
    holdTurns(ctx, companyId, true);
    await tryCheck();
  }

  app.addHook('onClose', async () => callOff(false));

  app.get('/api/updates/current', async req => {
    await requirePerson(req, ctx.db);
    return { version, commit: commit.slice(0, 7) };
  });

  app.get('/api/updates', async req => {
    await companyPerson(req);
    return view();
  });

  app.post('/api/updates/check', async req => {
    await companyPerson(req);
    await ctx.updates.now();
    return view();
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
    const request = await requestFor(build, randomUUID());
    if (body.whenIdle) {
      callOff();
      await sendWhenIdle(me.companyId, request);
    } else await sendImmediately(request, body.confirmTurns ?? 0);
    return reply.code(202).send({ id: request.id });
  });

  app.delete('/api/updates', async (req, reply) => {
    await companyPerson(req);
    callOff();
    return reply.code(204).send();
  });
}
