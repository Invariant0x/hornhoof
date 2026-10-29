import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../app.js';
import { hashPassword } from '../../auth/password.js';
import { startSession } from '../../auth/session.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { isUniqueViolation } from '../../db/errors.js';
import { agents, companies, people, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';

const DEFAULT_MODEL = 'claude-opus-5-5';

const SetupBody = z.object({
  companyName: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10).max(200),
  chief: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('later') }),
    z.object({ mode: z.literal('api_key'), provider: z.enum(['anthropic_api', 'openai_api']), apiKey: z.string().trim().min(8) }),
    z.object({ mode: z.literal('personal'), provider: z.enum(['claude', 'codex', 'kimi']) }),
  ]),
});

type Chief = z.infer<typeof SetupBody>['chief'];

function chiefModel(chief: Chief): string {
  if (chief.mode === 'later' || chief.provider === 'anthropic_api' || chief.provider === 'claude') return DEFAULT_MODEL;
  return chief.provider;
}

const alreadySetUp = () => new ApiError(409, 'conflict', 'This Hornhoof is already set up.');

export function setupRoutes(app: FastifyInstance, { db, config }: Deps): void {
  app.get('/api/setup', async () => {
    const [company] = await db.select({ id: companies.id }).from(companies).limit(1);
    return { needed: !company };
  });

  app.post('/api/setup', async (req, reply) => {
    const body = SetupBody.parse(req.body);
    const [existing] = await db.select({ id: companies.id }).from(companies).limit(1);
    if (existing) throw alreadySetUp();

    const passwordHash = await hashPassword(body.password);
    const { chief } = body;
    const joinCode = chief.mode === 'personal' ? newToken() : undefined;

    let result;
    try {
      result = await db.transaction(async tx => {
        const [company] = await tx.insert(companies).values({ name: body.companyName }).returning();
        const [person] = await tx.insert(people).values({
          companyId: company!.id,
          name: body.name,
          email: body.email,
          title: 'CEO',
          passwordHash,
          status: 'active',
          scopeKind: 'company',
          isOwner: true,
        }).returning();

        let subscriptionId: string | null = null;
        if (chief.mode !== 'later') {
          const [sub] = await tx.insert(subscriptions).values({
            companyId: company!.id,
            provider: chief.provider,
            kind: chief.mode === 'api_key' ? 'api_key' : 'personal',
            label: 'Chief',
            ownerPersonId: person!.id,
            secretEnc: chief.mode === 'api_key' ? encryptSecret(chief.apiKey, config.secret) : null,
            last4: chief.mode === 'api_key' ? chief.apiKey.slice(-4) : null,
            joinCodeHash: joinCode ? hashToken(joinCode) : null,
            status: chief.mode === 'api_key' ? 'active' : 'waiting_machine',
            targetKind: 'chief',
          }).returning({ id: subscriptions.id });
          subscriptionId = sub!.id;
        }

        await tx.insert(agents).values({
          companyId: company!.id,
          kind: 'chief',
          name: 'Chief',
          model: chiefModel(chief),
          subscriptionId,
        });
        return { company: company!, person: person! };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw alreadySetUp();
      throw err;
    }

    const { company, person } = result;
    await startSession(reply, db, config, person.id);
    reply.code(201);
    return {
      company: { id: company.id, name: company.name },
      person: { id: person.id, name: person.name, email: person.email, title: person.title },
      ...(joinCode ? { joinCode, serverUrl: config.publicUrl } : {}),
    };
  });
}
