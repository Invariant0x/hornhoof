import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { limiter, refuse } from '../../auth/limit.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { endReading, endSession, personColumns, requirePerson, startReading, startSession } from '../../auth/session.js';
import { addressKey, SIGN_IN_LIMITS, signInTry, signInWorked } from '../../auth/sign-in-limit.js';
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

export function authRoutes(app: FastifyInstance, { db, config, bus, mode }: Ctx): void {
  /* Where nothing can be written, the same three limits are counted in memory. */
  const tries = { emailAddress: limiter(SIGN_IN_LIMITS.emailAddress), email: limiter(SIGN_IN_LIMITS.email), address: limiter(SIGN_IN_LIMITS.address) };

  /* A sign-in on a machine that only reads: the password is checked against what the machine reads, and the person
     gets a cookie that says who signed in, and no session. */
  async function signInReading(req: FastifyRequest, reply: FastifyReply, body: z.infer<typeof LoginBody>) {
    const address = addressKey(await clientAddress(req, config));
    const keys = { emailAddress: `${body.email} ${address}`, email: body.email, address };
    const counted = (Object.keys(tries) as (keyof typeof tries)[]).map(name => ({ name, said: tries[name](keys[name]) }));
    const full = counted.filter(count => !count.said.allowed);
    if (full.length) {
      /* A try that one limit refused is none: the others give theirs back. */
      for (const count of counted) if (count.said.allowed) tries[count.name].forget(keys[count.name]);
      const longest = full.reduce((a, b) => (b.said.retryAfterS > a.said.retryAfterS ? b : a));
      refuse(reply, longest.said.retryAfterS, tries[longest.name].windowMs);
    }
    const [row] = await db.select({ ...personColumns, passwordHash: people.passwordHash }).from(people).where(eq(people.email, body.email));
    const ok = await verifyPassword(body.password, row?.passwordHash ?? (await fallbackHash()));
    if (!row?.passwordHash || !ok || row.status !== 'active') throw wrongPassword();
    for (const count of counted) tries[count.name].forget(keys[count.name]);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- omit passwordHash from the returned person
    const { passwordHash: _, ...person } = row;
    startReading(reply, config, person.id, row.passwordHash);
    return { person };
  }

  app.post('/api/auth/login', async (req, reply) => {
    const body = LoginBody.parse(req.body);
    if (mode.current() !== 'lead') return signInReading(req, reply, body);
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
    if (mode.current() !== 'lead') {
      endReading(req, reply);
      return reply.code(204).send();
    }
    const me = await requirePerson(req, db).catch(() => null);
    await endSession(req, reply, db);
    /* What the person still has open closes now, not at its next look. */
    if (me) bus.accessChanged(me.companyId);
    reply.code(204).send();
  });

  app.get('/api/me', async req => {
    const person = await requirePerson(req, db);
    const [company] = await db
      .select({ id: companies.id, name: companies.name, theme: companies.theme })
      .from(companies)
      .where(eq(companies.id, person.companyId));
    /* Whether the cards only the CEO and the delegate decide show their buttons to this person. */
    return { person, company, canDecideCompany: actsAsCeo(person) };
  });
}
