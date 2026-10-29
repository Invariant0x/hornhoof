import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../app.js';
import { guard, limiter } from '../../auth/limit.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { endSession, personColumns, requirePerson, startSession } from '../../auth/session.js';
import { companies, people } from '../../db/schema.js';
import { ApiError } from '../../errors.js';

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().min(1).max(320),
  password: z.string().min(1).max(200),
});

/* Unknown emails still pay for one hash check, so response time does not reveal who has an account. */
let dummyHash: Promise<string> | undefined;
const fallbackHash = () => (dummyHash ??= hashPassword('hornhoof-no-such-person'));

export function authRoutes(app: FastifyInstance, { db, config }: Deps): void {
  const attempts = limiter();

  app.post('/api/auth/login', async (req, reply) => {
    const body = LoginBody.parse(req.body);
    guard(reply, attempts, body.email);
    const [row] = await db.select({ ...personColumns, passwordHash: people.passwordHash }).from(people).where(eq(people.email, body.email));
    const ok = await verifyPassword(body.password, row?.passwordHash ?? (await fallbackHash()));
    if (!row || !ok || row.status !== 'active') throw new ApiError(401, 'unauthorized', 'Wrong email or password.', 'wrong_password');

    const { passwordHash: _, ...person } = row;
    await startSession(reply, db, config, person.id);
    return { person };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await endSession(req, reply, db);
    reply.code(204).send();
  });

  app.get('/api/me', async req => {
    const person = await requirePerson(req, db);
    const [company] = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, person.companyId));
    return { person, company };
  });
}
