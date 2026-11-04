import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addressKey, longestWait, SIGN_IN_LIMITS, SIGN_IN_LOCK } from '../src/auth/sign-in-limit.js';
import { appOn, SETUP, setUpCompany, statements, testApp } from './helpers.js';

const login = (email: string, password: string, remoteAddress: string) => ({ method: 'POST' as const, url: '/api/auth/login', payload: { email, password }, remoteAddress });
const WRONG = 'wrong password!';
const rowsOf = (result: unknown) => (result as { rows: Record<string, unknown>[] }).rows;

describe('addressKey', () => {
  it('reads an address as the limit counts it', () => {
    expect(addressKey('203.0.113.5')).toBe('203.0.113.5');
    expect(addressKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(addressKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0db8:0001:0002::ffff')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
  });
});

describe('longestWait', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  it('waits until the oldest try of a full limit leaves its window, rounded up to whole seconds', () => {
    const window = SIGN_IN_LIMITS.emailAddress.windowMs;
    const oldest = new Date(minutesAgo(10).getTime() - 500);
    expect(longestWait([{ oldest, windowMs: window }], now)).toEqual({ retryAfterS: 300, windowMs: window });
  });

  it('answers the longest wait of the full limits, with that limit window', () => {
    const short = { oldest: minutesAgo(14), windowMs: SIGN_IN_LIMITS.emailAddress.windowMs };
    const long = { oldest: minutesAgo(5), windowMs: SIGN_IN_LIMITS.address.windowMs };
    expect(longestWait([short, long], now)).toEqual({ retryAfterS: 55 * 60, windowMs: SIGN_IN_LIMITS.address.windowMs });
  });

  it('answers one second when no limit is full any more', () => {
    expect(longestWait([], now)).toEqual({ retryAfterS: 1, windowMs: SIGN_IN_LIMITS.emailAddress.windowMs });
  });

  it('never answers less than one second', () => {
    expect(longestWait([{ oldest: minutesAgo(15), windowMs: SIGN_IN_LIMITS.emailAddress.windowMs }], now).retryAfterS).toBe(1);
  });
});

describe('POST /api/auth/login limits in the database', () => {
  it('stops one address after 30 failed sign-ins in an hour across emails', async () => {
    const { app } = await testApp();
    await setUpCompany(app);
    for (let i = 0; i < 30; i++) expect((await app.inject(login(`x${i}@acme.com`, WRONG, '203.0.113.5'))).statusCode).toBe(401);
    const blocked = await app.inject(login('ivan@acme.com', SETUP.password, '203.0.113.5'));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatchObject({ code: 'too_many', reason: 'too_many_attempts', message: 'Too many attempts. Wait up to 60 minutes, then try again.' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(15 * 60);
    expect((await app.inject(login('ivan@acme.com', SETUP.password, '198.51.100.20'))).statusCode).toBe(200);
  });

  it('counts an IPv6 visitor by its /64', async () => {
    const { app } = await testApp();
    await setUpCompany(app);
    for (let i = 1; i <= 30; i++) expect((await app.inject(login(`x${i}@acme.com`, WRONG, `2001:db8:1:2::${i}`))).statusCode).toBe(401);
    expect((await app.inject(login('ivan@acme.com', SETUP.password, '2001:db8:1:2::ffff'))).statusCode).toBe(429);
    expect((await app.inject(login('ivan@acme.com', WRONG, '2001:db8:1:3::1'))).statusCode).toBe(401);
  });

  it('keeps the counts across a restart', async () => {
    const first = await testApp();
    await setUpCompany(first.app);
    for (let i = 0; i < 10; i++) expect((await first.app.inject(login('ivan@acme.com', WRONG, '203.0.113.5'))).statusCode).toBe(401);
    const second = await appOn((first.db as unknown as { $client: PGlite }).$client);
    expect((await second.app.inject(login('ivan@acme.com', SETUP.password, '203.0.113.5'))).statusCode).toBe(429);
  });

  it('does not count a sign-in that worked', async () => {
    const { app } = await testApp();
    await setUpCompany(app);
    for (let i = 0; i < 9; i++) expect((await app.inject(login('ivan@acme.com', WRONG, '203.0.113.5'))).statusCode).toBe(401);
    expect((await app.inject(login('ivan@acme.com', SETUP.password, '203.0.113.5'))).statusCode).toBe(200);
    expect((await app.inject(login('ivan@acme.com', WRONG, '203.0.113.5'))).statusCode).toBe(401);
    expect((await app.inject(login('ivan@acme.com', SETUP.password, '203.0.113.5'))).statusCode).toBe(429);
  });

  it('forgets tries older than an hour', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    for (let i = 0; i < 30; i++) {
      await app.inject(login(`old${i}@acme.com`, WRONG, '203.0.113.5'));
    }
    await db.execute(sql`update sign_in_attempts set at = now() - interval '61 minutes'`);
    expect((await app.inject(login('ivan@acme.com', SETUP.password, '203.0.113.5'))).statusCode).toBe(200);
    expect(rowsOf(await db.execute(sql`select count(*)::int as n from sign_in_attempts`))).toEqual([{ n: 0 }]);
  });

  it('keeps no email or address in the clear', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    await app.inject(login('ivan@acme.com', WRONG, '203.0.113.5'));
    const rows = rowsOf(await db.execute(sql`select t::text as row from sign_in_attempts t`));
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.row)).not.toContain('ivan@acme.com');
    expect(String(rows[0]!.row)).not.toContain('203.0.113.5');
  });

  it('lets 30 of 100 wrong sign-ins at once from one address reach the password check', async () => {
    const { app } = await testApp();
    await setUpCompany(app);
    const seen = statements();
    const answers = await Promise.all(Array.from({ length: 100 }, (_, i) => app.inject(login(`x${i}@acme.com`, WRONG, '203.0.113.7'))));
    expect(answers.filter(a => a.statusCode === 401)).toHaveLength(30);
    expect(answers.filter(a => a.statusCode === 429)).toHaveLength(70);
    /* PGlite has one connection, so the order of the statements is what shows the lock holds the limit on a pool. */
    const inserts = seen.flatMap((s, at) => (s.sql.includes('INSERT INTO sign_in_attempts') ? [at] : []));
    expect(inserts).toHaveLength(100);
    for (const at of inserts) {
      expect(seen[at - 1]?.sql).toContain('pg_advisory_xact_lock');
      expect(seen[at - 1]?.params).toEqual([SIGN_IN_LOCK]);
    }
  });
});
