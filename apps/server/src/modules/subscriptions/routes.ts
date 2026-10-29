import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { agents, departments, subscriptions, teams } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { subView, subViews } from './views.js';

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

export function subscriptionRoutes(app: FastifyInstance, { db, config }: Deps): void {
  app.get('/api/subscriptions', async req => {
    await requirePerson(req, db);
    return { subscriptions: await subViews(db) };
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
    return { subscription: await subView(db, id) };
  });
}
