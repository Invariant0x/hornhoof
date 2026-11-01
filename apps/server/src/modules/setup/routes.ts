import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../app.js';
import { hashPassword } from '../../auth/password.js';
import { startSession } from '../../auth/session.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { isUniqueViolation } from '../../db/errors.js';
import { agents, companies, people, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { createNodeCode } from '../nodes/codes.js';
import { installCommand } from '../nodes/command.js';
import { isSetupCode, setupNeeded } from './code.js';

const DEFAULT_MODEL = 'claude-opus-5-5';
const PLAN_LABELS = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM' } as const;
/* Claude Code passes it to Z.ai's endpoint as it is. */
const GLM_MODEL = 'glm-5.3';

const SetupBody = z.object({
  code: z.string().max(200).default(''),
  companyName: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10).max(200),
  title: z.string().trim().max(80).optional(),
  orchestrator: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('later') }),
    z.object({ mode: z.literal('api_key'), provider: z.enum(['anthropic_api', 'openai_api']), apiKey: z.string().trim().min(8) }),
    z.object({ mode: z.literal('personal'), provider: z.enum(['claude', 'codex', 'kimi', 'glm']) }),
  ]),
});

type Orchestrator = z.infer<typeof SetupBody>['orchestrator'];

function orchestratorModel(orchestrator: Orchestrator): string {
  if (orchestrator.mode === 'later' || orchestrator.provider === 'anthropic_api' || orchestrator.provider === 'claude') return DEFAULT_MODEL;
  if (orchestrator.provider === 'glm') return GLM_MODEL;
  return orchestrator.provider;
}

const alreadySetUp = () => new ApiError(409, 'conflict', 'This Hornhoof is already set up.', 'already_set_up');

export function setupRoutes(app: FastifyInstance, { db, config }: Deps): void {
  app.get('/api/setup', async () => ({ needed: await setupNeeded(db) }));

  app.post('/api/setup', async (req, reply) => {
    const body = SetupBody.parse(req.body);
    if (!(await setupNeeded(db))) throw alreadySetUp();
    if (!isSetupCode(config.secret, body.code)) {
      throw new ApiError(403, 'forbidden', 'This setup code is not right. Open the setup link from the server log.', 'setup_code');
    }

    const passwordHash = await hashPassword(body.password);
    const { orchestrator } = body;
    let result;
    try {
      result = await db.transaction(async tx => {
        const [company] = await tx.insert(companies).values({ name: body.companyName }).returning();
        const [person] = await tx.insert(people).values({
          companyId: company!.id,
          name: body.name,
          email: body.email,
          title: body.title || 'CEO',
          passwordHash,
          status: 'active',
          scopeKind: 'company',
          isOwner: true,
        }).returning();

        let subscriptionId: string | null = null;
        let code: string | null = null;
        if (orchestrator.mode === 'api_key') {
          const [sub] = await tx.insert(subscriptions).values({
            companyId: company!.id,
            provider: orchestrator.provider,
            kind: 'api_key',
            label: 'Orchestrator',
            ownerPersonId: person!.id,
            secretEnc: encryptSecret(orchestrator.apiKey, config.secret),
            last4: orchestrator.apiKey.slice(-4),
            status: 'ready',
            /* The company's first key serves every department too, so the first people can be hired on it. */
            targetKind: 'any',
          }).returning({ id: subscriptions.id });
          subscriptionId = sub!.id;
        } else if (orchestrator.mode === 'personal') {
          /* A personal subscription has no target: it serves wherever its owner works, here the whole company. */
          const [sub] = await tx.insert(subscriptions).values({
            companyId: company!.id,
            provider: orchestrator.provider,
            kind: 'personal',
            label: PLAN_LABELS[orchestrator.provider],
            ownerPersonId: person!.id,
            status: 'waiting_machine',
          }).returning({ id: subscriptions.id });
          subscriptionId = sub!.id;
          code = await createNodeCode(tx, { companyId: company!.id, personId: person!.id, subscriptionIds: [sub!.id] });
        }

        await tx.insert(agents).values({
          companyId: company!.id,
          kind: 'orchestrator',
          name: 'Orchestrator',
          model: orchestratorModel(orchestrator),
          subscriptionId,
        });
        return { company: company!, person: person!, code };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw alreadySetUp();
      throw err;
    }

    const { company, person, code } = result;
    await startSession(reply, db, config, person.id, passwordHash);
    reply.code(201);
    return {
      company: { id: company.id, name: company.name },
      person: { id: person.id, name: person.name, email: person.email, title: person.title },
      ...(code ? { command: installCommand(config.publicUrl, code) } : {}),
    };
  });
}
