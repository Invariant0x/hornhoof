import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../app.js';
import { requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { agents, departments, people, subscriptions, teams } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { createNodeCode } from '../nodes/codes.js';
import { installCommand } from '../nodes/command.js';
import { subView, subViews, type IsOnline } from './views.js';

const Target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chief') }),
  z.object({ kind: z.literal('department'), id: z.uuid() }),
  z.object({ kind: z.literal('team'), id: z.uuid() }),
  z.object({ kind: z.literal('any') }),
]);

const label = z.string().trim().min(1).max(80);

/* Company API keys only. Personal subscriptions are connected by their owner through a machine. */
const SubscriptionBody = z.object({
  kind: z.literal('api_key'),
  provider: z.enum(['anthropic_api', 'openai_api']),
  label,
  apiKey: z.string().trim().min(8),
  target: Target,
});

const PLANS = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM' } as const;
type Plan = keyof typeof PLANS;

const ConnectBody = z.object({
  providers: z
    .array(z.enum(Object.keys(PLANS) as [Plan, ...Plan[]]))
    .min(1)
    .max(4)
    .refine(list => new Set(list).size === list.length, 'Each subscription once.'),
});

const IdParams = z.object({ id: z.uuid() });

const unknown = () => new ApiError(404, 'not_found', 'This subscription does not exist.', 'subscription_unknown');
const notOwner = () => new ApiError(403, 'forbidden', 'Only the owner of this subscription can do this.', 'not_owner');

/* Nothing is online until the node hub arrives. */
const offline: IsOnline = () => false;

export function subscriptionRoutes(app: FastifyInstance, { db, config }: Deps): void {
  async function liveSubscription(id: string) {
    const [row] = await db.select().from(subscriptions).where(and(eq(subscriptions.id, id), isNull(subscriptions.removedAt)));
    if (!row) throw unknown();
    return row;
  }

  const ownsOrCompany = (me: Person, ownerId: string) => me.id === ownerId || me.scopeKind === 'company';

  app.get('/api/subscriptions', async req => {
    const me = await requirePerson(req, db);
    const all = await subViews(db, offline);
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
      if (target.kind === 'chief') await tx.update(agents).set({ subscriptionId: sub!.id }).where(eq(agents.kind, 'chief'));
      return sub!.id;
    });

    reply.code(201);
    return { subscription: await subView(db, offline, id) };
  });

  /* A person connects their own plans. They serve wherever the person works, so there is nothing to place. */
  app.post('/api/subscriptions/connect', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { providers } = ConnectBody.parse(req.body);
    const { ids, code } = await db.transaction(async tx => {
      const rows = await tx
        .insert(subscriptions)
        .values(providers.map(p => ({ companyId: me.companyId, provider: p, kind: 'personal' as const, label: PLANS[p], ownerPersonId: me.id, status: 'waiting_machine' as const })))
        .returning({ id: subscriptions.id });
      const ids = rows.map(r => r.id);
      return { ids, code: await createNodeCode(tx, { companyId: me.companyId, personId: me.id, subscriptionIds: ids }) };
    });
    const views = (await subViews(db, offline)).filter(s => ids.includes(s.id));
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

  app.post('/api/subscriptions/:id/chief', async req => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const sub = await liveSubscription(IdParams.parse(req.params).id);
    if (sub.kind === 'personal') {
      const [owner] = await db.select({ scopeKind: people.scopeKind }).from(people).where(eq(people.id, sub.ownerPersonId));
      if (owner?.scopeKind !== 'company') {
        throw new ApiError(400, 'validation', 'The chief can only run on a subscription that serves the whole company.', 'not_company_level');
      }
    }
    await db.update(agents).set({ subscriptionId: sub.id }).where(eq(agents.kind, 'chief'));
    return { subscription: await subView(db, offline, sub.id) };
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
    return reply.code(204).send();
  });
}
