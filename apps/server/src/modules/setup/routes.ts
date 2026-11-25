import { COMPANY_TEMPLATES, COMPANY_TEMPLATE_KEYS, DEPARTMENT_TEMPLATES } from '@hornhoof/protocol';
import { ensureOpenTurn } from '../tasks/turn-department.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { hashPassword } from '../../auth/password.js';
import { startSession } from '../../auth/session.js';
import type { Config } from '../../config.js';
import { encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import { agents, companies, departments, people, subscriptions } from '../../db/schema.js';
import { ApiError, loggable } from '../../errors.js';
import { hireEmployee } from '../departments/hire.js';
import { companyRoster, templateTeams } from '../departments/roster.js';
import { saveLink } from '../link/link.js';
import type { Bound } from '../link/relay.js';
import { LinkBody } from '../link/routes.js';
import { createNodeCode } from '../nodes/codes.js';
import { installCommand } from '../nodes/command.js';
import { seedCatalogPipelines } from '../tracker/pipelines.js';
import { ensureOperations } from '../operations/ensure.js';
import { placeableSubscriptions, spotIn } from '../tools/staff.js';
import { isSetupCode, setupNeeded } from './code.js';
import { slotCapOfNew, turnStartOfNew } from '../tasks/slots.js';

const roleCodeOf = (template: string) => DEPARTMENT_TEMPLATES.find(t => t.key === template)!.roleCode;

const DEFAULT_MODEL = 'claude-opus-5-5';
const PLAN_LABELS = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi', glm: 'GLM', antigravity: 'Antigravity' } as const;
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
    z.object({ mode: z.literal('personal'), provider: z.enum(['claude', 'codex', 'kimi', 'glm', 'antigravity']) }),
  ]),
  /* The public link at hornhoof.org the company opens at, with a name or a random one; left out, none. */
  link: LinkBody.optional(),
  /* A ready-made company to start from, whose departments come right away with their people; left out, the company starts
     empty. */
  template: z.enum(COMPANY_TEMPLATE_KEYS).optional(),
});
const CodeQuery = z.object({ code: z.string().max(200).default('') });

type Orchestrator = z.infer<typeof SetupBody>['orchestrator'];
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function orchestratorModel(orchestrator: Orchestrator): string {
  if (orchestrator.mode === 'later' || orchestrator.provider === 'anthropic_api' || orchestrator.provider === 'claude') return DEFAULT_MODEL;
  if (orchestrator.provider === 'glm') return GLM_MODEL;
  return orchestrator.provider;
}

const alreadySetUp = () => new ApiError(409, 'conflict', 'This Hornhoof is already set up.', 'already_set_up');

type SetupInput = { body: z.infer<typeof SetupBody>; passwordHash: string; bound: Bound | null };

/* The orchestrator's subscription when it has one now, and the code of the machine a personal plan waits for. */
async function orchestratorSubscription(
  tx: Tx,
  config: Config,
  owner: { companyId: string; personId: string },
  orchestrator: Orchestrator,
): Promise<{ subscriptionId: string | null; code: string | null }> {
  if (orchestrator.mode === 'api_key') {
    const [sub] = await tx.insert(subscriptions).values({
      companyId: owner.companyId,
      provider: orchestrator.provider,
      kind: 'api_key',
      label: 'Orchestrator',
      ownerPersonId: owner.personId,
      secretEnc: encryptSecret(orchestrator.apiKey, config.secret),
      last4: orchestrator.apiKey.slice(-4),
      status: 'ready',
      /* The company's first key serves every department too, so the first people can be hired on it. */
      targetKind: 'any',
    }).returning({ id: subscriptions.id });
    return { subscriptionId: sub!.id, code: null };
  }
  if (orchestrator.mode === 'personal') {
    /* A personal subscription has no target: it serves wherever its owner works, here the whole company. */
    const [sub] = await tx.insert(subscriptions).values({
      companyId: owner.companyId,
      provider: orchestrator.provider,
      kind: 'personal',
      label: PLAN_LABELS[orchestrator.provider],
      ownerPersonId: owner.personId,
      status: 'waiting_machine',
    }).returning({ id: subscriptions.id });
    return { subscriptionId: sub!.id, code: await createNodeCode(tx, { ...owner, subscriptionIds: [sub!.id] }) };
  }
  return { subscriptionId: null, code: null };
}

/* A ready-made company starts with its template's departments, their products and their people, so it works once a
   subscription is on. Each employee takes the first plan here that may serve it, as a hire does, or waits for one. */
