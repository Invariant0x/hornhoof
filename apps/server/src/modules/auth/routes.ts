import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { refuse } from '../../auth/limit.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { endSession, personColumns, requirePerson, startSession } from '../../auth/session.js';
import { signInTry, signInWorked } from '../../auth/sign-in-limit.js';
import { clientAddress } from '../../auth/tunnel.js';
import { companies, people } from '../../db/schema.js';
import { ApiError } from '../../errors.js';

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().min(1).max(320),
  password: z.string().min(1).max(200),
});

/* Unknown emails still pay for one hash check, so response time does not reveal who has an account. */
let dummyHash: Promise<string> | undefined;
const fallbackHash = () => (dummyHash ??= hashPassword('hornhoof-no-such-person'));

const wrongPassword = () => new ApiError(401, 'unauthorized', 'Wrong email or password.', 'wrong_password');

export function authRoutes(app: FastifyInstance, { db, config, bus }: Ctx): void {
  app.post('/api/auth/login', async (req, reply) => {
    const body = LoginBody.parse(req.body);
    /* Counted in the database per email and address, per email and per address, so whoever knows the owner's email
       cannot lock the owner out from elsewhere, and many addresses cannot guess one password freely. */
    const attempt = await signInTry(db, body.email, await clientAddress(req, config));
    if (!attempt.allowed) refuse(reply, attempt.retryAfterS, attempt.windowMs);
    const [row] = await db.select({ ...personColumns, passwordHash: people.passwordHash }).from(people).where(eq(people.email, body.email));
    const ok = await verifyPassword(body.password, row?.passwordHash ?? (await fallbackHash()));
    if (!row?.passwordHash || !ok || row.status !== 'active') throw wrongPassword();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omit passwordHash from the returned person
    const { passwordHash: _, ...person } = row;
    /* An owner link or a disable that lands during the check above makes this password an old one. */
    if (!(await startSession(reply, db, config, person.id, row.passwordHash))) throw wrongPassword();
    await signInWorked(db, attempt.id);
    return { person };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const me = await requirePerson(req, db).catch(() => null);
    await endSession(req, reply, db);
    /* What the person still has open closes now, not at its next look. */
    if (me) bus.accessChanged(me.companyId);
    reply.code(204).send();
  });

  app.get('/api/me', async req => {
    const person = await requirePerson(req, db);
    const [company] = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, person.companyId));
    /* Whether the cards only the CEO and the delegate decide show their buttons to this person. */
    return { person, company, canDecideCompany: actsAsCeo(person) };
  });
}
