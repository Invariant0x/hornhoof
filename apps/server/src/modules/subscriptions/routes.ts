import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
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

const SubscriptionBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('api_key'), provider: z.enum(['anthropic_api', 'openai_api']), label, apiKey: z.string().trim().min(8), target: Target }),
  z.object({ kind: z.literal('personal'), provider: z.enum(['claude', 'codex', 'kimi']), label, target: Target }),
]);

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

    /* Provider terms forbid sharing a personal plan, so it serves exactly one place. */
    if (body.kind === 'personal' && target.kind === 'any') {
      throw new ApiError(400, 'validation', 'target: A personal subscription must belong to the chief, one department or one team.');
    }
    if (target.kind === 'department' || target.kind === 'team') {
      const table = target.kind === 'department' ? departments : teams;
      const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, target.id));
      if (!row) throw new ApiError(400, 'validation', `target.id: No ${target.kind} with this id.`, 'unknown_place');
    }

    const joinCode = body.kind === 'personal' ? newToken() : undefined;
    const id = await db.transaction(async tx => {
      const [sub] = await tx.insert(subscriptions).values({
        companyId: me.companyId,
        provider: body.provider,
        kind: body.kind,
        label: body.label,
        ownerPersonId: me.id,
        secretEnc: body.kind === 'api_key' ? encryptSecret(body.apiKey, config.secret) : null,
        last4: body.kind === 'api_key' ? body.apiKey.slice(-4) : null,
        joinCodeHash: joinCode ? hashToken(joinCode) : null,
        status: body.kind === 'api_key' ? 'active' : 'waiting_machine',
        targetKind: target.kind,
        targetId: 'id' in target ? target.id : null,
      }).returning({ id: subscriptions.id });
      if (target.kind === 'chief') await tx.update(agents).set({ subscriptionId: sub!.id }).where(eq(agents.kind, 'chief'));
      return sub!.id;
    });

    reply.code(201);
    return { subscription: await subView(db, id), ...(joinCode ? { joinCode } : {}) };
  });
}
