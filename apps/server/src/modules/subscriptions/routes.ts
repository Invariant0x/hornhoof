import { Sealed, type ProviderId } from '@hornhoof/protocol';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import { encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { agents, attachments, departments, jobs, machines, nodes, people, planCredentials, programDeliveries, programInstances, programOperatorCases, programOperatorSignals, subscriptions, teams, testParts, type SUBSCRIPTION_STATUSES } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { releaseLeftProgram } from '../agents/left-programs.js';
import { runningAgents } from '../agents/running.js';
import { servesWholeCompany } from '../tools/staff.js';
import { orchestratorOf, pumpWaiting } from '../conversation/queue.js';
import { lockCommandOwner } from '../nodes/codes.js';
import { resumeAgent } from '../tasks/wake.js';
import { createInstallCommand } from '../nodes/command.js';
import { builtinOf, nodeIdentity, ownBuiltin } from '../nodes/hub.js';
import { liveNode, planNodes } from '../nodes/nodes.js';
import { CRED_KIND, deliver, storeEnvelopes } from './credentials.js';
import { failOpenJobs } from '../nodes/messages.js';
import { tryPlaceOperator } from '../operations/ensure.js';
import { loseParts } from '../testruns/runs.js';
import { onlineIn, subView, subViews } from './views.js';

const Target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('orchestrator') }),
  z.object({ kind: z.literal('department'), id: z.uuid() }),
  z.object({ kind: z.literal('team'), id: z.uuid() }),
  z.object({ kind: z.literal('any') }),
]);

const label = z.string().trim().min(1).max(80);
export const BudgetBody = z.object({ budget: z.number().int().min(10).max(100).nullable() });

/* Company API keys only. Personal subscriptions are connected by their owner through a machine. */
export const SubscriptionBody = z.object({
  kind: z.literal('api_key'),
  provider: z.enum(['anthropic_api', 'openai_api']),
  label,
  apiKey: z.string().trim().min(8),
  target: Target,
});

const PLANS = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', antigravity: 'Antigravity' } as const;
type Plan = keyof typeof PLANS;

export const ConnectBody = z.object({
  providers: z
    .array(z.enum(Object.keys(PLANS) as [Plan, ...Plan[]]))
    .min(1)
    .max(Object.keys(PLANS).length)
    .refine(list => new Set(list).size === list.length, 'Each subscription once.'),
});

const IdParams = z.object({ id: z.uuid() });

/* A key the owner pasted and sealed in their browser to the plan's nodes. Claude and Codex sign in on a machine. */
export const CredentialBody = z.object({
  kind: z.enum(['kimi_key', 'glm_key']),
  version: z.number().int().min(1),
  envelopes: z.array(z.object({ nodeId: z.uuid(), sealed: Sealed })).min(1).max(20),
});

const unknown = () => new ApiError(404, 'not_found', 'This subscription does not exist.', 'subscription_unknown');
const notOwner = () => new ApiError(403, 'forbidden', 'Only the owner of this subscription can do this.', 'not_owner');
const connectedAlready = () =>
  new ApiError(409, 'conflict', 'This plan runs on a machine already. To run it on another one too, use Add my plan on that machine under Machines.', 'already_connected');

type ExistingPlan = {
  id: string;
  provider: Plan;
  status: (typeof SUBSCRIPTION_STATUSES)[number];
  removedAt: Date | null;
};

/* A plan signed in on its machine: ready there, or waiting for its owner to pass its program's first setup there. */
const SIGNED_IN = new Set<ExistingPlan['status']>(['ready', 'needs_setup']);
const isProtectedPlan = (s: ExistingPlan, busy: ReadonlySet<string | null>) => s.removedAt === null && (SIGNED_IN.has(s.status) || busy.has(s.id));

