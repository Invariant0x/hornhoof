import type { LightMyRequestResponse } from 'fastify';

export const TEST_SECRET = Buffer.alloc(32, 7).toString('base64');

export function sessionFrom(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find(c => c.name === 'hh_session');
  if (!cookie) throw new Error(`No session cookie in a ${res.statusCode} response.`);
  return cookie.value;
}

export const as = (token: string) => ({ cookies: { hh_session: token } });

/* Waits until check() is true, for state that changes after a socket message. The deadline is for a machine busy with
   other tests: a check that comes true ends the wait at once, whatever the deadline. */
export async function until(check: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out waiting.');
    await new Promise(r => setTimeout(r, 15));
  }
}
