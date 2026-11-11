import { createHmac } from 'node:crypto';
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { fastifyCookie } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { people, sessions, type ScopeKind } from '../db/schema.js';
import { hashToken, newToken } from '../crypto/tokens.js';
import { ApiError } from '../errors.js';
import { internalCall } from './internal.js';

export const SESSION_COOKIE = 'hh_session';
/* A browser takes a __Host- cookie only when it is secure, has path / and no domain, so a page on another company's name
   under hornhoof.org cannot set it. */
export const LINK_SESSION_COOKIE = '__Host-hh_session';
export const sessionCookieOf = (req: FastifyRequest): string => (req.overLink ? LINK_SESSION_COOKIE : SESSION_COOKIE);
const SESSION_DAYS = 30;
const HANDOVER_GRACE_SECONDS = 60;

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
  /* The person's own assistant acting for them with its key, under their rights as they are now: what it does is recorded as
     done by it for them. */
  assistant?: { id: string; name: string };
};

/* The expiry a browser takes for a __Host- cookie it must drop needs the same attributes as the cookie had. */
const clearingOptions = (req: FastifyRequest) => (req.overLink ? { path: '/', secure: true } : { path: '/' });

const sessionCookieOptions = (req: FastifyRequest, config: Config, expires: Date) =>
  ({ httpOnly: true, sameSite: 'lax', path: '/', secure: config.secureCookies || req.overLink, expires }) as const;

function setSessionCookie(reply: FastifyReply, config: Config, token: string, expires: Date): void {
  reply.setCookie(sessionCookieOf(reply.request), token, sessionCookieOptions(reply.request, config, expires));
}

/* The sessions a hand-over made and ended in this request: the new token, and the older one it replaced. A request that
   decides the session cookie itself, a sign-in, an invite or a sign-out, takes these back, so it sends one cookie of its
   own and leaves no session behind for the person of the older cookie. */
const handedOver = new WeakMap<FastifyRequest, { from: string; to: string }>();

async function dropSessions(db: Db, tokens: (string | undefined)[]): Promise<void> {
  const hashes = tokens.filter((t): t is string => !!t).map(hashToken);
  if (hashes.length) await db.delete(sessions).where(inArray(sessions.tokenHash, hashes));
}

const newSessionExpiry = () => new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

/* Every sign-in also clears out everyone's expired sessions, so the table does not grow forever. A session starts only
   for the password the caller just checked or set, with the person's row locked until it is in: a reset or a disable
   running at the same time either comes first and is seen here, or waits and then deletes the new session. The cookie
   goes only over https when Hornhoof's address is https, or when the person came over the public link, where it is the
   __Host- one. */
export async function startSession(reply: FastifyReply, db: Db, config: Config, personId: string, passwordHash: string): Promise<boolean> {
  await db.delete(sessions).where(lte(sessions.expiresAt, new Date()));
  const token = newToken();
  const expiresAt = newSessionExpiry();
  const started = await db.transaction(async tx => {
    const [still] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, personId), eq(people.passwordHash, passwordHash), eq(people.status, 'active')))
      .for('share');
    if (!still) return false;
    await tx.insert(sessions).values({ tokenHash: hashToken(token), personId, expiresAt, beforeHostCookie: false });
    return true;
  });
  if (!started) return false;
  await dropSessions(db, [handedOver.get(reply.request)?.to]);
  setSessionCookie(reply, config, token, expiresAt);
  return true;
}

export async function endSession(req: FastifyRequest, reply: FastifyReply, db: Db): Promise<void> {
  await dropSessions(db, [req.cookies[sessionCookieOf(req)], handedOver.get(req)?.from]);
  reply.clearCookie(sessionCookieOf(req), clearingOptions(req));
}

/* Moves a session made before the switch to the link's cookie: the person gets a new session under __Host-hh_session and
   the old one lives one more minute for requests already on their way. Only a session marked as older, unexpired and of
   an active person is moved, since a plain hh_session cookie on the link could have been set by a page on another
   company's name. */
