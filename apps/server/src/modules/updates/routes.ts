import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { ApiError, loggable } from '../../errors.js';
import { workingCount } from '../events/store.js';
import type { UpdateRequest, UpdaterView } from './control.js';
import type { Build } from './registry.js';

export const UpdateBody = z.object({ version: z.string().min(1).max(128), whenIdle: z.boolean().default(false) });
const FULL_SHA = /^[0-9a-f]{40}$/;
/* While an update waits for the agents, the working count is checked when it changes and this often besides. */
const IDLE_CHECK_MS = 30_000;

type Waiting = { companyId: string; request: UpdateRequest; stop: () => void };

/* Which build runs, which are published, whether a newer one is out, and asking the updater to move to one.
   Only for people who see the whole company. */
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
      waiting: waiting && { version: waiting.request.version },
    };
    return { current: { version, commit, migrations }, available: Boolean(state.latest?.commit && state.latest.commit !== commit), ...state, updater };
  }

  function callOff() {
    waiting?.stop();
    waiting = null;
  }

  /* The image tag pins the exact build: a version tag moves when that version is built again, a commit's does not. */
  function requestFor(build: Build, id: string): UpdateRequest {
    return { id, version: build.version || build.tag, tag: FULL_SHA.test(build.commit) ? build.commit : build.tag };
  }

  function send(request: UpdateRequest) {
    const { id, ...rest } = request;
    ctx.updater.request(rest, id);
  }

  /* The request is still the one waiting after the count, since a person may call it off or ask for another meanwhile.
     It stops waiting only once the updater has it: a request that could not be written is tried again on the next
     check, and the failure goes to the log instead of taking the server down. */
  async function sendWhenIdle(companyId: string, request: UpdateRequest) {
    let done = false;
    const wanted = () => !done && waiting?.request.id === request.id;
    const check = async () => {
      if (!wanted() || (await workingCount(ctx.db, companyId)) > 0 || !wanted()) return;
      send(request);
      done = true;
      callOff();
    };
    const tryCheck = () => check().catch(err => app.log.error({ error: loggable(err) }, 'Could not hand the waiting update to the updater.'));
    const unsubscribe = ctx.bus.subscribe(companyId, m => m.type === 'working' && m.working === 0 && void tryCheck());
    const timer = setInterval(() => void tryCheck(), IDLE_CHECK_MS);
    timer.unref();
    waiting = { companyId, request, stop: () => (unsubscribe(), clearInterval(timer)) };
    await tryCheck();
  }

  app.addHook('onClose', async () => callOff());

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
    callOff();
    const request = requestFor(build, randomUUID());
    if (body.whenIdle) await sendWhenIdle(me.companyId, request);
    else send(request);
    return reply.code(202).send({ id: request.id });
  });

  app.delete('/api/updates', async (req, reply) => {
    await companyPerson(req);
    callOff();
    return reply.code(204).send();
  });
}
