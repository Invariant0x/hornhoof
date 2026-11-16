import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { refuse } from '../../auth/limit.js';
import { verifyPassword } from '../../auth/password.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { signInTry, signInWorked } from '../../auth/sign-in-limit.js';
import { clientAddress } from '../../auth/tunnel.js';
import { isUniqueViolation } from '../../db/errors.js';
import { people, personKeys } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { isP256, KEY_ITERATIONS } from './owner-key.js';

const Part = z.string().min(1).max(4096);
const KeyBody = z.object({
  password: z.string().min(1).max(200),
  publicKey: Part.refine(isP256),
  wrapped: Part,
  salt: Part,
  iv: Part,
  /* No more than its column holds. */
  iterations: z.number().int().min(KEY_ITERATIONS).max(2_147_483_647),
});

const wrongPassword = () => new ApiError(401, 'unauthorized', 'Wrong email or password.', 'wrong_password');
const keyExists = () => new ApiError(409, 'conflict', 'You have a key already.', 'key_exists');

/* Each person's own key. Their browser makes it and wraps its private half with a key made from their password, which
   the server never keeps: so the server holds the public half, and the private half only in a form it cannot open. A
   machine pins the public half from the command its owner ran there, and only what that key signs opens the machine. */
export function keyRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  /* A person's own session, or the orchestrator acting for the CEO, who types the password as a person does: never a head. */
  const ownSession = async (req: FastifyRequest): Promise<Person> => {
    const me = await requirePerson(req, db);
    if (me.viaHead) throw new ApiError(403, 'forbidden', 'Only the person themselves may do this.');
    return me;
  };

  app.get('/api/me/key', async req => {
    const me = await ownSession(req);
    const [key] = await db
      .select({ publicKey: personKeys.publicKey, wrapped: personKeys.wrapped, salt: personKeys.salt, iv: personKeys.iv, iterations: personKeys.iterations })
      .from(personKeys)
      .where(eq(personKeys.personId, me.id));
    return { key: key ?? null };
  });

  /* The password is checked as a sign-in checks it, and counted with the sign-ins: it is the same guess. A key is made
     once: a second one would leave the person's machines with a pin nobody holds the key of. */
  app.put('/api/me/key', async (req: FastifyRequest, reply: FastifyReply) => {
    const me = await ownSession(req);
    const { password, ...key } = KeyBody.parse(req.body);
    /* A person's assistant has no email and no password, so none to check. */
    if (me.email === null) throw wrongPassword();
    const attempt = await signInTry(db, me.email, await clientAddress(req, config));
    if (!attempt.allowed) refuse(reply, attempt.retryAfterS, attempt.windowMs);
    const [row] = await db.select({ passwordHash: people.passwordHash }).from(people).where(eq(people.id, me.id));
    if (!row?.passwordHash || !(await verifyPassword(password, row.passwordHash))) throw wrongPassword();
    await signInWorked(db, attempt.id);
    try {
      await db.insert(personKeys).values({ personId: me.id, companyId: me.companyId, ...key });
    } catch (err) {
      if (isUniqueViolation(err)) throw keyExists();
      throw err;
    }
    /* Their machines hold this key or do not: the screens load each machine's access again. */
    ctx.bus.publish(me.companyId, { type: 'computer' });
    return reply.code(204).send();
  });
}
