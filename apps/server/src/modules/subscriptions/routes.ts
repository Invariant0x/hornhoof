import { API_PROTOCOLS, API_PROVIDERS, ApiBaseUrl, apiEndpoint, isApiProvider, modelsFor, Sealed, type ApiProtocol, type ApiProvider, type ProviderId } from '@hornhoof/protocol';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf } from '../../auth/access.js';
import { runsDepartment } from '../../auth/departments.js';
import { requireCompanyScope, requirePerson, viaOrchestrator, type Person } from '../../auth/session.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { agentFallbacks, agents, attachments, departments, jobs, machines, nodes, people, planCredentials, programDeliveries, programInstances, programOperatorCases, programOperatorSignals, subscriptions, teams, testParts, type SUBSCRIPTION_STATUSES } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { releaseLeftProgram } from '../agents/left-programs.js';
import { runningAgents } from '../agents/running.js';
import { servesWholeCompany } from '../tools/staff.js';
import { orchestratorOf, pumpWaiting } from '../conversation/queue.js';
import { endRemovedPlanCommands, lockCommandOwner } from '../nodes/codes.js';
import { resumeAgent } from '../tasks/wake.js';
import { createInstallCommand } from '../nodes/command.js';
import { builtinOf, nodeIdentity, ownBuiltin } from '../nodes/hub.js';
import { liveNode, planNodes } from '../nodes/nodes.js';
import { internalAddress, modelsFrom, modelsRequest, type ModelsAnswer } from './api-models.js';
import { CRED_KIND, deliver, storeEnvelopes } from './credentials.js';
import { periodsOf, together, tokensByModel, tokensBySubscription, TokensQuery } from './tokens.js';
import { failOpenJobs } from '../nodes/messages.js';
import { tryPlaceOperator } from '../operations/ensure.js';
import { loseParts } from '../testruns/runs.js';
import { onlineIn, subView, subViews } from './views.js';
import { tryPlaceWaiting } from './waiting.js';
import { fallBackFrom } from './fallback.js';

const Target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('orchestrator') }),
  z.object({ kind: z.literal('department'), id: z.uuid() }),
  z.object({ kind: z.literal('team'), id: z.uuid() }),
  z.object({ kind: z.literal('any') }),
]);

const label = z.string().trim().min(1).max(80);
const Budget = z.number().int().min(10).max(100).nullable();
export const BudgetBody = z.object({ budget: Budget });

/* The models an API connection runs, each once: what its API listed and a person kept, or ids a person wrote. */
const ConnectionModels = z
  .array(z.object({ id: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(80) }))
  .max(100)
  .refine(list => new Set(list.map(m => m.id)).size === list.length, 'models: Each model once.');

const apiKey = z.string().trim().min(8).max(500);

/* Where an API answers. Only a compatible API names its address, and it needs its protocol too; OpenRouter may choose
   its protocol; the Claude and OpenAI APIs have both of their own. */
const Connection = { provider: z.enum(API_PROVIDERS), baseUrl: ApiBaseUrl.optional(), protocol: z.enum(API_PROTOCOLS).optional() };
function connectionRules(body: { provider: ApiProvider; baseUrl?: string; protocol?: ApiProtocol }, check: z.RefinementCtx): void {
  const custom = body.provider === 'custom_api';
  if (custom && !body.baseUrl) check.addIssue({ code: 'custom', path: ['baseUrl'], message: 'A compatible API needs the address it answers at.' });
  if (custom && !body.protocol) check.addIssue({ code: 'custom', path: ['protocol'], message: 'A compatible API needs the protocol it speaks: anthropic or openai.' });
  if (!custom && body.baseUrl) check.addIssue({ code: 'custom', path: ['baseUrl'], message: 'Only a compatible API takes an address; this one has its own.' });
  if (!custom && body.provider !== 'openrouter' && body.protocol) check.addIssue({ code: 'custom', path: ['protocol'], message: 'This API speaks its own protocol.' });
}

/* A company API connection, as a person or the add_api_key tool gives it. */
export const ApiKeyFields = z.object({ kind: z.literal('api_key'), ...Connection, label, apiKey, target: Target, models: ConnectionModels.optional() });

/* Company API keys only. Personal subscriptions are connected by their owner through a machine. */
const SubscriptionBody = ApiKeyFields.superRefine(connectionRules);

