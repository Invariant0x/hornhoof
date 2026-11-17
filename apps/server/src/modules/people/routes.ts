import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { passResponsibility } from '../tracker/upgrade.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { AccessInput, accessOf, agentSpot, canReach, checkAccess, saveAccess } from '../../auth/access.js';
import { guard, limiter } from '../../auth/limit.js';
import { hashPassword } from '../../auth/password.js';
import { employeeChangedBy, personColumns, requireCompanyScope, requirePerson, startSession, type Person } from '../../auth/session.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import type { Db } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import { agentChanges, agents, assistants, companies, invites, machines, people, personChanges, sessions, subscriptions, personKeys } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { releaseLeftProgram } from '../agents/left-programs.js';
import { releaseAssistantAgent, removeAssistantAgent } from '../assistants/setup.js';
import { onAgent } from '../conversation/queue.js';
import { afterLeave, cutReplication, leaveData, leavingData } from '../copies/scope.js';
import { publicUrl } from '../link/link.js';
import { disconnectMachines, refuseLeader } from '../nodes/disconnect.js';
import { removeSubscription } from '../subscriptions/routes.js';
import { personView, personViews } from './views.js';

const INVITE_DAYS = 7;

export const InviteBody = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  title: z.string().trim().max(80).default(''),
  access: AccessInput,
});

const AcceptBody = z.object({ password: z.string().min(10).max(200) });

export const PersonPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().max(80).optional(),
  access: AccessInput.optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const DelegateBody = z.object({ isCeoDelegate: z.boolean() }).strict();

/* Who the person is in Telegram, apart from PersonPatch, which the orchestrator's tool takes whole: a username with or
   without @, a t.me link, or the account's number; empty takes it off. */
const TelegramPatch = z.object({ telegram: z.string().trim().max(64).nullable().optional() });
type TelegramColumns = { telegramUsername: string | null; telegramUserId: number | null };

const badTelegram = () => new ApiError(400, 'validation', 'Write the Telegram username, like @name, or the number of the account.', 'telegram_invalid');

/* What the field says, or nothing to change when it says what is kept already: a bot keeps the number it learned. */
function telegramChange(input: string | null | undefined, now: TelegramColumns): TelegramColumns | undefined {
  if (input === undefined) return undefined;
  const plain = (input ?? '').replace(/^(?:https?:\/\/)?t\.me\//i, '').replace(/^@/, '');
  if (!plain) return now.telegramUsername || now.telegramUserId ? { telegramUsername: null, telegramUserId: null } : undefined;
  if (/^\d{1,15}$/.test(plain)) return Number(plain) === now.telegramUserId ? undefined : { telegramUsername: null, telegramUserId: Number(plain) };
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(plain)) throw badTelegram();
  return plain.toLowerCase() === now.telegramUsername ? undefined : { telegramUsername: plain.toLowerCase(), telegramUserId: null };
}

/* A Telegram account speaks to the bots as the person it is set for, so it is set from a person's own screen: for
   themselves, or by whoever changes that person, and for the CEO or the CEO delegate only by the CEO. */
function guardTelegram(me: Person, target: Pick<Person, 'id' | 'isOwner' | 'isCeoDelegate'>): void {
  if (me.viaHead) throw new ApiError(403, 'forbidden', 'Who a person is in Telegram is set only from a person\'s own screen, or by the orchestrator.');
  if (target.id !== me.id && (target.isOwner || target.isCeoDelegate) && !me.isOwner) {
    throw new ApiError(403, 'forbidden', 'Only the CEO sets who the CEO or the CEO delegate is in Telegram.', 'owner_locked');
  }
}

const IdParams = z.object({ id: z.uuid() });
const TokenParams = z.object({ token: z.string().min(1).max(100) });

const inviteFor = (token: string, by: Pick<Person, 'id' | 'companyId'>, personId: string) => ({
  tokenHash: hashToken(token),
  companyId: by.companyId,
  personId,
  createdBy: by.id,
  expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
});

