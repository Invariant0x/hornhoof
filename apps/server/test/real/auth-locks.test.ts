import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../../src/app.js';
import { LINK_SESSION_COOKIE } from '../../src/auth/session.js';
import { SIGN_IN_LIMITS, SIGN_IN_LOCK, signInTry } from '../../src/auth/sign-in-limit.js';
import { loadConfig } from '../../src/config.js';
import { hashToken } from '../../src/crypto/tokens.js';
import { APP_NAME, migrateDb, openDb, type Db } from '../../src/db/client.js';
import { as, invitePerson, setUpCompany, TEST_SECRET, TUNNEL, until, viaLink } from '../helpers.js';
import { poolOf, realDatabase, sessionsWaitingOnALock, type RealDatabase } from './pg.js';

/* PGlite has one connection, so what these locks are for shows only here. Nothing rests on timing: a transaction on a
   client of its own holds a lock open, and the test goes on when the database itself says the others wait behind it. */
const SESSION_ROW = 'SELECT 1 FROM sessions WHERE token_hash = $1 FOR UPDATE';

let real: RealDatabase;
let db: Db;
let app: FastifyInstance;
let ceo: string;

beforeAll(async () => {
  real = await realDatabase();
  await migrateDb(real.url);
  db = openDb(real.url, APP_NAME);
  app = await buildApp({ db, config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, UPDATE_CHECK_MS: '0', TUNNEL_HOST: TUNNEL }) });
  ceo = await setUpCompany(app);
});

/* A beforeAll that failed leaves some of these unset, and its failure is the one to see. The database goes in any case. */
afterAll(async () => {
  try {
    await app?.close();
    if (db) await poolOf(db).end();
  } finally {
    await real?.drop();
  }
});

/* Ending the client when the test ends rolls back what a failed test left open, so the waiting requests get to finish. */
async function holding(text: string, values: unknown[]): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: real.url });
  await client.connect();
  onTestFinished(() => client.end());
  await client.query('BEGIN');
  await client.query(text, values);
  return client;
}

const untilWaiting = (count: number): Promise<void> => until(async () => (await sessionsWaitingOnALock(real, APP_NAME)) >= count);

describe('moving a session from before the switch', () => {
  /* A new person's session, marked as the migration marks the rows of an older install. */
  async function olderSessionOf(name: string): Promise<{ token: string; personId: string }> {
    const token = await invitePerson(app, ceo, { name, email: `${name}@hornhoof.test`, access: { whole: true } });
    const { rows } = await real.admin.query<{ person_id: string }>('UPDATE sessions SET before_host_cookie = true WHERE token_hash = $1 RETURNING person_id', [hashToken(token)]);
    return { token, personId: rows[0]!.person_id };
  }

  const meWithOldCookie = (token: string) => app.inject({ url: '/api/me', ...viaLink(), cookies: { hh_session: token } });
  const movedTo = (res: { cookies: { name: string; value: string }[] }): string => res.cookies.find(c => c.name === LINK_SESSION_COOKIE)!.value;

  it('lets two hand-overs of one session at once through, each with a session of its own', async () => {
    const { token, personId } = await olderSessionOf('burst');
    const holder = await holding(SESSION_ROW, [hashToken(token)]);
    const moves = [meWithOldCookie(token), meWithOldCookie(token)];
    await untilWaiting(2);
    await holder.query('COMMIT');
    const answers = await Promise.all(moves);
    expect(answers.map(a => a.statusCode)).toEqual([200, 200]);
    const fresh = answers.map(movedTo);
    expect(new Set(fresh).size).toBe(2);
    const signedIn = await Promise.all(fresh.map(t => app.inject({ url: '/api/me', ...viaLink(t) })));
    expect(signedIn.map(a => a.statusCode)).toEqual([200, 200]);
    const { rows } = await real.admin.query(
      "SELECT before_host_cookie, expires_at <= now() + interval '60 seconds' AS ends_within_a_minute FROM sessions WHERE person_id = $1 ORDER BY before_host_cookie",
      [personId],
    );
    expect(rows).toEqual([
      { before_host_cookie: false, ends_within_a_minute: false },
      { before_host_cookie: false, ends_within_a_minute: false },
      { before_host_cookie: true, ends_within_a_minute: true },
    ]);
  });

  /* The hand-over holds the person's row while it waits for the session's. A disable in that moment waits on the person's
     row too, so its delete of the person's sessions runs after the commit and sees the new session. Without that lock it
     would delete only the sessions it could see, and the new one would come back with the person. */
  it('leaves no session of a person disabled during a hand-over', async () => {
    const { token, personId } = await olderSessionOf('leaving');
    const holder = await holding(SESSION_ROW, [hashToken(token)]);
    const move = meWithOldCookie(token);
    await untilWaiting(1);
    const disable = app.inject({ method: 'PATCH', url: `/api/people/${personId}`, payload: { status: 'disabled' }, ...as(ceo) });
    await untilWaiting(2);
    await holder.query('COMMIT');
    const [moved, disabled] = await Promise.all([move, disable]);
    expect(disabled.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me', ...viaLink(movedTo(moved)) })).statusCode).toBe(401);
    const { rows } = await real.admin.query('SELECT count(*)::int AS n FROM sessions WHERE person_id = $1', [personId]);
    expect(rows).toEqual([{ n: 0 }]);
  });
});

describe('the sign-in limit', () => {
  /* A try that fails stays written, as only one that worked is taken back, so this is what 100 failures at once leave. */
  it('counts 100 tries at once from one address to the limit and no further', async () => {
    const holder = await holding('SELECT pg_advisory_xact_lock($1::bigint)', [SIGN_IN_LOCK]);
    const tries = Array.from({ length: 100 }, (_, i) => signInTry(db, `x${i}@hornhoof.test`, '203.0.113.7'));
    /* Every connection of the pool in line, so the tries overlap as far as they can on a machine of any speed. */
    await untilWaiting(poolOf(db).options.max);
    await holder.query('COMMIT');
    const answers = await Promise.all(tries);
    expect(answers.filter(a => a.allowed)).toHaveLength(SIGN_IN_LIMITS.address.max);
    const { rows } = await real.admin.query('SELECT count(*)::int AS n FROM sign_in_attempts');
    expect(rows).toEqual([{ n: SIGN_IN_LIMITS.address.max }]);
  });
});
