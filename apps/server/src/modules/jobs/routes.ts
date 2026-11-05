import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { canViewAgent } from '../../auth/agent-view.js';
import { requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agents, jobs, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { cancelJob } from '../tasks/wake.js';
import { BUILTIN, nodeIdentity } from '../nodes/hub.js';
import { planNodes, type NodeRow } from '../nodes/nodes.js';
import { dispatchJob, TEST_PROMPT, TEST_TIMEOUT_MS } from './dispatch.js';
import { jobView, publicJob } from './views.js';

const IdParams = z.object({ id: z.uuid() });

/* A test turn is its writer's and its plan owner's; an employee's turn is for whoever reaches the employee now. */
/* A job of an agent goes with the agent; one of no agent, a plan's test say, with who started it and whose plan it is. */
async function mayRead(db: Db, me: Person, view: NonNullable<Awaited<ReturnType<typeof jobView>>>): Promise<boolean> {
  if (!view.agentId) return me.scopeKind === 'company' || view.createdBy === me.id || view.ownerId === me.id;
  return seesAgentOfJob(db, me, view.agentId);
}

async function seesAgentOfJob(db: Db, me: Person, agentId: string): Promise<boolean> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  return Boolean(agent && (await canViewAgent(db, me, agent)));
}

const notOwner = () => new ApiError(403, 'forbidden', 'Only the owner can do this.', 'not_owner');
const offline = () => new ApiError(409, 'conflict', 'The machine for this subscription is offline. Start it and try again.', 'machine_offline');
/* Why none of a plan's machines that are online can run its test: none is signed in, or its program waits for the first
   setup its owner passes there. */
const notReady = (online: NodeRow[]) =>
  online.some(n => n.status === 'needs_setup')
    ? new ApiError(409, 'conflict', "Finish the first setup of this subscription's program on its machine first.", 'needs_setup')
    : new ApiError(409, 'conflict', 'Sign in to this subscription on its machine first.', 'needs_login');

export function jobRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, hub } = ctx;

  /* A tiny prompt that proves the whole path works: Hornhoof, the node, the sign-in, the provider. A plan's goes to one of
     its machines that is online and signed in. */
  app.post('/api/subscriptions/:id/test', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.id, id), isNull(subscriptions.removedAt)));
    if (!sub) throw new ApiError(404, 'not_found', 'This subscription does not exist.', 'subscription_unknown');
    if (sub.ownerPersonId !== me.id && me.scopeKind !== 'company') throw notOwner();
    const online = sub.kind === 'api_key' ? [] : (await planNodes(db, [sub.id])).filter(n => hub.isOnline(nodeIdentity(n.id)));
    if (sub.kind === 'api_key' ? !hub.isOnline(BUILTIN) : !online.length) throw offline();
    const node = online.find(n => n.status === 'ready');
    if (sub.kind === 'personal' && !node) throw notReady(online);

    const nodeId = node?.id ?? null;
    const [job] = await db
      .insert(jobs)
      .values({ companyId: sub.companyId, subscriptionId: sub.id, nodeId, prompt: TEST_PROMPT, timeoutMs: TEST_TIMEOUT_MS, createdBy: me.id })
      .returning({ id: jobs.id });
    if (!(await dispatchJob(ctx, { id: job!.id, subscriptionId: sub.id, nodeId, prompt: TEST_PROMPT, sessionId: null, timeoutMs: TEST_TIMEOUT_MS, instructions: null, toolToken: null }))) {
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
    if (!(await mayRead(db, me, view))) throw notOwner();
    return { job: publicJob(view) };
  });

  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const { id } = IdParams.parse(req.params);
    const [job] = await db.select({ status: jobs.status, agentId: jobs.agentId }).from(jobs).where(and(eq(jobs.id, id), eq(jobs.companyId, me.companyId)));
    if (job?.agentId && !(await seesAgentOfJob(db, me, job.agentId))) throw notOwner();
    if (!job) throw new ApiError(404, 'not_found', 'This job does not exist.', 'job_unknown');
    if (job.status !== 'running') throw new ApiError(409, 'conflict', 'This job is not running.', 'nothing_running');
    await cancelJob(ctx, id);
    return reply.code(202).send();
  });
}