const notFound = () => new ApiError(404, 'not_found', 'This invite does not exist.', 'invite_unknown');
const gone = () => new ApiError(410, 'gone', 'This invite has already been used or has expired. Ask for a new one.', 'invite_used');
/* The delegate takes the CEO's decisions, so whoever could change their access, status or sign-in could take them too. */
const delegateLocked = () => new ApiError(403, 'forbidden', 'Only the CEO changes the access or status of the CEO delegate.', 'owner_locked');
const notDelegable = () => new ApiError(409, 'conflict', 'Only an active person with access to the whole company can be the CEO delegate.', 'delegate_requires_company_access');
/* Who may hold the mark: an active person with the whole company. */
const DELEGABLE = and(eq(people.status, 'active'), eq(people.scopeKind, 'company'));

type Patch = z.infer<typeof PersonPatch>;

/* An assistant reaches what its owner reaches, through its key: it has no access and no Telegram of its own. */
function guardAssistantPatch(body: Patch, telegram: string | null | undefined): void {
  if (body.access === undefined && telegram === undefined) return;
  throw new ApiError(409, 'conflict', 'An assistant has no access or Telegram of its own: it acts with the rights of the person it belongs to.', 'assistant_has_owner_rights');
}

/* Only the CEO changes the access or status of the delegate. */
function guardDelegate(me: Person, target: { isCeoDelegate: boolean }, body: Patch): void {
  const touches = body.access !== undefined || body.status !== undefined;
  if (touches && target.isCeoDelegate && !me.isOwner) throw delegateLocked();
}

/* Only the CEO or the CEO delegate changes another person's name. */
function guardRename(me: Person, id: string, body: Patch): void {
  const canRenameOther = me.isOwner || (me.isCeoDelegate && me.scopeKind === 'company');
  if (id !== me.id && body.name !== undefined && !canRenameOther) throw new ApiError(403, 'forbidden', 'Only the CEO or the CEO delegate changes another person\'s name.', 'owner_locked');
}

function guardDisable(me: Person, target: Pick<Person, 'id' | 'isOwner'>, body: Patch): void {
  if (body.status !== 'disabled') return;
  if (target.isOwner) throw new ApiError(403, 'forbidden', 'The owner cannot be disabled.', 'owner_locked');
  if (target.id === me.id) throw new ApiError(403, 'forbidden', 'You cannot disable yourself.', 'self_locked');
}

/* New access changes what each person may reach; a new name only what the map and the lists show. */
function tellOfChange(ctx: Ctx, companyId: string, access: boolean, renamed: boolean): void {
  if (access) ctx.bus.accessChanged(companyId);
  if (access || renamed) ctx.bus.publish(companyId, { type: 'org' });
}

/* The mark goes with the whole company and an active account, and does not come back with them. */
function markAfter(status: string | undefined, body: Patch): { isCeoDelegate?: false } {
  const narrowed = body.access !== undefined && !('whole' in body.access);
  return status === 'disabled' || narrowed ? { isCeoDelegate: false } : {};
}

/* The person the CEO marks or unmarks: one of the company, not the CEO, and able to hold the mark when it is set. */
async function delegateTarget(db: Db, me: Person, id: string, isCeoDelegate: boolean): Promise<Person> {
  const [target] = await db.select(personColumns).from(people).where(and(eq(people.id, id), eq(people.companyId, me.companyId)));
  if (!target) throw new ApiError(404, 'not_found', 'This person does not exist.', 'person_unknown');
  if (target.isOwner) throw new ApiError(403, 'forbidden', "The CEO takes the CEO's decisions already.", 'owner_locked');
  if (isCeoDelegate && (target.status !== 'active' || target.scopeKind !== 'company')) throw notDelegable();
  return target;
}

/* A fresh link for someone already in the company. It doubles as a password reset, so old access ends here. The person's
   row changes before the sessions go, so a sign-in that holds it finishes first and its session is deleted too. */
