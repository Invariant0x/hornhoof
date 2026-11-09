import type { LightMyRequestResponse } from 'fastify';
import { eventually } from '../../../test-support/eventually.mjs';

export const TEST_SECRET = Buffer.alloc(32, 7).toString('base64');

export function sessionFrom(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find(c => c.name === 'hh_session');
  if (!cookie) throw new Error(`No session cookie in a ${res.statusCode} response.`);
  return cookie.value;
}

export const as = (token: string) => ({ cookies: { hh_session: token } });

/* Waits until check() is true, for state that changes after a socket message: it looks again after every turn of the
   event loop, with no clock and no deadline, so the machine's speed never decides a test. */
export const until = (check: () => Promise<boolean> | boolean): Promise<void> => eventually(check);