async function moveOlderSession(db: Db, config: Config, oldToken: string): Promise<{ token: string; expiresAt: Date } | null> {
  const oldHash = hashToken(oldToken);
  return db.transaction(async tx => {
    const [owner] = await tx.select({ personId: sessions.personId }).from(sessions).where(eq(sessions.tokenHash, oldHash));
    if (!owner) return null;
    /* The person's row first and then the session's, the order a reset or a disable takes, so a reset running at the same
       time either comes first and is seen here, or waits and then deletes the new session too. */
    const [person] = await tx.select({ id: people.id }).from(people).where(and(eq(people.id, owner.personId), eq(people.status, 'active'))).for('share');
    if (!person) return null;
    const [older] = await tx
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, oldHash), eq(sessions.beforeHostCookie, true), gt(sessions.expiresAt, new Date())))
      .for('update');
    if (!older) return null;
    await tx
      .update(sessions)
      .set({ expiresAt: sql`least(${sessions.expiresAt}, now() + ${`${HANDOVER_GRACE_SECONDS} seconds`}::interval)` })
      .where(eq(sessions.tokenHash, oldHash));
    /* A page asks for many things at once, each with the old cookie, and every one of them gets here within the minute
       the old session still lives. They all get the same new session, so none is left that no browser holds. */
    const token = movedToken(config, oldToken);
    const tokenHash = hashToken(token);
    await tx.insert(sessions).values({ tokenHash, personId: person.id, expiresAt: newSessionExpiry(), beforeHostCookie: false }).onConflictDoNothing();
    const [moved] = await tx.select({ expiresAt: sessions.expiresAt }).from(sessions).where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.personId, person.id)));
    return moved ? { token, expiresAt: moved.expiresAt } : null;
  });
}

/* The token of the session an older one moves to: the same for every request that brings that older token, and worked out
   by nobody who does not hold this server's secret. */
const movedToken = (config: Config, oldToken: string): string => createHmac('sha256', config.secret).update(`hornhoof session hand-over ${oldToken}`).digest('base64url');

const needsHandOver = (req: FastifyRequest): boolean =>
  req.overLink && !!req.cookies[SESSION_COOKIE] && !req.cookies[LINK_SESSION_COOKIE] && !req.headers.upgrade;

/* A route that hijacks the reply never sends through the cookie plugin, which writes the cookies when the reply is sent,
   and would lose them. So when a route hijacks, the hand-over's cookies are put into the raw response first; a later
   writeHead keeps them unless it names set-cookie itself. One place, so no route has to remember. */
function deliverIfHijacked(reply: FastifyReply, cookies: string[]): void {
  const hijack = reply.hijack.bind(reply);
  reply.hijack = () => {
    reply.raw.setHeader('set-cookie', cookies);
    return hijack();
  };
}

const CLEARED_OLD_COOKIE = { path: '/', secure: true } as const;

/* Runs for every request over the link, so a person signed in before the switch stays signed in. Either way the plain
   hh_session cookie is cleared, and nothing else reads it over the link. The cookies go through the cookie plugin like
   any others, so a route that sets the same one itself replaces the hand-over's. */
export async function handOverSession(req: FastifyRequest, reply: FastifyReply, db: Db, config: Config): Promise<void> {
  if (!needsHandOver(req)) return;
  const older = req.cookies[SESSION_COOKIE]!;
  const moved = await moveOlderSession(db, config, older);
  reply.clearCookie(SESSION_COOKIE, CLEARED_OLD_COOKIE);
  const cookies = [fastifyCookie.serialize(SESSION_COOKIE, '', { ...CLEARED_OLD_COOKIE, expires: new Date(0) })];
  if (moved) {
    setSessionCookie(reply, config, moved.token, moved.expiresAt);
    cookies.push(fastifyCookie.serialize(LINK_SESSION_COOKIE, moved.token, sessionCookieOptions(req, config, moved.expiresAt)));
    handedOver.set(req, { from: older, to: moved.token });
    req.cookies[LINK_SESSION_COOKIE] = moved.token;
  }
  deliverIfHijacked(reply, cookies);
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
  const token = req.cookies[sessionCookieOf(req)];
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
