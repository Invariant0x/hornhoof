import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../app.js';
import { hashPassword } from '../../auth/password.js';
import { personColumns, requireCompanyScope, requirePerson, startSession, type Person } from '../../auth/session.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { isUniqueViolation } from '../../db/errors.js';
import { companies, invites, people, sessions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { personView, personViews, resolveScope, ScopeInput } from './views.js';

const INVITE_DAYS = 7;

const InviteBody = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  title: z.string().trim().max(80).default(''),
  scope: ScopeInput,
});

const AcceptBody = z.object({ password: z.string().min(10).max(200) });

const PatchBody = z.object({
  title: z.string().trim().max(80).optional(),
  scope: ScopeInput.optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const IdParams = z.object({ id: z.uuid() });
const TokenParams = z.object({ token: z.string().min(1).max(100) });

const inviteFor = (token: string, by: Person, personId: string) => ({
  tokenHash: hashToken(token),
  companyId: by.companyId,
  personId,
  createdBy: by.id,
  expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
});

const notFound = () => new ApiError(404, 'not_found', 'This invite does not exist.', 'invite_unknown');
const gone = () => new ApiError(410, 'gone', 'This invite has already been used or has expired. Ask for a new one.', 'invite_used');

export function peopleRoutes(app: FastifyInstance, { db, config }: Deps): void {
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
    const scope = await resolveScope(db, body.scope);
    const token = newToken();

    let person;
    try {
      person = await db.transaction(async tx => {
        const [row] = await tx
          .insert(people)
          .values({ companyId: me.companyId, name: body.name, email: body.email, title: body.title, status: 'invited', ...scope })
          .returning(personColumns);
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

  /* A fresh link for someone already in the company. It doubles as a password reset, so old access ends here. */
  app.post('/api/people/:id/invite', async (req, reply) => {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const { id } = IdParams.parse(req.params);
    const [target] = await db.select(personColumns).from(people).where(eq(people.id, id));
    if (!target) throw new ApiError(404, 'not_found', 'This person does not exist.', 'person_unknown');
    if (target.isOwner) throw new ApiError(403, 'forbidden', 'The owner cannot be sent a new invite.', 'owner_locked');
    if (target.id === me.id) throw new ApiError(403, 'forbidden', 'You cannot send a new invite to yourself.', 'self_locked');

    const token = newToken();
    const person = await db.transaction(async tx => {
      await tx.update(invites).set({ usedAt: new Date() }).where(and(eq(invites.personId, id), isNull(invites.usedAt)));
      await tx.delete(sessions).where(eq(sessions.personId, id));
      const [row] = await tx.update(people).set({ status: 'invited', passwordHash: null }).where(eq(people.id, id)).returning(personColumns);
      await tx.insert(invites).values(inviteFor(token, me, id));
      return row!;
    });

    reply.code(201);
    return { person: await personView(db, person), inviteUrl: `${config.publicUrl}/invite/${token}` };
  });

  app.get('/api/invites/:token', async req => {
    const { token } = TokenParams.parse(req.params);
    const { person, companyName } = await openInvite(token);
    const view = await personView(db, person);
    return { companyName, name: person.name, email: person.email, title: person.title, scopeName: view.scope.name, scopeKind: view.scope.kind };
  });

  app.post('/api/invites/:token/accept', async (req, reply) => {
    const { token } = TokenParams.parse(req.params);
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
    requireCompanyScope(me);
    const { id } = IdParams.parse(req.params);
    const body = PatchBody.parse(req.body);

    const [target] = await db.select({ ...personColumns, passwordHash: people.passwordHash }).from(people).where(eq(people.id, id));
    if (!target) throw new ApiError(404, 'not_found', 'This person does not exist.', 'person_unknown');
    if (body.status === 'disabled' && (target.isOwner || target.id === me.id)) {
      throw new ApiError(403, 'forbidden', target.isOwner ? 'The owner cannot be disabled.' : 'You cannot disable yourself.', target.isOwner ? 'owner_locked' : 'self_locked');
    }
    if (body.scope && target.isOwner) throw new ApiError(403, 'forbidden', 'The owner always has access to the whole company.', 'owner_locked');

    const changes: Partial<typeof people.$inferInsert> = {};
    if (body.title !== undefined) changes.title = body.title;
    if (body.scope) Object.assign(changes, await resolveScope(db, body.scope));
    /* A person who never set a password goes back to waiting for their invite. */
    if (body.status) changes.status = body.status === 'active' && !target.passwordHash ? 'invited' : body.status;

    const person = await db.transaction(async tx => {
      const [row] = Object.keys(changes).length
        ? await tx.update(people).set(changes).where(eq(people.id, id)).returning(personColumns)
        : [target];
      if (changes.status === 'disabled') await tx.delete(sessions).where(eq(sessions.personId, id));
      return row!;
    });
    return { person: await personView(db, person) };
  });
}