/* An API's models, asked before its connection is saved. */
const ModelsBody = z.object({ ...Connection, apiKey }).superRefine(connectionRules);

/* The plans its employees go on to at its limit, in order, each once, with the model to run there or none for their role's. */
const Fallbacks = z
  .array(z.object({ subscription: z.uuid(), model: z.string().trim().min(1).max(80).nullable() }))
  .max(20)
  .refine(list => new Set(list.map(f => f.subscription)).size === list.length, 'fallbacks: Each plan once.');

/* What a subscription's owner or company scope changes: the share of its limits and its fallbacks, and of an API connection
   its name, models and the place it serves. */
const SubscriptionPatch = z
  .object({ budget: Budget.optional(), fallbacks: Fallbacks.optional(), label: label.optional(), models: ConnectionModels.optional(), target: Target.optional() })
  .refine(patch => Object.values(patch).some(value => value !== undefined), 'Say what to change.');

const badFallback = (message: string) => new ApiError(400, 'validation', `fallbacks: ${message}`, 'fallback_invalid');

/* Each fallback is another plan of the company, and a model named for it is one that plan runs. */
async function checkFallbacks(db: Db, sub: { id: string; companyId: string }, fallbacks: z.infer<typeof Fallbacks> | undefined): Promise<void> {
  if (!fallbacks) return;
  const ids = fallbacks.map(f => f.subscription);
  if (ids.includes(sub.id)) throw badFallback('A plan cannot be its own fallback.');
  const plans = ids.length ? await db.select().from(subscriptions).where(and(inArray(subscriptions.id, ids), eq(subscriptions.companyId, sub.companyId), isNull(subscriptions.removedAt))) : [];
  for (const f of fallbacks) {
    const plan = plans.find(p => p.id === f.subscription);
    if (!plan) throw badFallback('The company has no such plan.');
    if (f.model && !modelsFor(plan.provider, plan.models).some(m => m.id === f.model)) throw badFallback(`${plan.label} cannot run ${f.model}.`);
  }
}

/* The columns a change of a subscription sets: only those it names. */
function patchColumns({ budget, fallbacks, label, models }: Pick<z.infer<typeof SubscriptionPatch>, 'budget' | 'fallbacks' | 'label' | 'models'>) {
  return { ...(budget !== undefined ? { budget } : {}), ...(fallbacks !== undefined ? { fallbacks } : {}), ...(label !== undefined ? { label } : {}), ...(models !== undefined ? { models } : {}) };
}

/* A plan removed: those on it for a while, as a fallback, go back to their own plan; those it was a home to stay where
   they are now. */
async function endFallbacksOn(tx: Parameters<Parameters<Db['transaction']>[0]>[0], planId: string): Promise<void> {
  for (const away of await tx.select().from(agentFallbacks).where(eq(agentFallbacks.subscriptionId, planId))) {
    await tx.update(agents).set({ subscriptionId: away.homeSubscriptionId, model: away.homeModel, effort: away.homeEffort, nodeId: null }).where(and(eq(agents.id, away.agentId), eq(agents.subscriptionId, planId)));
  }
  await tx.delete(agentFallbacks).where(or(eq(agentFallbacks.subscriptionId, planId), eq(agentFallbacks.homeSubscriptionId, planId)));
}

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
const CredentialBody = z.object({
  kind: z.enum(['kimi_key', 'glm_key']),
  version: z.number().int().min(1),
  envelopes: z.array(z.object({ nodeId: z.uuid(), sealed: Sealed })).min(1).max(20),
});

const unknown = () => new ApiError(404, 'not_found', 'This subscription does not exist.', 'subscription_unknown');
const internal = () =>
  new ApiError(400, 'validation', "baseUrl: This address is on the internal network. The server's operator can allow its host in API_INTERNAL_HOSTS.", 'internal_address');
const notApiKey = () => new ApiError(400, 'validation', 'Only an API connection has a name, models and a place of its own to change.', 'not_api_key');

const MODELS_SAY: Record<Exclude<ModelsAnswer, { ok: true }>['reason'], (status?: number) => string> = {
  internal_address: () => "The API's name leads into the internal network, which Hornhoof does not reach unless the server's operator allows its host.",
  redirect: () => 'The API answered with a redirect, which Hornhoof does not follow. Give the address it answers at itself.',
  too_large: () => "The API's list of models is too long to read.",
  timeout: () => 'The API did not answer in time.',
  unreachable: () => 'Hornhoof could not reach an API at this address.',
  bad_answer: () => "The API's answer is not a list of models.",
  refused: status => `The API refused with status ${status ?? 'unknown'}. Check the key and the address.`,
};