async function clearPlanNodes(tx: Db, resetIds: string[]): Promise<string[]> {
  if (!resetIds.length) return [];
  const goneNodes = tx.select({ id: nodes.id }).from(nodes).where(inArray(nodes.subscriptionId, resetIds));
  await tx.update(subscriptions).set({ removedAt: null, status: 'waiting_machine', leaseNodeId: null }).where(inArray(subscriptions.id, resetIds));
  await tx.update(agents).set({ nodeId: null }).where(inArray(agents.nodeId, goneNodes));
  await tx.update(jobs).set({ nodeId: null }).where(inArray(jobs.nodeId, goneNodes));
  await tx.update(testParts).set({ nodeId: null }).where(inArray(testParts.nodeId, goneNodes));
  await tx.delete(planCredentials).where(inArray(planCredentials.subscriptionId, resetIds));
  const goneCases = tx.select({ id: programOperatorCases.id }).from(programOperatorCases).where(inArray(programOperatorCases.nodeId, goneNodes));
  const goneDeliveries = tx.select({ id: programDeliveries.id }).from(programDeliveries).where(inArray(programDeliveries.nodeId, goneNodes));
  await tx.delete(programOperatorSignals).where(inArray(programOperatorSignals.caseId, goneCases));
  /* Keep conversation pictures after their physical program's investigation is gone. */
  await tx.update(attachments).set({ operatorCaseId: null }).where(inArray(attachments.operatorCaseId, goneCases));
  await tx.delete(programOperatorCases).where(inArray(programOperatorCases.nodeId, goneNodes));
  await tx.update(programDeliveries).set({ sourceDeliveryId: null }).where(inArray(programDeliveries.sourceDeliveryId, goneDeliveries));
  await tx.delete(programDeliveries).where(inArray(programDeliveries.nodeId, goneNodes));
  await tx.delete(programInstances).where(inArray(programInstances.nodeId, goneNodes));
  const removed = await tx.delete(nodes).where(inArray(nodes.subscriptionId, resetIds)).returning({ id: nodes.id });
  return removed.map(n => n.id);
}

async function prepareConnectPlans(tx: Db, me: Person, providers: Plan[]): Promise<{ ids: string[]; removedNodes: string[] }> {
  const had = (await tx
    .select({
      id: subscriptions.id,
      provider: subscriptions.provider,
      status: subscriptions.status,
      removedAt: subscriptions.removedAt,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.ownerPersonId, me.id), eq(subscriptions.kind, 'personal'), inArray(subscriptions.provider, providers)))
    .orderBy(asc(subscriptions.createdAt))) as ExistingPlan[];
  const agentPlans = await tx.select({ id: agents.subscriptionId }).from(agents).where(and(eq(agents.companyId, me.companyId), isNotNull(agents.subscriptionId)));
  const runPlans = await tx
    .select({ id: nodes.subscriptionId })
    .from(nodes)
    .innerJoin(testParts, eq(testParts.nodeId, nodes.id))
    .where(and(eq(nodes.companyId, me.companyId), isNotNull(nodes.subscriptionId)));
  const busy = new Set([...agentPlans, ...runPlans].map(r => r.id));
  if (had.some(s => isProtectedPlan(s, busy))) throw connectedAlready();
  const kept = providers.flatMap(p => {
    const row = had.find(s => s.provider === p);
    return row ? [row] : [];
  });
  const removedNodes = await clearPlanNodes(tx, kept.map(s => s.id));
  const fresh = providers.filter(p => !kept.some(s => s.provider === p));
  const rows = fresh.length
    ? await tx
        .insert(subscriptions)
        .values(fresh.map(p => ({ companyId: me.companyId, provider: p, kind: 'personal' as const, label: PLANS[p], ownerPersonId: me.id, status: 'waiting_machine' as const })))
        .returning({ id: subscriptions.id })
    : [];
  return { ids: [...kept.map(s => s.id), ...rows.map(r => r.id)], removedNodes };
}

