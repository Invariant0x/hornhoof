import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, agentSpot, canReach } from '../../auth/access.js';
import { requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agents, jobs, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { cancelJob } from '../conversation/queue.js';
import { identityOf } from '../nodes/hub.js';
import { dispatchJob, TEST_PROMPT, TEST_TIMEOUT_MS } from './dispatch.js';
import { jobView, publicJob } from './views.js';

const IdParams = z.object({ id: z.uuid() });

/* A test turn is its writer's and its plan owner's; an employee's turn is for whoever reaches the employee now. */
async function mayRead(db: Db, me: Person, view: NonNullable<Awaited<ReturnType<typeof jobView>>>): Promise<boolean> {
  if (!view.agentId) return view.createdBy === me.id || view.ownerId === me.id;
  const [agent] = await db.select().from(agents).where(eq(agents.id, view.agentId));
  return Boolean(agent && canReach(await accessOf(db, me), await agentSpot(db, agent)));
}

const notOwner = () => new ApiError(403, 'forbidden', 'Only the owner can do this.', 'not_owner');
const offline = () => new ApiError(409, 'conflict', 'The machine for this subscription is offline. Start it and try again.', 'machine_offline');

export function jobRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, hub } = ctx;

  /* A tiny prompt that proves the whole path works: Hornhoof, the node, the sign-in, the provider. */
  app.post('/api/subscriptions/:id/test', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.id, id), isNull(subscriptions.removedAt)));
    if (!sub) throw new ApiError(404, 'not_found', 'This subscription does not exist.', 'subscription_unknown');
    if (sub.ownerPersonId !== me.id && me.scopeKind !== 'company') throw notOwner();
    if (!hub.isOnline(identityOf(sub))) throw offline();
    if (sub.status === 'needs_login') throw new ApiError(409, 'conflict', 'Sign in to this subscription on its machine first.', 'needs_login');

    const [job] = await db
      .insert(jobs)
      .values({ companyId: sub.companyId, subscriptionId: sub.id, prompt: TEST_PROMPT, timeoutMs: TEST_TIMEOUT_MS, createdBy: me.id })
      .returning({ id: jobs.id });
    if (!(await dispatchJob(ctx, { id: job!.id, subscriptionId: sub.id, prompt: TEST_PROMPT, sessionId: null, timeoutMs: TEST_TIMEOUT_MS, instructions: null, toolToken: null }))) {
      await db.update(jobs).set({ status: 'failed', error: 'machine_offline', finishedAt: new Date() }).where(eq(jobs.id, job!.id));
      throw offline();
    }
    reply.code(201);
    return { job: publicJob((await jobView(db, job!.id))!) };
  });

  app.get('/api/jobs/:id', async req => {
    const me = await requirePerson(req, db);
    const view = await jobView(db, IdParams.parse(req.params).id);
    if (!view || view.companyId !== me.companyId) throw new ApiError(404, 'not_found', 'This job does not exist.', 'job_unknown');
    if (me.scopeKind !== 'company' && !(await mayRead(db, me, view))) throw notOwner();
    return { job: publicJob(view) };
  });

  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const { id } = IdParams.parse(req.params);
    const [job] = await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id));
    if (!job) throw new ApiError(404, 'not_found', 'This job does not exist.', 'job_unknown');
    if (job.status !== 'running') throw new ApiError(409, 'conflict', 'This job is not running.', 'nothing_running');
    await cancelJob(ctx, id);
    return reply.code(202).send();
  });
}