async function templateDepartments(ctx: Ctx, tx: Tx, companyId: string, personId: string, template: SetupInput['body']['template']): Promise<void> {
  const chosen = COMPANY_TEMPLATES.find(t => t.key === template);
  if (!chosen) return;
  const by = { personId, byOrchestrator: false };
  let position = 0;
  for (const dept of chosen.departments) {
    const roleCode = roleCodeOf(dept.template);
    const [row] = await tx
      .insert(departments)
      .values({ companyId, templateKey: dept.template, name: dept.name ?? null, roleCode, position: position++, slotCap: slotCapOfNew(dept.template), turnStart: turnStartOfNew(dept.template) })
      .returning();
    await ensureOpenTurn(tx, companyId, row!.id);
    await seedCatalogPipelines(ctx, tx, row!, { personId });
    for (const product of dept.products ?? []) {
      await tx.insert(departments).values({ companyId, name: product, parentId: row!.id, roleCode, position: position++ });
    }
    /* Its people by the company template, and the turnkey teams of its department template, as the orchestrator
       builds a department with its people. */
    const serving = await placeableSubscriptions({ db: tx }, companyId, spotIn(row!));
    const lines = [...companyRoster(ctx, dept.staff, serving), ...(await templateTeams(ctx, tx, row!, serving))];
    for (const line of lines) await hireEmployee(ctx, tx, { companyId, departmentId: row!.id }, line, by);
  }
}

async function createCompany(ctx: Ctx, tx: Tx, { body, passwordHash, bound }: SetupInput) {
  const { config } = ctx;
  const [company] = await tx.insert(companies).values({ name: body.companyName, template: body.template ?? null }).returning();
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
  const { subscriptionId, code } = await orchestratorSubscription(tx, config, { companyId: company!.id, personId: person!.id }, body.orchestrator);
  await tx.insert(agents).values({
    companyId: company!.id,
    kind: 'orchestrator',
    name: 'Orchestrator',
    model: orchestratorModel(body.orchestrator),
    subscriptionId,
  });
  await templateDepartments(ctx, tx, company!.id, person!.id, body.template);
  if (bound) await saveLink(tx, config, company!.id, bound);
  return { company: company!, person: person!, code };
}

type Made = Awaited<ReturnType<typeof createCompany>>;

/* A company that was not made lets go of the link it took, or the name stays taken at the relay. */
async function madeOrLinkLetGo(ctx: Ctx, input: SetupInput): Promise<Made> {
  try {
    return await ctx.db.transaction(tx => createCompany(ctx, tx, input));
  } catch (err) {
    if (input.bound) await ctx.links.letGo(input.bound.name, input.bound.key);
    if (isUniqueViolation(err)) throw alreadySetUp();
    throw err;
  }
}

function setupAnswer({ company, person, code }: Made, bound: Bound | null, publicUrl: string) {
  return {
    company: { id: company.id, name: company.name },
    person: { id: person.id, name: person.name, email: person.email, title: person.title },
    ...(bound ? { link: { name: bound.name, url: bound.url } } : {}),
    ...(code ? { command: installCommand(bound?.url ?? publicUrl, code) } : {}),
  };
}

export function setupRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;

  /* Until a company exists, only whoever has the code from the setup link gets anywhere. */
  async function setupOnly(code: string) {
    if (!(await setupNeeded(db))) throw alreadySetUp();
    if (!isSetupCode(config.secret, code)) {
      throw new ApiError(403, 'forbidden', 'This setup code is not right. Open the setup link from the server log.', 'setup_code');
    }
  }

  /* recovering: whoever has the setup code gave this server a recovery file, and it waits for a backup to restore. */
  app.get('/api/setup', async () => {
    const needed = await setupNeeded(db);
    return { needed, linkDomain: ctx.links.domain(), recovering: needed && ctx.totalLoss.active() !== null };
  });

  app.get('/api/setup/names/:name', async req => {
    await setupOnly(CodeQuery.parse(req.query).code);
    return ctx.links.check(z.object({ name: z.string().max(200) }).parse(req.params).name);
  });

  app.post('/api/setup', async (req, reply) => {
    const body = SetupBody.parse(req.body);
    await setupOnly(body.code);

    const passwordHash = await hashPassword(body.password);
    /* The link comes first, so a name taken meanwhile sets nothing up and the person picks another. */
    const bound = body.link ? await ctx.links.relay.bind(body.link.name) : null;
    const made = await madeOrLinkLetGo(ctx, { body, passwordHash, bound });
    if (bound) {
      await ctx.links.sync();
      ctx.tls.kick();
    }
    /* The check repeats it, so a failure here does not lose the company that is already set up. */
    await ensureOperations(ctx, made.company.id).catch((err: unknown) => ctx.log.error({ error: loggable(err) }, 'Staffing Operations of the new company failed.'));
    await startSession(reply, db, config, made.person.id, passwordHash);
    /* A company made anew: whatever was begun of a recovery ends. */
    ctx.totalLoss.end();
    reply.code(201);
    return setupAnswer(made, bound, config.publicUrl);
  });
}
