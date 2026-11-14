import type { LightMyRequestResponse } from 'fastify';
import { eventually } from '../../../test-support/eventually.mjs';
import { LINK_SESSION_COOKIE } from '../src/auth/session.js';

export const TEST_SECRET = Buffer.alloc(32, 7).toString('base64');

/* The session a response set, under the cookie of the local address or of the public link. */
export function sessionFrom(res: LightMyRequestResponse): string {
  const [value] = res.cookies.filter(c => c.name === 'hh_session' || c.name === LINK_SESSION_COOKIE).map(c => c.value).filter(Boolean);
  if (!value) throw new Error(`No session cookie in a ${res.statusCode} response.`);
  return value;
}

export const as = (token: string) => ({ cookies: { hh_session: token } });

/* Waits until check() is true, for state that changes after a socket message: it looks again after every turn of the
   event loop, with no clock and no deadline, so the machine's speed never decides a test. */
export const until = (check: () => Promise<boolean> | boolean): Promise<void> => eventually(check);