/* The models an API lists with this key, or why it did not. */
async function listedModels(ctx: Ctx, provider: ApiProvider, own: { baseUrl?: string | null; protocol?: ApiProtocol | null }, key: string) {
  const endpoint = apiEndpoint(provider, own)!;
  if (provider === 'custom_api' && internalAddress(new URL(endpoint.baseUrl), ctx.config.apiInternalHosts)) throw internal();
  const answer = await ctx.readModels(modelsRequest(provider, endpoint, key));
  const models = answer.ok ? modelsFrom(answer.body) : null;
  if (models) return { models };
  const reason = answer.ok ? 'bad_answer' : answer.reason;
  throw new ApiError(400, 'validation', MODELS_SAY[reason](answer.ok ? undefined : answer.status), `models_${reason}`);
}

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
  const goneNodes = tx.select(idOnly(nodes)).from(nodes).where(inArray(nodes.subscriptionId, resetIds));
  await tx.update(subscriptions).set({ removedAt: null, status: 'waiting_machine', leaseNodeId: null }).where(inArray(subscriptions.id, resetIds));
  await tx.update(agents).set({ nodeId: null }).where(inArray(agents.nodeId, goneNodes));
  await tx.update(jobs).set({ nodeId: null }).where(inArray(jobs.nodeId, goneNodes));
  await tx.update(testParts).set({ nodeId: null }).where(inArray(testParts.nodeId, goneNodes));
  await tx.delete(planCredentials).where(inArray(planCredentials.subscriptionId, resetIds));
  const goneCases = tx.select(idOnly(programOperatorCases)).from(programOperatorCases).where(inArray(programOperatorCases.nodeId, goneNodes));
  const goneDeliveries = tx.select(idOnly(programDeliveries)).from(programDeliveries).where(inArray(programDeliveries.nodeId, goneNodes));
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
  await endRemovedPlanCommands(tx, kept.filter(s => s.removedAt !== null).map(s => s.id));
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

  /* A key placed in a department, a product of it or a team in it is that department's: a person who runs it adds, changes
     and removes it there as the CEO does, from their own screen or through the orchestrator, never through a head. What
     serves the whole company or the orchestrator stays with people who see the whole company, and so does every personal
     plan of someone else. */
  async function runsPlace(me: Person, kind: string | null, id: string | null): Promise<boolean> {
    if (me.viaHead || !id) return false;
    if (kind === 'department') return runsDepartment(db, me, id);
    if (kind !== 'team') return false;
    const [team] = await db.select(only(teams, 'departmentId')).from(teams).where(and(eq(teams.id, id), eq(teams.companyId, me.companyId)));
    return team ? runsDepartment(db, me, team.departmentId) : false;
  }
  const mayPlace = async (me: Person, target: z.infer<typeof Target>) => me.scopeKind === 'company' || runsPlace(me, target.kind, 'id' in target ? target.id : null);
  const mayKeep = async (me: Person, sub: { kind: string; targetKind: string | null; targetId: string | null }) =>
    me.scopeKind === 'company' || (sub.kind === 'api_key' && (await runsPlace(me, sub.targetKind, sub.targetId)));
  const notTheirPlace = () => new ApiError(403, 'forbidden', 'Only people who see the whole company, or who run the department it is for, place an API key there.', 'company_scope_only');

  /* The top-level departments a person runs from their own screen, in the order of the map. */
  async function placesRun(me: Person): Promise<string[]> {
    const owns = me.via ? undefined : (await accessOf(db, me)).owns;
    if (!owns?.size) return [];
    const tops = await db.select(idOnly(departments)).from(departments).where(and(eq(departments.companyId, me.companyId), isNull(departments.parentId))).orderBy(asc(departments.position), asc(departments.createdAt));
    return tops.map(d => d.id).filter(id => owns.has(id));
  }

  /* The API keys of the departments a person runs, beside their own plans. */
  async function keptKeys(me: Person): Promise<Set<string>> {
    if (me.via || !(await accessOf(db, me)).owns?.size) return new Set();
    const keys = await db.select({ id: subscriptions.id, kind: subscriptions.kind, targetKind: subscriptions.targetKind, targetId: subscriptions.targetId }).from(subscriptions)
      .where(and(eq(subscriptions.companyId, me.companyId), eq(subscriptions.kind, 'api_key'), isNull(subscriptions.removedAt)));
    const kept = await Promise.all(keys.map(async key => ((await mayKeep(me, key)) ? key.id : null)));
    return new Set(kept.filter((id): id is string => id !== null));
  }

  async function placeExists(target: z.infer<typeof Target>) {
    if (target.kind !== 'department' && target.kind !== 'team') return;
    const table = target.kind === 'department' ? departments : teams;
    const [row] = await db.select(idOnly(table)).from(table).where(eq(table.id, target.id));
    if (!row) throw new ApiError(400, 'validation', `target.id: No ${target.kind} with this id.`, 'unknown_place');
  }

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
    const { zone } = TokensQuery.parse(req.query);
    const all = await subViews(db, online, undefined, me);
    const placed = await runningAgents(ctx, me);
    const kept = me.scopeKind === 'company' ? null : await keptKeys(me);
    const visible = kept === null ? all : all.filter(s => s.owner.id === me.id || kept.has(s.id));
    const tokens = await tokensBySubscription(db, me.companyId, ctx.clock(), zone, visible.map(s => s.id));
    return {
      subscriptions: visible.map(s => ({ ...s, canChange: kept === null || kept.has(s.id), agents: placed.filter(a => a.subscriptionId === s.id).map(a => a.view), tokens: periodsOf(tokens, s.id) })),
      /* Where this person connects an API key: anywhere (null), or only in the departments they run. */
      apiPlaces: kept === null ? null : await placesRun(me),
    };
  });

  /* What a subscription's turns used, for its owner and company scope. */
  app.get('/api/subscriptions/:id/tokens', async req => {
    const me = await requirePerson(req, db);
    const { zone } = TokensQuery.parse(req.query);
    const [sub] = await db.select({ id: subscriptions.id, ownerPersonId: subscriptions.ownerPersonId }).from(subscriptions).where(and(eq(subscriptions.id, IdParams.parse(req.params).id), eq(subscriptions.companyId, me.companyId)));
    if (!sub) throw unknown();
    if (!ownsOrCompany(me, sub.ownerPersonId) && !(await keptKeys(me)).has(sub.id)) throw notOwner();
    const now = ctx.clock();
    return { tokens: periodsOf(await tokensBySubscription(db, me.companyId, now, zone, [sub.id]), sub.id), models: await tokensByModel(db, me.companyId, sub.id, now) };
  });

  /* What all the subscriptions a person sees used together: the whole company's for company scope, their own plans' else. */
  app.get('/api/tokens', async req => {
    const me = await requirePerson(req, db);
    const { zone } = TokensQuery.parse(req.query);
    const own = me.scopeKind === 'company' ? undefined : (await db.select(idOnly(subscriptions)).from(subscriptions).where(eq(subscriptions.ownerPersonId, me.id))).map(s => s.id);
    return { tokens: together((await tokensBySubscription(db, me.companyId, ctx.clock(), zone, own)).values()) };
  });

  /* An API's models with a key a person gives, before the connection is saved. */
  app.post('/api/subscriptions/models', async req => {
    const me = await requirePerson(req, db);
    if (me.scopeKind !== 'company' && (me.viaHead || !(await accessOf(db, me)).owns?.size)) throw notTheirPlace();
    const body = ModelsBody.parse(req.body);
    return listedModels(ctx, body.provider, body, body.apiKey);
  });

  /* An API connection's models with its own key, which never goes back to the browser. */
  app.post('/api/subscriptions/:id/models', async req => {
    const me = await requirePerson(req, db);
    const sub = await liveSubscription(IdParams.parse(req.params).id);
    if (!(await mayKeep(me, sub))) throw notTheirPlace();
    if (sub.kind !== 'api_key' || !sub.secretEnc || !isApiProvider(sub.provider)) throw notApiKey();
    return listedModels(ctx, sub.provider, { baseUrl: sub.baseUrl, protocol: sub.apiProtocol }, decryptSecret(sub.secretEnc, config.secret));
  });

  app.post('/api/subscriptions', async (req, reply) => {
    const me = await requirePerson(req, db);
    const body = SubscriptionBody.parse(req.body);
    const { target } = body;
    if (!(await mayPlace(me, target))) throw notTheirPlace();
    const endpoint = apiEndpoint(body.provider, body)!;
    if (body.provider === 'custom_api' && internalAddress(new URL(endpoint.baseUrl), config.apiInternalHosts)) throw internal();

    await placeExists(target);

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
        baseUrl: body.provider === 'custom_api' ? endpoint.baseUrl : null,
        apiProtocol: body.provider === 'custom_api' || body.provider === 'openrouter' ? endpoint.protocol : null,
        models: body.models ?? null,
      }).returning({ id: subscriptions.id });
      if (target.kind === 'orchestrator') await tx.update(agents).set(orchestratorOn({ id: sub!.id, provider: body.provider })).where(eq(agents.kind, 'orchestrator'));
      return sub!.id;
    });
    if (target.kind === 'orchestrator') await orchestratorBack(orchestratorBefore, id);
    await tryPlaceWaiting(ctx, me.companyId, [id]);
    await tryPlaceOperator(ctx, me.companyId);

    reply.code(201);
    return { subscription: await subView(db, online, id, me) };
  });

  /* A person connects their own plans. They serve wherever the person works, and whoever there waits for a plan takes one.
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
    await tryPlaceWaiting(ctx, me.companyId, ids);
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
    const [owner] = await db.select(only(people, 'scopeKind')).from(people).where(eq(people.id, sub.ownerPersonId));
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
    if (!viaOrchestrator(me) && (me.via || sub.ownerPersonId !== me.id)) throw notOwner();
    const rows = await db
      .select({ nodeId: nodes.id, publicKey: nodes.publicKey, hostname: machines.hostname })
      .from(nodes)
      .innerJoin(machines, eq(machines.id, nodes.machineId))
      .where(and(eq(nodes.subscriptionId, sub.id), liveNode, isNotNull(nodes.publicKey)));
    return { version: sub.credVersion, recipients: rows.map(r => ({ nodeId: r.nodeId, publicKey: r.publicKey!, hostname: r.hostname })) };
  });

  /* Only the owner pastes a plan's key, or the orchestrator. */
  app.post('/api/subscriptions/:id/credential', async req => {
    const me = await requirePerson(req, db);
    const sub = await liveSubscription(IdParams.parse(req.params).id);
    if (!viaOrchestrator(me) && (me.via || sub.ownerPersonId !== me.id)) throw notOwner();
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
    const keeps = await mayKeep(me, sub);
    if (!ownsOrCompany(me, sub.ownerPersonId) && !keeps) throw notOwner();
    const { budget, fallbacks, label, models, target } = SubscriptionPatch.parse(req.body);
    if (label !== undefined || models !== undefined || target !== undefined) {
      if (!keeps) throw notTheirPlace();
      if (sub.kind !== 'api_key') throw notApiKey();
      if (target && !(await mayPlace(me, target))) throw notTheirPlace();
    }
    if (target) await placeExists(target);
    await checkFallbacks(db, sub, fallbacks);
    const place = target ? { targetKind: target.kind, targetId: 'id' in target ? target.id : null } : {};
    await db.update(subscriptions).set({ ...patchColumns({ budget, fallbacks, label, models }), ...place }).where(eq(subscriptions.id, sub.id));
    await pumpWaiting(ctx);
    /* A share set below what the plan used sends its workers on to a fallback at once. */
    if (budget !== undefined) await fallBackFrom(ctx, sub.id);
    ctx.bus.publish(sub.companyId, { type: 'org' });
    return { subscription: await subView(db, online, sub.id, me) };
  });

  app.delete('/api/subscriptions/:id', async (req, reply) => {
    const me = await requirePerson(req, db);
    const sub = await liveSubscription(IdParams.parse(req.params).id);
    if (!ownsOrCompany(me, sub.ownerPersonId) && !(await mayKeep(me, sub))) throw notOwner();
    await db.transaction(async tx => {
      await tx
        .update(subscriptions)
        .set({ removedAt: new Date(), leaseNodeId: null, ...(sub.kind === 'api_key' ? { secretEnc: null } : {}) })
        .where(eq(subscriptions.id, sub.id));
      await endRemovedPlanCommands(tx, [sub.id]);
      await endFallbacksOn(tx, sub.id);
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
