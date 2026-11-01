import type { ProviderId } from '@hornhoof/protocol';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { agents, departments, jobs, people, subscriptions, teams } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { servesWholeCompany } from '../tools/staff.js';
import { orchestratorOf, pumpWaiting } from '../conversation/queue.js';
import { createNodeCode } from '../nodes/codes.js';
import { resumeAgent } from '../tasks/wake.js';
import { installCommand } from '../nodes/command.js';
import { identityOf } from '../nodes/hub.js';
import { failOpenJobs } from '../nodes/messages.js';
import { subView, subViews, type IsOnline } from './views.js';
import { subscriptionBudgetRoutes } from './budget-route.js';

const Target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('orchestrator') }),
  z.object({ kind: z.literal('department'), id: z.uuid() }),
  z.object({ kind: z.literal('team'), id: z.uuid() }),
  z.object({ kind: z.literal('any') }),
]);

const label = z.string().trim().min(1).max(80);

/* Company API keys only. Personal subscriptions are connected by their owner through a machine. */
export const SubscriptionBody = z.object({
  kind: z.literal('api_key'),
  provider: z.enum(['anthropic_api', 'openai_api']),
  label,
  apiKey: z.string().trim().min(8),
  target: Target,
});

const PLANS = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM' } as const;
type Plan = keyof typeof PLANS;

export const ConnectBody = z.object({
  providers: z
    .array(z.enum(Object.keys(PLANS) as [Plan, ...Plan[]]))
    .min(1)
    .max(4)
    .refine(list => new Set(list).size === list.length, 'Each subscription once.'),
});

const IdParams = z.object({ id: z.uuid() });

const unknown = () => new ApiError(404, 'not_found', 'This subscription does not exist.', 'subscription_unknown');
const notOwner = () => new ApiError(403, 'forbidden', 'Only the owner of this subscription can do this.', 'not_owner');

export function subscriptionRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config, hub } = ctx;
  const online: IsOnline = sub => hub.isOnline(identityOf(sub));
  subscriptionBudgetRoutes(app, ctx, online);

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

  /* The orchestrator on a new subscription: his waiting turns go out on it, and when he had none, the tasks he missed. */
  async function orchestratorBack(before: { id: string; subscriptionId: string | null } | null) {
    if (before && !before.subscriptionId) await resumeAgent(ctx, before.id);
    await pumpWaiting(ctx);
  }

  app.get('/api/subscriptions', async req => {
    const me = await requirePerson(req, db);
    const all = await subViews(db, online, me.companyId);
    return { subscriptions: me.scopeKind === 'company' ? all : all.filter(s => s.owner.id === me.id) };
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
    if (target.kind === 'orchestrator') await orchestratorBack(orchestratorBefore);

    reply.code(201);
    return { subscription: await subView(db, online, me.companyId, id) };
  });

  /* A person connects their own plans. They serve wherever the person works, so there is nothing to place.
     One subscription per plan: one still waiting for its machine goes into the new command instead of a second one. */
  app.post('/api/subscriptions/connect', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { providers } = ConnectBody.parse(req.body);
    const { ids, code } = await db.transaction(async tx => {
      const had = await tx
        .select({ id: subscriptions.id, provider: subscriptions.provider, status: subscriptions.status })
        .from(subscriptions)
        .where(and(eq(subscriptions.ownerPersonId, me.id), eq(subscriptions.kind, 'personal'), inArray(subscriptions.provider, providers), isNull(subscriptions.removedAt)));
      if (had.some(s => s.status !== 'waiting_machine')) {
        throw new ApiError(409, 'conflict', 'This subscription is already connected to a machine.', 'already_connected');
      }
      const fresh = providers.filter(p => !had.some(s => s.provider === p));
      const rows = fresh.length
        ? await tx
            .insert(subscriptions)
            .values(fresh.map(p => ({ companyId: me.companyId, provider: p, kind: 'personal' as const, label: PLANS[p], ownerPersonId: me.id, status: 'waiting_machine' as const })))
            .returning({ id: subscriptions.id })
        : [];
      const ids = [...had.map(s => s.id), ...rows.map(r => r.id)];
      return { ids, code: await createNodeCode(tx, { companyId: me.companyId, personId: me.id, subscriptionIds: ids }) };
    });
    const views = (await subViews(db, online, me.companyId)).filter(s => ids.includes(s.id));
    reply.code(201);
    return { subscriptions: views, command: installCommand(config.publicUrl, code) };
  });

  app.post('/api/subscriptions/:id/command', async (req, reply) => {
    const me = await requirePerson(req, db);
    const sub = await liveSubscription(IdParams.parse(req.params).id);
    if (sub.ownerPersonId !== me.id) throw notOwner();
    if (sub.status !== 'waiting_machine') throw new ApiError(409, 'conflict', 'This subscription is already connected to a machine.', 'already_connected');
    const code = await createNodeCode(db, { companyId: me.companyId, personId: me.id, subscriptionIds: [sub.id] });
    reply.code(201);
    return { command: installCommand(config.publicUrl, code) };
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
    await orchestratorBack(before);
    return { subscription: await subView(db, online, me.companyId, sub.id) };
  });

  app.delete('/api/subscriptions/:id', async (req, reply) => {
    const me = await requirePerson(req, db);
    const sub = await liveSubscription(IdParams.parse(req.params).id);
    if (!ownsOrCompany(me, sub.ownerPersonId)) throw notOwner();
    await db.transaction(async tx => {
      await tx
        .update(subscriptions)
        .set({ removedAt: new Date(), ...(sub.kind === 'api_key' ? { secretEnc: null } : {}) })
        .where(eq(subscriptions.id, sub.id));
      await tx.update(agents).set({ subscriptionId: null }).where(eq(agents.subscriptionId, sub.id));
    });
    /* The node stops its jobs when it hears remove, and may never report them, so they end here. */
    const ended = await failOpenJobs(ctx, eq(jobs.subscriptionId, sub.id), 'subscription_removed');
    /* An offline node hears it at its next hello. The built-in node keeps running for other keys, so it stops just this key's jobs. */
    if (sub.kind === 'personal') hub.send(identityOf(sub), { type: 'remove' });
    else for (const jobId of ended) hub.send(identityOf(sub), { type: 'job.cancel', jobId });
    return reply.code(204).send();
  });
}
