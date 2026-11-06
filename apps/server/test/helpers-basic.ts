import type { LightMyRequestResponse } from 'fastify';

export const TEST_SECRET = Buffer.alloc(32, 7).toString('base64');

export function sessionFrom(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find(c => c.name === 'hh_session');
  if (!cookie) throw new Error(`No session cookie in a ${res.statusCode} response.`);
  return cookie.value;
}

export const as = (token: string) => ({ cookies: { hh_session: token } });

/* Waits until check() is true, for state that changes after a socket message. */
export async function until(check: () => Promise<boolean> | boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out waiting.');
    await new Promise(r => setTimeout(r, 15));
  }
}