export async function reinvite(db: Db, personId: string, by: Pick<Person, 'id' | 'companyId'>): Promise<{ token: string; person: Person }> {
  const token = newToken();
  const person = await db.transaction(async tx => {
    const [row] = await tx.update(people).set({ status: 'invited', passwordHash: null, isCeoDelegate: false }).where(and(eq(people.id, personId), eq(people.companyId, by.companyId))).returning(personColumns);
    if (!row) throw new ApiError(404, 'not_found', 'This person does not exist.', 'person_unknown');
    await tx.update(invites).set({ usedAt: new Date() }).where(and(eq(invites.personId, personId), isNull(invites.usedAt)));
    await tx.delete(sessions).where(eq(sessions.personId, personId));
    /* The person's key was wrapped with the password that ends here, so it goes too: they make a new one, and their
       machines take it from the next command they run there. */
    await tx.delete(personKeys).where(eq(personKeys.personId, personId));
    await tx.insert(invites).values(inviteFor(token, by, personId));
    return row!;
  });
  return { token, person };
}

/* A personal plan serves where its owner works. When the owner is disabled or no longer reaches an agent's place, the agent
   lets go of the plan and waits for another; the orchestrator is company-wide, so it needs an owner with the whole company. */
async function releasePlansOf(ctx: Ctx, owner: Pick<Person, 'id' | 'companyId' | 'scopeKind' | 'status'>, by: Person): Promise<void> {
  const { db } = ctx;
  const theirs = (await db.select(idOnly(subscriptions)).from(subscriptions).where(and(eq(subscriptions.ownerPersonId, owner.id), eq(subscriptions.kind, 'personal')))).map(s => s.id);
  if (!theirs.length) return;
  const bound = await db.select(idOnly(agents)).from(agents).where(and(inArray(agents.subscriptionId, theirs), isNull(agents.removedAt)));
  const access = await accessOf(db, owner);
  let freed = false;
  for (const { id } of bound) {
    /* In the agent's line, so a card change that read the plan cannot put it back. */
    await onAgent(ctx, id, async () => {
      const [agent] = await db.select().from(agents).where(eq(agents.id, id));
      if (!agent?.subscriptionId || !theirs.includes(agent.subscriptionId)) return;
      /* An assistant's own agent stays on its owner's plan while its owner is on, wherever they reach. */
      const stays = owner.status !== 'disabled' && (agent.kind === 'assistant' || (agent.kind === 'orchestrator' ? access.whole : canReach(access, await agentSpot(db, agent))));
      if (stays) return;
      await db.transaction(async tx => {
        await tx.update(agents).set({ subscriptionId: null }).where(eq(agents.id, id));
        await tx.insert(agentChanges).values({ companyId: agent.companyId, agentId: id, ...employeeChangedBy(by), field: 'subscription', before: agent.subscriptionId, after: null });
      });
      await releaseLeftProgram(ctx, id, agent.subscriptionId);
      freed = true;
    });
  }
  if (freed) ctx.bus.publish(owner.companyId, { type: 'org' });
}

/* A person's account ends: their sessions go, their machines leave the company, and their plans stop serving it. by:
   who did it; the company's owner when nobody acts, as when a restore carries over that the person was disabled. */
export async function disablePerson(ctx: Ctx, personId: string, by?: Person): Promise<void> {
  const { db } = ctx;
  const person = await db.transaction(async tx => {
    await tx.update(people).set({ status: 'disabled', isCeoDelegate: false }).where(eq(people.id, personId));
    await tx.delete(sessions).where(eq(sessions.personId, personId));
    const [row] = await tx.select(personColumns).from(people).where(eq(people.id, personId));
    return row;
  });
  if (!person) return;
  const theirs = await db.select(idOnly(machines)).from(machines).where(and(eq(machines.personId, personId), isNull(machines.revokedAt)));
  await disconnectMachines(ctx, theirs.map(m => m.id));
  const [owner] = by ? [by] : await db.select(personColumns).from(people).where(and(eq(people.companyId, person.companyId), eq(people.isOwner, true)));
  if (owner) await releasePlansOf(ctx, person, owner);
  await passResponsibility(ctx, person.companyId, personId);
}

/* A person or an assistant leaves the company for good: their account ends as when disabled, and with it their sign-in,
   invites, keys and own plans; an assistant's own agent leaves too, and so do the person's own assistants. The row stays,
   with its name, for the old tasks and answers that point at it, and leaves the lists and the map. Its email and Telegram
   are free for someone else. */
