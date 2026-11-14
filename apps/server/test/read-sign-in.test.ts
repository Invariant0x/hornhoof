import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.js';
import { people, sessions, signInAttempts } from '../src/db/schema.js';
import { writeKeeperState, type Mode } from '../src/modules/keeper/state.js';
import { SETUP, setUpCompany, testApp, until } from './helpers.js';

const cookieOf = (res: LightMyRequestResponse, name: string) => res.cookies.find(cookie => cookie.name === name);
const login = (app: FastifyInstance, password = SETUP.password, email = SETUP.email) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

/* A company whose app runs behind a keeper the test speaks for: it leads first, so the company can be set up, and
   reads from then on. */
async function reading() {
  const dir = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const made = await testApp({ HORNHOOF_KEEPER: 'on', HORNHOOF_CONTROL_DIR: dir });
  const modeNow = async () => (await made.app.inject({ url: '/api/health' })).json().mode;
  const say = async (mode: Mode) => {
    writeKeeperState(dir, { mode, at: new Date().toISOString(), link: null });
    await until(async () => (await modeNow()) === mode);
  };
  await say('lead');
  await setUpCompany(made.app);
  const [owner] = await made.db.select().from(people).where(eq(people.isOwner, true));
  await say('read');
  const me = (cookies: Record<string, string>) => made.app.inject({ url: '/api/me', cookies });
  return { ...made, dir, say, owner: owner!, me };
}

describe('signing in on a machine that only reads', () => {
  it('signs in with a read cookie and no session row', async () => {
    const s = await reading();
    const before = await s.db.select().from(sessions);
    const signed = await login(s.app);
    expect(signed.statusCode).toBe(200);
    expect(signed.json().person).toMatchObject({ id: s.owner.id });
    const read = cookieOf(signed, 'hh_read');
    expect(read).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 43_200 });
    expect(cookieOf(signed, 'hh_session')).toBeUndefined();
    expect(await s.db.select().from(sessions)).toEqual(before);
    const seen = await s.me({ hh_read: read!.value });
    expect([seen.statusCode, seen.json().person.id]).toEqual([200, s.owner.id]);
    expect((await s.me({ hh_read: `${read!.value}x` })).statusCode).toBe(401);
    /* Once this machine leads, the same cookie is traded once for a session, and goes. */
    await s.say('lead');
    const traded = await s.me({ hh_read: read!.value });
    expect([traded.statusCode, traded.json().person.id]).toEqual([200, s.owner.id]);
    const session = cookieOf(traded, 'hh_session');
    expect(session?.value).toBeTruthy();
    expect(cookieOf(traded, 'hh_read')).toMatchObject({ value: '' });
    expect((await s.me({ hh_session: session!.value })).statusCode).toBe(200);
    /* A page asks for many things at once: they all get the same session. */
    const again = await s.me({ hh_read: read!.value });
    expect(cookieOf(again, 'hh_session')?.value).toBe(session!.value);
    expect(await s.db.select().from(sessions)).toHaveLength(before.length + 1);
  });

  it('leaves no session behind when the request that brings the read cookie signs in itself', async () => {
    const s = await reading();
    const read = cookieOf(await login(s.app), 'hh_read')!.value;
    await s.say('lead');
    const before = await s.db.select().from(sessions);
    const signed = await s.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: SETUP.email, password: SETUP.password }, cookies: { hh_read: read } });
    expect(signed.statusCode).toBe(200);
    /* One session, the one the sign-in made, and the read cookie is gone. */
    const after = await s.db.select().from(sessions);
    expect(after).toHaveLength(before.length + 1);
    expect((await s.me({ hh_session: cookieOf(signed, 'hh_session')!.value })).statusCode).toBe(200);
    expect(signed.cookies.filter(cookie => cookie.name === 'hh_read').every(cookie => cookie.value === '')).toBe(true);
  });

  it('refuses a wrong password, and counts sign-in tries in memory', async () => {
    const s = await reading();
    for (let n = 0; n < 10; n += 1) expect((await login(s.app, 'not the password')).statusCode).toBe(401);
    const eleventh = await login(s.app, 'not the password');
    expect([eleventh.statusCode, eleventh.json().error.reason]).toEqual([429, 'too_many_attempts']);
    expect(eleventh.headers['retry-after']).toBeDefined();
    expect(await s.db.select().from(signInAttempts)).toEqual([]);
  });

  it('ends read cookies with the password', async () => {
    const s = await reading();
    const read = cookieOf(await login(s.app), 'hh_read')!.value;
    await s.say('lead');
    await s.db.update(people).set({ passwordHash: await hashPassword('another password 123') }).where(eq(people.id, s.owner.id));
    const before = await s.db.select().from(sessions);
    const inLead = await s.me({ hh_read: read });
    expect([inLead.statusCode, cookieOf(inLead, 'hh_session')]).toEqual([401, undefined]);
    expect(await s.db.select().from(sessions)).toEqual(before);
    await s.say('read');
    expect((await s.me({ hh_read: read })).statusCode).toBe(401);
  });

  it('trades no read cookie of a person not active', async () => {
    const s = await reading();
    const read = cookieOf(await login(s.app), 'hh_read')!.value;
    await s.say('lead');
    await s.db.update(people).set({ status: 'disabled' }).where(eq(people.id, s.owner.id));
    const refused = await s.me({ hh_read: read });
    expect([refused.statusCode, cookieOf(refused, 'hh_session')]).toEqual([401, undefined]);
    expect(cookieOf(refused, 'hh_read')).toMatchObject({ value: '' });
  });

  it('signs out without writing', async () => {
    const s = await reading();
    const read = cookieOf(await login(s.app), 'hh_read')!.value;
    const before = await s.db.select().from(sessions);
    const out = await s.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { hh_read: read, hh_session: 'whatever' } });
    expect(out.statusCode).toBe(204);
    expect([cookieOf(out, 'hh_read'), cookieOf(out, 'hh_session')]).toMatchObject([{ value: '' }, { value: '' }]);
    expect(await s.db.select().from(sessions)).toEqual(before);
  });
});