export function subscriptionRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config, hub } = ctx;
  const online = onlineIn(hub, ctx.config);

  async function liveSubscription(id: string) {
    const [row] = await db.select().from(subscriptions).where(and(eq(subscriptions.id, id), isNull(subscriptions.removedAt)));
    if (!row) throw unknown();
    return row;
  }

  const ownsOrCompany = (me: Person, ownerId: string) => me.id === ownerId || me.scopeKind === 'company';

  /* The orchestrator moves to a subscription. Another provider names its levels its own way, so he starts at its default,
     as a move on his card does. */
  const orchestratorOn = (sub: { id: string; provider: ProviderId }) => ({
    subscriptionId: sub.id,
    effort: sql<string | null>`case when (select ${subscriptions.provider} from ${subscriptions} where ${subscriptions.id} = ${agents.subscriptionId}) = ${sub.provider} then ${agents.effort} end`,
  });

  /* The orchestrator on a new subscription: his program on the old one goes once it is idle, his waiting turns go out on the new
     one, and when he had none, the tasks he missed. */
  async function orchestratorBack(before: { id: string; subscriptionId: string | null } | null, plan: string) {
    if (before?.subscriptionId && before.subscriptionId !== plan) await releaseLeftProgram(ctx, before.id, before.subscriptionId);
    if (before && !before.subscriptionId) await resumeAgent(ctx, before.id);
    await pumpWaiting(ctx);
  }

  app.get('/api/subscriptions', async req => {
    const me = await requirePerson(req, db);
    const all = await subViews(db, online, undefined, me);
    const placed = await runningAgents(ctx, me);
    const visible = me.scopeKind === 'company' ? all : all.filter(s => s.owner.id === me.id);
    return { subscriptions: visible.map(s => ({ ...s, agents: placed.filter(a => a.subscriptionId === s.id).map(a => a.view) })) };
  });

  app.post('/api/subscriptions', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const body = SubscriptionBody.parse(req.body);
    const { target } = body;

    if (target.kind === 'department' || target.kind === 'team') {
      const table = target.kind === 'department' ? departments : teams;
      const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, target.id));
      if (!row) throw new ApiError(400, 'validation', `target.id: No ${target.kind} with this id.`, 'unknown_place');
    }

    const orchestratorBefore = target.kind === 'orchestrator' ? await orchestratorOf(ctx, me.companyId) : null;
    const id = await db.transaction(async tx => {
      const [sub] = await tx.insert(subscriptions).values({
        companyId: me.companyId,
        provider: body.provider,
        kind: 'api_key',
        label: body.label,
        ownerPersonId: me.id,
        secretEnc: encryptSecret(body.apiKey, config.secret),
        last4: body.apiKey.slice(-4),
        status: 'ready',
        targetKind: target.kind,
        targetId: 'id' in target ? target.id : null,
      }).returning({ id: subscriptions.id });
      if (target.kind === 'orchestrator') await tx.update(agents).set(orchestratorOn({ id: sub!.id, provider: body.provider })).where(eq(agents.kind, 'orchestrator'));
      return sub!.id;
    });
    if (target.kind === 'orchestrator') await orchestratorBack(orchestratorBefore, id);
    await tryPlaceOperator(ctx, me.companyId);

    reply.code(201);
    return { subscription: await subView(db, online, id, me) };
  });

  /* A person connects their own plans. They serve wherever the person works, so there is nothing to place.
     One subscription per plan: one still waiting for its machine goes into the new command instead of a second one. A
     plan that runs on a machine goes to another one only by that machine's own command, which works there alone. */
  app.post('/api/subscriptions/connect', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { providers } = ConnectBody.parse(req.body);
    const { ids, removedNodes, command } = await db.transaction(async tx => {
      await lockCommandOwner(tx, me.id);
      const { ids, removedNodes } = await prepareConnectPlans(tx, me, providers);
      return { ids, removedNodes, command: await createInstallCommand(tx, config, me, { companyId: me.companyId, personId: me.id, subscriptionIds: ids }) };
    });
    for (const id of removedNodes) hub.close(id, 4001);
    await tryPlaceOperator(ctx, me.companyId);
    const views = (await subViews(db, online, undefined, me)).filter(s => ids.includes(s.id));
    reply.code(201);
    return { subscriptions: views, ...command };
  });

  app.post('/api/subscriptions/:id/command', async (req, reply) => {
    const me = await requirePerson(req, db);
    const sub = await liveSubscription(IdParams.parse(req.params).id);
    if (sub.ownerPersonId !== me.id) throw notOwner();
    if (sub.kind !== 'personal') throw unknown();
    if (sub.status !== 'waiting_machine') throw connectedAlready();
    reply.code(201);
    return createInstallCommand(db, config, me, { companyId: me.companyId, personId: me.id, subscriptionIds: [sub.id] });
  });

  app.post('/api/subscriptions/:id/orchestrator', async req => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const sub = await liveSubscription(IdParams.parse(req.params).id);
    const notCompanyLevel = () => new ApiError(400, 'validation', 'The orchestrator can only run on a subscription that serves the whole company.', 'not_company_level');
    const [owner] = await db.select({ scopeKind: people.scopeKind }).from(people).where(eq(people.id, sub.ownerPersonId));
    if (!servesWholeCompany(sub, owner?.scopeKind)) throw notCompanyLevel();
    const before = await orchestratorOf(ctx, me.companyId);
    await db.update(agents).set(orchestratorOn(sub)).where(eq(agents.kind, 'orchestrator'));
    await orchestratorBack(before, sub.id);
    ctx.bus.accessChanged(me.companyId);
    return { subscription: await subView(db, online, sub.id, me) };
  });

  /* The plan's nodes the owner's browser seals a key to, with the number the new one goes under. */
  app.get('/api/subscriptions/:id/recipients', async req => {
    const me = await requirePerson(req, db);
    const sub = await liveSubscription(IdParams.parse(req.params).id);
    if (me.via || sub.ownerPersonId !== me.id) throw notOwner();
    const rows = await db
      .select({ nodeId: nodes.id, publicKey: nodes.publicKey, hostname: machines.hostname })
      .from(nodes)
      .innerJoin(machines, eq(machines.id, nodes.machineId))
      .where(and(eq(nodes.subscriptionId, sub.id), liveNode, isNotNull(nodes.publicKey)));
    return { version: sub.credVersion, recipients: rows.map(r => ({ nodeId: r.nodeId, publicKey: r.publicKey!, hostname: r.hostname })) };
  });

  /* Only the owner pastes a plan's key, never the orchestrator for them. */
  app.post('/api/subscriptions/:id/credential', async req => {
    const me = await requirePerson(req, db);
    const sub = await liveSubscription(IdParams.parse(req.params).id);
    if (me.via || sub.ownerPersonId !== me.id) throw notOwner();
    const body = CredentialBody.parse(req.body);
    if (sub.kind !== 'personal' || CRED_KIND[sub.provider] !== body.kind) throw new ApiError(400, 'validation', `kind: This plan does not sign in with a ${body.kind === 'kimi_key' ? 'Kimi' : 'GLM'} key.`, 'wrong_kind');
    const kept = await storeEnvelopes(db, sub, body.kind, body.version, body.envelopes);
    deliver(ctx, body.kind, body.version, kept);
    return { stored: kept.length };
  });

  /* The share of the plan's limits its task turns may use. Turns held by it go out once it is raised or taken off. */
  app.patch('/api/subscriptions/:id', async req => {
    const me = await requirePerson(req, db);
    const sub = await liveSubscription(IdParams.parse(req.params).id);
    if (!ownsOrCompany(me, sub.ownerPersonId)) throw notOwner();
    const { budget } = BudgetBody.parse(req.body);
    await db.update(subscriptions).set({ budget }).where(eq(subscriptions.id, sub.id));
    await pumpWaiting(ctx);
    return { subscription: await subView(db, online, sub.id, me) };
  });

  app.delete('/api/subscriptions/:id', async (req, reply) => {
    const me = await requirePerson(req, db);
    const sub = await liveSubscription(IdParams.parse(req.params).id);
    if (!ownsOrCompany(me, sub.ownerPersonId)) throw notOwner();
    await db.transaction(async tx => {
      await tx
        .update(subscriptions)
        .set({ removedAt: new Date(), leaseNodeId: null, ...(sub.kind === 'api_key' ? { secretEnc: null } : {}) })
        .where(eq(subscriptions.id, sub.id));
      await tx.update(agents).set({ subscriptionId: null, nodeId: null }).where(eq(agents.subscriptionId, sub.id));
      await tx.update(nodes).set({ status: 'needs_login' }).where(eq(nodes.subscriptionId, sub.id));
      /* Its sign-in, sealed to its nodes, goes with it. */
      await tx.delete(planCredentials).where(eq(planCredentials.subscriptionId, sub.id));
    });
    /* The nodes stop their jobs when they hear remove, and may never report them, so they end here. */
    const ended = await failOpenJobs(ctx, eq(jobs.subscriptionId, sub.id), 'subscription_removed');
    const gone = sub.kind === 'personal' ? (await planNodes(db, [sub.id])).map(n => n.id) : [];
    if (gone.length) await loseParts(ctx, inArray(testParts.nodeId, gone), 'subscription_removed');
    /* An offline node hears it at its next hello. The built-in node keeps running for other keys, so it stops just this key's jobs. */
    if (sub.kind === 'personal') for (const id of gone) hub.send(nodeIdentity(id), { type: 'remove' });
    else if (ended.length) {
      /* Each to the built-in node it went out to. */
      const sent = await db.select({ id: jobs.id, builtinMachine: jobs.builtinMachine }).from(jobs).where(inArray(jobs.id, ended));
      for (const job of sent) hub.send(job.builtinMachine ? builtinOf(job.builtinMachine) : ownBuiltin(ctx.config), { type: 'job.cancel', jobId: job.id });
    }
    await tryPlaceOperator(ctx, sub.companyId);
    /* Who sees the agents that ran on it changed with it. */
    ctx.bus.accessChanged(sub.companyId);
    return reply.code(204).send();
  });
}