export async function removePerson(ctx: Ctx, personId: string, by: Person): Promise<void> {
  const { db } = ctx;
  const helpers = await db.select(idOnly(people)).from(people).where(and(eq(people.assistantOf, personId), isNull(people.removedAt)));
  for (const { id } of helpers) await removePerson(ctx, id, by);
  const now = new Date();
  await db.transaction(async tx => {
    await tx.update(people).set({ removedAt: now, email: null, passwordHash: null, telegramUsername: null, telegramUserId: null }).where(eq(people.id, personId));
    await tx.update(invites).set({ usedAt: now }).where(and(eq(invites.personId, personId), isNull(invites.usedAt)));
    await tx.delete(personKeys).where(eq(personKeys.personId, personId));
    await tx.update(assistants).set({ keyHash: null, keyCreatedAt: null, wakeSecretEnc: null }).where(eq(assistants.personId, personId));
  });
  await disablePerson(ctx, personId, by);
  /* Their own plans run on their sign-in; a key they added for the company is the company's and stays. */
  const plans = await db.select().from(subscriptions).where(and(eq(subscriptions.ownerPersonId, personId), eq(subscriptions.kind, 'personal'), isNull(subscriptions.removedAt)));
  for (const plan of plans) await removeSubscription(ctx, plan);
  await removeAssistantAgent(ctx, personId, by);
}

