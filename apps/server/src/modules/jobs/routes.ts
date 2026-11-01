import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { jobs, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { cancelJob } from '../conversation/queue.js';
import { agentFor } from '../agents/find.js';
import { identityOf } from '../nodes/hub.js';
import { dispatchJob, TEST_PROMPT, TEST_TIMEOUT_MS } from './dispatch.js';
import { jobMetadata, jobView, JOB_METADATA_MAX_ROWS, publicJob } from './views.js';

const IdParams = z.object({ id: z.uuid() });
const Utc = z.iso.datetime().regex(/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/).max(27);
const MetadataWindow = z.object({ from: Utc, to: Utc });
const utcMicros = (value: string): bigint => {
  const [seconds, fraction = ''] = value.slice(0, -1).split('.');
  return BigInt(Date.parse(`${seconds}Z`)) * 1_000n + BigInt(fraction.padEnd(6, '0'));
};
const metadataWindow = (query: unknown) => {
  const { from, to } = MetadataWindow.parse(query);
  const fromMicros = utcMicros(from);
  const toMicros = utcMicros(to);
  if (fromMicros > toMicros) throw new ApiError(400, 'validation', 'from must not be after to');
  if (toMicros - fromMicros > 15n * 60n * 1_000_000n) throw new ApiError(400, 'validation', 'The window must be at most 15 minutes');
  return { from, to };
};
const metadataOverflow = () => new ApiError(409, 'conflict', 'The job metadata response is too large. Narrow the window and try again.', 'job_metadata_overflow');

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
    if (!view) throw new ApiError(404, 'not_found', 'This job does not exist.', 'job_unknown');
    if (me.scopeKind !== 'company' && view.createdBy !== me.id && view.ownerId !== me.id) throw notOwner();
    return { job: publicJob(view) };
  });

  app.get('/api/agents/:id/job-metadata', async req => {
    try {
      const { me, agent } = await agentFor(ctx, req);
      requireCompanyScope(me);
      const { from, to } = metadataWindow(req.query);
      const rows = await jobMetadata(db, agent.id, from, to);
      if (rows.length > JOB_METADATA_MAX_ROWS) throw metadataOverflow();
      const body = { jobs: rows, complete: true };
      if (JSON.stringify(body).length > 28_000) throw metadataOverflow();
      return body;
    } catch (error) {
      if (error instanceof ApiError || error instanceof z.ZodError) throw error;
      throw new ApiError(503, 'unavailable', 'Job metadata is temporarily unavailable. Try again later.');
    }
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
