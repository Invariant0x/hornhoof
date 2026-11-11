import { and, eq, gt, lte } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { people, sessions, type ScopeKind } from '../db/schema.js';
import { hashToken, newToken } from '../crypto/tokens.js';
import { ApiError } from '../errors.js';
import { internalCall } from './internal.js';
import { cameOverHttps } from './tunnel.js';

export const SESSION_COOKIE = 'hh_session';
const SESSION_DAYS = 30;

export const personColumns = {
  id: people.id,
  companyId: people.companyId,
  name: people.name,
  email: people.email,
  title: people.title,
  status: people.status,
  scopeKind: people.scopeKind,
  isOwner: people.isOwner,
  isCeoDelegate: people.isCeoDelegate,
};

export type Person = {
  id: string;
  companyId: string;
  name: string;
  email: string | null;
  title: string;
  status: 'active' | 'invited' | 'disabled';
  scopeKind: ScopeKind;
  isOwner: boolean;
  isCeoDelegate: boolean;
  /* The orchestrator acting as this person, the owner: what it changes is its own. */
  via?: string;
  /* The orchestrator takes a decision for this person, whom its turn answers: the turn and the message that says so. */
  decision?: { jobId: string; sourceSeq: number | null };
};

/* Every sign-in also clears out everyone's expired sessions, so the table does not grow forever. A session starts only
   for the password the caller just checked or set, with the person's row locked until it is in: a reset or a disable
   running at the same time either comes first and is seen here, or waits and then deletes the new session. The cookie
   goes only over https when Hornhoof's address is https, or when the person came over https through the tunnel. */
export async function startSession(reply: FastifyReply, db: Db, config: Config, personId: string, passwordHash: string): Promise<boolean> {
  await db.delete(sessions).where(lte(sessions.expiresAt, new Date()));
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const started = await db.transaction(async tx => {
    const [still] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, personId), eq(people.passwordHash, passwordHash), eq(people.status, 'active')))
      .for('share');
    if (!still) return false;
    await tx.insert(sessions).values({ tokenHash: hashToken(token), personId, expiresAt });
    return true;
  });
  if (!started) return false;
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.secureCookies || (await cameOverHttps(reply.request, config)),
    expires: expiresAt,
  });
  return true;
}

export async function endSession(req: FastifyRequest, reply: FastifyReply, db: Db): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

const notSignedIn = () => new ApiError(401, 'unauthorized', 'Sign in to continue.', 'signed_out');

/* The person who did it, or null when the orchestrator did it for the owner. */
export const personOf = (me: Person): string | null => (me.via ? null : me.id);

/* Who a change is by: the person, or the orchestrator when it acts for the owner. */
export const changedBy = (me: Person) => ({ personId: personOf(me), byOrchestrator: !!me.via });

/* Who acts on a task: the person, or the orchestrator when it acts for the owner. */
export const actorOf = (me: Person): { personId: string } | { agentId: string } => (me.via ? { agentId: me.via } : { personId: me.id });

export async function requirePerson(req: FastifyRequest, db: Db): Promise<Person> {
  const inside = internalCall(req);
  if (inside) {
    const [owner] = await db.select(personColumns).from(people).where(eq(people.id, inside.personId));
    if (!owner || owner.status !== 'active') throw notSignedIn();
    return { ...owner, via: inside.agentId, ...(inside.decision ? { decision: inside.decision } : {}) };
  }
  const token = req.cookies[SESSION_COOKIE];
  if (!token) throw notSignedIn();
  const [person] = await db
    .select(personColumns)
    .from(sessions)
    .innerJoin(people, eq(people.id, sessions.personId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
  if (!person || person.status !== 'active') throw notSignedIn();
  return person;
}

export function requireCompanyScope(person: Person): void {
  if (person.scopeKind !== 'company') throw new ApiError(403, 'forbidden', 'Only people with access to the whole company can do this.', 'company_scope_only');
}

/* A signed-in person who sees the whole company. */
export async function requireCompanyPerson(req: FastifyRequest, db: Db): Promise<Person> {
  const me = await requirePerson(req, db);
  requireCompanyScope(me);
  return me;
}