export function peopleRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  const acceptAttempts = limiter();

  /* Finds an invite that can still be accepted, or explains why not. */
  async function openInvite(token: string) {
    const [row] = await db
      .select({ invite: invites, person: personColumns, companyName: companies.name })
      .from(invites)
      .innerJoin(people, eq(people.id, invites.personId))
      .innerJoin(companies, eq(companies.id, invites.companyId))
      .where(eq(invites.tokenHash, hashToken(token)));
    if (!row) throw notFound();
    if (row.invite.usedAt || row.invite.expiresAt <= new Date() || row.person.status !== 'invited') throw gone();
    return row;
  }

  app.get('/api/people', async req => {
    const me = await requirePerson(req, db);
    const rows = await db.select(personColumns).from(people).where(and(eq(people.companyId, me.companyId), isNull(people.removedAt))).orderBy(asc(people.createdAt));
    return { people: await personViews(db, rows) };
  });

  app.post('/api/people/invite', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const body = InviteBody.parse(req.body);
    await checkAccess(db, me.companyId, body.access);
    const token = newToken();

    let person;
    try {
      person = await db.transaction(async tx => {
        const [row] = await tx
          .insert(people)
          .values({ companyId: me.companyId, name: body.name, email: body.email, title: body.title, status: 'invited', scopeKind: 'whole' in body.access ? 'company' : 'listed' })
          .returning(personColumns);
        await saveAccess(tx, row!, body.access);
        await tx.insert(invites).values(inviteFor(token, me, row!.id));
        return row!;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError(409, 'conflict', 'Someone with this email is already in the company.', 'email_taken');
      throw err;
    }

    reply.code(201);
    return { person: await personView(db, person), inviteUrl: `${await publicUrl(db, config)}/invite/${token}` };
  });

  app.post('/api/people/:id/invite', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const { id } = IdParams.parse(req.params);
    const [target] = await db.select({ ...personColumns, isAgent: people.isAgent }).from(people).where(and(eq(people.id, id), eq(people.companyId, me.companyId), isNull(people.removedAt)));
    if (!target) throw new ApiError(404, 'not_found', 'This person does not exist.', 'person_unknown');
    if (target.isAgent) throw new ApiError(409, 'conflict', 'An assistant never signs in: it reaches the company with its key. Make a new key on its card.', 'assistant_no_sign_in');
    if (target.isOwner) throw new ApiError(403, 'forbidden', 'The owner cannot be sent a new invite.', 'owner_locked');
    if (target.id === me.id) throw new ApiError(403, 'forbidden', 'You cannot send a new invite to yourself.', 'self_locked');
    if (target.isCeoDelegate && !me.isOwner) throw delegateLocked();

    const { token, person } = await reinvite(db, id, me);
    ctx.bus.accessChanged(me.companyId);
    /* Who owns which decision follows who is active and what they reach. */
    ctx.bus.publish(me.companyId, { type: 'org' });
    reply.code(201);
    return { person: await personView(db, person), inviteUrl: `${await publicUrl(db, config)}/invite/${token}` };
  });

  app.get('/api/invites/:token', async req => {
    const { token } = TokenParams.parse(req.params);
    const { person, companyName } = await openInvite(token);
    const view = await personView(db, person);
    return { companyName, name: person.name, email: person.email, title: person.title, access: view.access };
  });

  app.post('/api/invites/:token/accept', async (req, reply) => {
    const { token } = TokenParams.parse(req.params);
    guard(reply, acceptAttempts, hashToken(token));
    const { password } = AcceptBody.parse(req.body);
    const { invite } = await openInvite(token);
    const passwordHash = await hashPassword(password);

    const person = await db.transaction(async tx => {
      const used = await tx
        .update(invites)
        .set({ usedAt: new Date() })
        .where(and(eq(invites.tokenHash, invite.tokenHash), isNull(invites.usedAt), gt(invites.expiresAt, new Date())))
        .returning({ personId: invites.personId });
      if (used.length === 0) throw gone();
      const [row] = await tx
        .update(people)
        .set({ passwordHash, status: 'active' })
        .where(and(eq(people.id, invite.personId), eq(people.status, 'invited')))
        .returning(personColumns);
      if (!row) throw gone();
      return row;
    });

    /* A new link sent meanwhile takes this password back. */
    if (!(await startSession(reply, db, config, person.id, passwordHash))) throw gone();
    ctx.bus.publish(person.companyId, { type: 'org' });
    return { person };
  });

  app.patch('/api/people/:id', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const body = PersonPatch.parse(req.body);
    const { telegram } = TelegramPatch.parse(req.body);
    /* Anyone may change their own name, title and Telegram; everything else needs the whole company. */
    if (id !== me.id || body.access !== undefined || body.status !== undefined) requireCompanyScope(me);

    const [target] = await db
      .select({ ...personColumns, passwordHash: people.passwordHash, telegramUsername: people.telegramUsername, telegramUserId: people.telegramUserId, isAgent: people.isAgent })
      .from(people)
      .where(and(eq(people.id, id), eq(people.companyId, me.companyId), isNull(people.removedAt)));
    if (!target) throw new ApiError(404, 'not_found', 'This person does not exist.', 'person_unknown');
    if (target.isAgent) guardAssistantPatch(body, telegram);
    if (telegram !== undefined) guardTelegram(me, target);
    guardRename(me, id, body);
    guardDisable(me, target, body);
    if (body.access && target.isOwner) throw new ApiError(403, 'forbidden', 'The owner always has access to the whole company.', 'owner_locked');
    guardDelegate(me, target, body);
    if (body.access) await checkAccess(db, me.companyId, body.access);

    const changes: Partial<typeof people.$inferInsert> = {};
    if (body.name !== undefined) changes.name = body.name;
    if (body.title !== undefined) changes.title = body.title;
    /* A person who never set a password goes back to waiting for their invite; an assistant never has one. */
    if (body.status) changes.status = body.status === 'active' && !target.passwordHash && !target.isAgent ? 'invited' : body.status;
    Object.assign(changes, markAfter(changes.status, body), telegramChange(telegram, target));
    const { status } = changes;
    /* Disabling has steps of its own, taken after whatever else this request changes. A person whose machine runs the
       company server is not disabled: the server moves first. */
    if (status === 'disabled') {
      delete changes.status;
      const theirs = await db.select(idOnly(machines)).from(machines).where(and(eq(machines.personId, id), isNull(machines.revokedAt)));
      await refuseLeader(db, config, theirs.map(m => m.id));
    }

    /* A person who no longer sees the whole company holds none of its data: their machines that hold a copy are cut from
       the server's changes first, before anything new is written, and give the data up in the same transaction. */
    const losesAll = target.scopeKind === 'company' && body.access !== undefined && !('whole' in body.access);
    const leaving = losesAll ? await leavingData(db, config, id) : [];
    await cutReplication(ctx.replication, leaving);

    const changed = await db.transaction(async tx => {
      if (Object.keys(changes).length) await tx.update(people).set(changes).where(eq(people.id, id));
      if (body.name !== undefined && body.name !== target.name) {
        await tx.insert(personChanges).values({ companyId: me.companyId, personId: id, actorId: me.id, field: 'name', before: target.name, after: body.name });
      }
      if (body.access) await saveAccess(tx, target, body.access);
      await leaveData(ctx, tx, leaving.map(machine => machine.id), new Date());
      const [row] = await tx.select(personColumns).from(people).where(eq(people.id, id));
      return row!;
    }).catch((err: unknown) => {
      if (isUniqueViolation(err)) throw new ApiError(409, 'conflict', 'Another person of the company has this Telegram already.', 'telegram_person_taken');
      throw err;
    });
    if (leaving.length > 0) void afterLeave(ctx);
    /* A disabled person's plans stop serving the company: their machines disconnect and the orchestrator lets go. */
    if (status === 'disabled') await disablePerson(ctx, id, me);
    else if (body.access) {
      await releasePlansOf(ctx, changed, me);
      await passResponsibility(ctx, me.companyId, id);
    }
    if (status === 'disabled' && target.isAgent) await releaseAssistantAgent(ctx, id, me);
    const person = status === 'disabled' ? (await db.select(personColumns).from(people).where(eq(people.id, id)))[0]! : changed;
    tellOfChange(ctx, me.companyId, Boolean(status || body.access), person.name !== target.name);
    return { person: await personView(db, person) };
  });

  /* The CEO deletes a person or an assistant for good, by himself or through the orchestrator: never himself, nor a person
     whose machine runs the company server, which moves first. */
  app.delete('/api/people/:id', async (req, reply) => {
    const me = await requirePerson(req, db);
    if (!me.isOwner) throw new ApiError(403, 'forbidden', 'Only the CEO deletes a person.', 'not_owner');
    const { id } = IdParams.parse(req.params);
    const [target] = await db.select(personColumns).from(people).where(and(eq(people.id, id), eq(people.companyId, me.companyId), isNull(people.removedAt)));
    if (!target) throw new ApiError(404, 'not_found', 'This person does not exist.', 'person_unknown');
    if (target.isOwner) throw new ApiError(403, 'forbidden', 'The owner cannot be deleted.', 'owner_locked');
    const theirs = await db.select(idOnly(machines)).from(machines).where(and(eq(machines.personId, id), isNull(machines.revokedAt)));
    await refuseLeader(db, config, theirs.map(m => m.id));
    await removePerson(ctx, id, me);
    ctx.bus.accessChanged(me.companyId);
    ctx.bus.publish(me.companyId, { type: 'org' });
    return reply.code(204).send();
  });

  /* The CEO marks the delegate, who then takes the CEO's decisions, and takes the mark off, by himself or through the
     orchestrator. The mark needs an active person with the whole company. */
  app.put('/api/people/:id/ceo-delegate', async req => {
    const me = await requirePerson(req, db);
    if (!me.isOwner) throw new ApiError(403, 'forbidden', 'Only the CEO marks the CEO delegate.', 'not_owner');
    const { id } = IdParams.parse(req.params);
    const { isCeoDelegate } = DelegateBody.parse(req.body);
    const target = await delegateTarget(db, me, id, isCeoDelegate);
    /* Set only while the person can still hold it, as they are when it is written. */
    const [person] = await db
      .update(people)
      .set({ isCeoDelegate })
      .where(and(eq(people.id, id), isCeoDelegate ? DELEGABLE : undefined))
      .returning(personColumns);
    if (!person) throw notDelegable();
    if (person.isCeoDelegate !== target.isCeoDelegate) {
      ctx.bus.accessChanged(me.companyId);
      ctx.bus.publish(me.companyId, { type: 'org' });
    }
    return { person: await personView(db, person) };
  });
}
