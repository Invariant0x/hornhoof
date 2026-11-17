import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { employeeChangedBy, personColumns, requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import { encryptSecret } from '../../crypto/secrets.js';
import { hashToken } from '../../crypto/tokens.js';
import type { Db } from '../../db/client.js';
import { agentChanges, agents, ASSISTANT_PROGRAMS, assistants, jobs, people, subscriptions } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { releaseLeftProgram } from '../agents/left-programs.js';
import { afterPlanMove } from '../agents/routes.js';
import { onAgent } from '../conversation/queue.js';
import { publicUrl } from '../link/link.js';
import { personView } from '../people/views.js';
import { stopJobs } from '../tasks/wake.js';
import { settingsFor } from './programs.js';

/* Where Hornhoof wakes the assistant, and where its own agent asks the program for its skills: web addresses of the
   program, which the people who set it up chose. */
const EventsUrl = z.url({ protocol: /^https?$/ }).max(500).nullable();
const NewAssistant = z
  .object({
    name: z.string().trim().min(1).max(80),
    title: z.string().trim().max(80).default(''),
    owner: z.uuid(),
    program: z.enum(ASSISTANT_PROGRAMS),
    eventsUrl: EventsUrl.optional(),
  })
  .strict();
const AssistantPatch = z.object({ program: z.enum(ASSISTANT_PROGRAMS).optional(), eventsUrl: EventsUrl.optional(), skillsUrl: EventsUrl.optional(), plan: z.uuid().nullable().optional() }).strict();
const IdParams = z.object({ id: z.uuid() });

/* A key and a signing secret: 32 random bytes each, with a prefix that tells them apart in a program's settings. */
export const KEY_PREFIX = 'hha_';
const SECRET_PREFIX = 'hhs_';
const fresh = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;

type Owner = Pick<Person, 'id' | 'isOwner' | 'isCeoDelegate'>;

/* Who sets up an assistant: its owner, or someone with the whole company. The key acts with all its owner's rights, so the
   CEO's and the CEO delegate's are set up only by the CEO, as their Telegram is, and by the delegate for their own, or by
   the orchestrator, which can do everything. Never a department's head, nor an assistant. */
function guardManager(me: Person, owner: Owner): void {
  if (me.viaHead || me.assistant) throw new ApiError(403, 'forbidden', "An assistant is set up only from a person's own screen.", 'assistant_not_allowed');
  if (owner.id === me.id) return;
  if ((owner.isOwner || owner.isCeoDelegate) && !me.isOwner) throw new ApiError(403, 'forbidden', 'Only the CEO sets up the assistant of the CEO or the CEO delegate.', 'owner_locked');
  requireCompanyScope(me);
}

const unknownPerson = () => new ApiError(404, 'not_found', 'This person does not exist.', 'person_unknown');

/* The person an assistant is for: active, of the company, and a person, never another assistant. */
async function ownerFor(db: Db, me: Person, id: string): Promise<Person> {
  const [owner] = await db.select({ ...personColumns, isAgent: people.isAgent }).from(people).where(and(eq(people.id, id), eq(people.companyId, me.companyId)));
  if (!owner) throw unknownPerson();
  if (owner.isAgent || owner.status !== 'active') throw new ApiError(409, 'conflict', 'An assistant belongs to an active person of the company, who is not an assistant.', 'assistant_owner_invalid');
  return owner;
}

/* The assistant a route names, with its owner, for someone who may set it up. A deleted one is gone for good. */
async function managedAssistant(db: Db, me: Person, id: string): Promise<Person & { assistantOf: string | null }> {
  const [row] = await db.select({ ...personColumns, assistantOf: people.assistantOf }).from(people).where(and(eq(people.id, id), eq(people.companyId, me.companyId), isNull(people.removedAt)));
  if (!row) throw unknownPerson();
  if (!row.assistantOf) throw new ApiError(409, 'conflict', 'This person is not an assistant.', 'not_an_assistant');
  const [owner] = await db.select(personColumns).from(people).where(eq(people.id, row.assistantOf));
  guardManager(me, owner!);
  return row;
}

/* The plan the assistant's own agent thinks on: a personal plan of its owner, which only its owner picks, as it is their
   sign-in that works for it. The first plan makes the agent, once however many screens pick at the same moment; none
   leaves it waiting with nothing to run on. A switched off assistant's agent takes no plan. */
export async function putOnPlan(ctx: Ctx, me: Person, assistant: Pick<Person, 'id' | 'name' | 'companyId' | 'status'> & { assistantOf: string | null }, planId: string | null): Promise<void> {
  const { db } = ctx;
  if (assistant.assistantOf !== me.id) throw new ApiError(403, 'forbidden', "Only the assistant's owner picks the plan its agent thinks on.", 'assistant_plan_owner_only');
  if (planId) {
    if (assistant.status === 'disabled') throw new ApiError(409, 'conflict', "A switched off assistant's agent takes no plan: switch the assistant on first.", 'assistant_switched_off');
    const [plan] = await db
      .select(idOnly(subscriptions))
      .from(subscriptions)
      .where(and(eq(subscriptions.id, planId), eq(subscriptions.companyId, me.companyId), eq(subscriptions.kind, 'personal'), eq(subscriptions.ownerPersonId, me.id), isNull(subscriptions.removedAt)));
    if (!plan) throw new ApiError(409, 'conflict', "An assistant's agent thinks only on a personal plan of its owner.", 'assistant_plan_invalid');
  }
  /* The assistant's row stays locked while its agent is made, so a pick at the same moment finds that agent. */
  const found = await db.transaction(async tx => {
    const [row] = await tx.select(only(assistants, 'agentId')).from(assistants).where(eq(assistants.personId, assistant.id)).for('update');
    if (row?.agentId || !planId) return row?.agentId ?? null;
    const [agent] = await tx.insert(agents).values({ companyId: me.companyId, kind: 'assistant', name: assistant.name, model: '', subscriptionId: planId, createdBy: me.id }).returning({ id: agents.id });
    await tx.update(assistants).set({ agentId: agent!.id }).where(eq(assistants.personId, assistant.id));
    return undefined;
  });
  if (found === null) return;
  if (found) {
    /* In the agent's line, from the plan it is on at that moment, as every change of its plan goes. */
    const agent = await onAgent(ctx, found, async () => {
      const [now] = await db.select().from(agents).where(eq(agents.id, found));
      if (!now || now.subscriptionId === planId) return null;
      await db.update(agents).set({ subscriptionId: planId }).where(eq(agents.id, found));
      return now;
    });
    if (!agent) return;
    await afterPlanMove(ctx, agent, { ...agent, subscriptionId: planId });
  }
  ctx.bus.accessChanged(me.companyId);
}

/* A switched off assistant's own agent lets go of its owner's plan, as agents do when their plan's owner is switched off:
   nothing of it runs on the owner's sign-in until the assistant is on again and its owner picks a plan once more. */
export async function releaseAssistantAgent(ctx: Ctx, assistantId: string, by: Person): Promise<void> {
  const { db } = ctx;
  const [row] = await db.select(only(assistants, 'agentId')).from(assistants).where(eq(assistants.personId, assistantId));
  if (!row?.agentId) return;
  const id = row.agentId;
  const left = await onAgent(ctx, id, async () => {
    const [agent] = await db.select().from(agents).where(eq(agents.id, id));
    if (!agent?.subscriptionId) return null;
    await db.transaction(async tx => {
      await tx.update(agents).set({ subscriptionId: null }).where(eq(agents.id, id));
      await tx.insert(agentChanges).values({ companyId: agent.companyId, agentId: id, ...employeeChangedBy(by), field: 'subscription', before: agent.subscriptionId, after: null });
    });
    return agent.subscriptionId;
  });
  if (left) await releaseLeftProgram(ctx, id, left);
}

/* A deleted assistant's own agent leaves the company with it: it lets go of its owner's plan, its turns end, and its
   conversation stays in the history. */
export async function removeAssistantAgent(ctx: Ctx, assistantId: string, by: Person): Promise<void> {
  const { db } = ctx;
  await releaseAssistantAgent(ctx, assistantId, by);
  const [row] = await db.select(only(assistants, 'agentId')).from(assistants).where(eq(assistants.personId, assistantId));
  if (!row?.agentId) return;
  const id = row.agentId;
  await db.transaction(async tx => {
    const [agent] = await tx.update(agents).set({ removedAt: new Date() }).where(and(eq(agents.id, id), isNull(agents.removedAt))).returning(only(agents, 'companyId'));
    if (agent) await tx.insert(agentChanges).values({ companyId: agent.companyId, agentId: id, ...employeeChangedBy(by), field: 'removed', before: null, after: null });
  });
  await stopJobs(ctx, eq(jobs.agentId, id));
}

/* Adding an assistant on the People screen, changing how it is reached, the plan its own agent thinks on, and its key:
   made, made again or taken back. */
export function assistantSetupRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  app.post('/api/people/assistants', async (req, reply) => {
    const me = await requirePerson(req, db);
    const body = NewAssistant.parse(req.body);
    const owner = await ownerFor(db, me, body.owner);
    guardManager(me, owner);
    const person = await db.transaction(async tx => {
      const [row] = await tx
        .insert(people)
        .values({ companyId: me.companyId, name: body.name, title: body.title, email: null, status: 'active', scopeKind: 'listed', isAgent: true, assistantOf: owner.id })
        .returning(personColumns);
      await tx.insert(assistants).values({ personId: row!.id, companyId: me.companyId, program: body.program, eventsUrl: body.eventsUrl ?? null });
      return row!;
    });
    ctx.bus.publish(me.companyId, { type: 'org' });
    reply.code(201);
    return { person: await personView(db, person) };
  });

  app.patch('/api/people/:id/assistant', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const { plan, ...body } = AssistantPatch.parse(req.body);
    const person = await managedAssistant(db, me, id);
    if (plan !== undefined) await putOnPlan(ctx, me, person, plan);
    if (Object.keys(body).length) await db.update(assistants).set(body).where(eq(assistants.personId, id));
    return { person: await personView(db, person) };
  });

  /* Makes the key and the signing secret, or makes them again: the ones before stop working at once. Shown only here, with
     the company's address as its invite links have it, for the program to call, and the settings that connect the program
     where it takes them in a file of its own. */
  app.post('/api/people/:id/key', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const person = await managedAssistant(db, me, id);
    const key = fresh(KEY_PREFIX);
    const signingSecret = fresh(SECRET_PREFIX);
    const [row] = await db
      .update(assistants)
      .set({ keyHash: hashToken(key), keyCreatedAt: new Date(), wakeSecretEnc: encryptSecret(signingSecret, ctx.config.secret) })
      .where(eq(assistants.personId, id))
      .returning({ program: assistants.program, eventsUrl: assistants.eventsUrl });
    /* What waits for the owner already is told to the assistant once it has a key. */
    ctx.assistants.collect(me.companyId);
    const address = await publicUrl(db, ctx.config);
    reply.code(201);
    return { key, signingSecret, address, setup: settingsFor(row!.program, { address, key, secret: signingSecret, woken: Boolean(row!.eventsUrl) }), person: await personView(db, person) };
  });

  app.delete('/api/people/:id/key', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const person = await managedAssistant(db, me, id);
    await db.update(assistants).set({ keyHash: null, keyCreatedAt: null, wakeSecretEnc: null }).where(eq(assistants.personId, id));
    return { person: await personView(db, person) };
  });
}
