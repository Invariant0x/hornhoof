import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { AccessInput, accessOf, agentSpot, canReach, checkAccess, saveAccess } from '../../auth/access.js';
import { guard, limiter } from '../../auth/limit.js';
import { hashPassword } from '../../auth/password.js';
import { changedBy, personColumns, requireCompanyScope, requirePerson, startSession, type Person } from '../../auth/session.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import type { Db } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import { agentChanges, agents, companies, invites, machines, people, sessions, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { onAgent } from '../conversation/queue.js';
import { disconnectMachines } from '../nodes/disconnect.js';
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
  title: z.string().trim().max(80).optional(),
  access: AccessInput.optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

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

/* A fresh link for someone already in the company. It doubles as a password reset, so old access ends here. */
export async function reinvite(db: Db, personId: string, by: Pick<Person, 'id' | 'companyId'>): Promise<{ token: string; person: Person }> {
  const token = newToken();
  const person = await db.transaction(async tx => {
    await tx.update(invites).set({ usedAt: new Date() }).where(and(eq(invites.personId, personId), isNull(invites.usedAt)));
    await tx.delete(sessions).where(eq(sessions.personId, personId));
    const [row] = await tx.update(people).set({ status: 'invited', passwordHash: null }).where(eq(people.id, personId)).returning(personColumns);
    await tx.insert(invites).values(inviteFor(token, by, personId));
    return row!;
  });
  return { token, person };
}

/* A personal plan serves where its owner works. When the owner is disabled or no longer reaches an agent's place, the agent
   lets go of the plan and waits for another; the orchestrator is company-wide, so it needs an owner with the whole company. */
async function releasePlansOf(ctx: Ctx, owner: Pick<Person, 'id' | 'companyId' | 'scopeKind' | 'status'>, by: Person): Promise<void> {
  const { db } = ctx;
  const theirs = (await db.select({ id: subscriptions.id }).from(subscriptions).where(and(eq(subscriptions.ownerPersonId, owner.id), eq(subscriptions.kind, 'personal')))).map(s => s.id);
  if (!theirs.length) return;
  const bound = await db.select({ id: agents.id }).from(agents).where(and(inArray(agents.subscriptionId, theirs), isNull(agents.removedAt)));
  const access = await accessOf(db, owner);
  let freed = false;
  for (const { id } of bound) {
    /* In the agent's line, so a card change that read the plan cannot put it back. */
    await onAgent(ctx, id, async () => {
      const [agent] = await db.select().from(agents).where(eq(agents.id, id));
      if (!agent?.subscriptionId || !theirs.includes(agent.subscriptionId)) return;
      const stays = owner.status !== 'disabled' && (agent.kind === 'orchestrator' ? access.whole : canReach(access, await agentSpot(db, agent)));
      if (stays) return;
      await db.transaction(async tx => {
        await tx.update(agents).set({ subscriptionId: null }).where(eq(agents.id, id));
        await tx.insert(agentChanges).values({ companyId: agent.companyId, agentId: id, ...changedBy(by), field: 'subscription', before: agent.subscriptionId, after: null });
      });
      freed = true;
    });
  }
  if (freed) ctx.bus.publish(owner.companyId, { type: 'org' });
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
    await requirePerson(req, db);
    const rows = await db.select(personColumns).from(people).orderBy(asc(people.createdAt));
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
    return { person: await personView(db, person), inviteUrl: `${config.publicUrl}/invite/${token}` };
  });

  app.post('/api/people/:id/invite', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const { id } = IdParams.parse(req.params);
    const [target] = await db.select(personColumns).from(people).where(eq(people.id, id));
    if (!target) throw new ApiError(404, 'not_found', 'This person does not exist.', 'person_unknown');
    if (target.isOwner) throw new ApiError(403, 'forbidden', 'The owner cannot be sent a new invite.', 'owner_locked');
    if (target.id === me.id) throw new ApiError(403, 'forbidden', 'You cannot send a new invite to yourself.', 'self_locked');

    const { token, person } = await reinvite(db, id, me);
    ctx.bus.accessChanged(me.companyId);
    reply.code(201);
    return { person: await personView(db, person), inviteUrl: `${config.publicUrl}/invite/${token}` };
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

    await startSession(reply, db, config, person.id);
    return { person };
  });

  app.patch('/api/people/:id', async req => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const body = PersonPatch.parse(req.body);
    /* Anyone may rename their own title; everything else needs the whole company. */
    if (id !== me.id || body.access !== undefined || body.status !== undefined) requireCompanyScope(me);

    const [target] = await db.select({ ...personColumns, passwordHash: people.passwordHash }).from(people).where(eq(people.id, id));
    if (!target) throw new ApiError(404, 'not_found', 'This person does not exist.', 'person_unknown');
    if (body.status === 'disabled' && (target.isOwner || target.id === me.id)) {
      throw new ApiError(403, 'forbidden', target.isOwner ? 'The owner cannot be disabled.' : 'You cannot disable yourself.', target.isOwner ? 'owner_locked' : 'self_locked');
    }
    if (body.access && target.isOwner) throw new ApiError(403, 'forbidden', 'The owner always has access to the whole company.', 'owner_locked');
    if (body.access) await checkAccess(db, me.companyId, body.access);

    const changes: Partial<typeof people.$inferInsert> = {};
    if (body.title !== undefined) changes.title = body.title;
    /* A person who never set a password goes back to waiting for their invite. */
    if (body.status) changes.status = body.status === 'active' && !target.passwordHash ? 'invited' : body.status;

    const person = await db.transaction(async tx => {
      if (Object.keys(changes).length) await tx.update(people).set(changes).where(eq(people.id, id));
      if (body.access) await saveAccess(tx, target, body.access);
      if (changes.status === 'disabled') await tx.delete(sessions).where(eq(sessions.personId, id));
      const [row] = await tx.select(personColumns).from(people).where(eq(people.id, id));
      return row!;
    });
    /* A disabled person's plans stop serving the company: their machines disconnect and the orchestrator lets go. */
    if (changes.status === 'disabled') {
      const theirs = await db.select({ id: machines.id }).from(machines).where(and(eq(machines.personId, id), isNull(machines.revokedAt)));
      await disconnectMachines(ctx, theirs.map(m => m.id));
    }
    if (changes.status === 'disabled' || body.access) await releasePlansOf(ctx, person, me);
    if (changes.status || body.access) ctx.bus.accessChanged(me.companyId);
    return { person: await personView(db, person) };
  });
}
