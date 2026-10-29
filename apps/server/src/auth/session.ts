import type { FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { hashToken, newToken } from '../crypto/tokens.js';

export const SESSION_COOKIE = 'hh_session';
const SESSION_DAYS = 30;

export async function startSession(reply: FastifyReply, db: Db, config: Config, personId: string): Promise<void> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ tokenHash: hashToken(token), personId, expiresAt });
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.secureCookies,
    expires: expiresAt,
  });
}
