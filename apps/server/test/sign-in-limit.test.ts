import type { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { PglitePreparedQuery } from 'drizzle-orm/pglite';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { addressKey, longestWait, SIGN_IN_LIMITS, SIGN_IN_LOCK } from '../src/auth/sign-in-limit.js';
import { readProxyV2 } from '../src/modules/tls/proxy-header.js';
import { appOn, SETUP, setUpCompany, statements, testApp } from './helpers.js';
import { ipv6Addresses, proxyV2, TCP_OVER_IPV6 } from './proxy-v2.js';

const login = (email: string, password: string, remoteAddress: string) => ({ method: 'POST' as const, url: '/api/auth/login', payload: { email, password }, remoteAddress });
const WRONG = 'wrong password!';
const rowsOf = (result: unknown) => (result as { rows: Record<string, unknown>[] }).rows;
const SIGN_IN_LOCK_HOLDERS = `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${SIGN_IN_LOCK}`;

/* How many hold the sign-in lock as each try's insert starts, as the database itself says, asked on the insert's own
   connection handle. A transaction's lock lasts until its commit, and without a transaction it is gone with its own
   statement, so this tells the two apart where PGlite's one connection cannot race them. */
function lockHoldersAtEachInsert(): number[] {
  const holders: number[] = [];
  const execute = PglitePreparedQuery.prototype.execute;
  const spy = vi.spyOn(PglitePreparedQuery.prototype, 'execute').mockImplementation(async function (this: PglitePreparedQuery<never>, values) {
    const { queryString, client } = this as unknown as { queryString: string; client: PGlite };
    if (queryString.includes('INSERT INTO sign_in_attempts')) {
      const { rows } = await client.query<{ n: number }>(SIGN_IN_LOCK_HOLDERS);
      holders.push(rows[0]!.n);
    }
    return execute.call(this, values);
  });
  onTestFinished(() => spy.mockRestore());
  return holders;
}

describe('addressKey', () => {
  it('reads an address as the limit counts it', () => {
    expect(addressKey('203.0.113.5')).toBe('203.0.113.5');
    expect(addressKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(addressKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:0db8:0001:0002::ffff')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
  });

  it.each([
    ['with a dotted tail', '::ffff:203.0.113.5'],
    ['in capitals', '::FFFF:203.0.113.5'],
    ['as eight groups', '0:0:0:0:0:ffff:cb00:7105'],
    ['as eight groups with their zeros', '0000:0000:0000:0000:0000:FFFF:CB00:7105'],
    ['shortened, in hex', '::ffff:cb00:7105'],
    ['as six groups and a dotted tail', '0:0:0:0:0:ffff:203.0.113.5'],
    ['with a zone', '::ffff:203.0.113.5%eth0'],
  ])('counts an IPv4-mapped address by its IPv4 %s', (_form, address) => {
    expect(addressKey(address)).toBe('203.0.113.5');
  });

  it('counts by its /64 an address that only looks IPv4-mapped', () => {
    expect(addressKey('::fffe:cb00:7105')).toBe('0:0:0:0::/64');
    expect(addressKey('1::ffff:cb00:7105')).toBe('1:0:0:0::/64');
  });

  it('reads the source a PROXY header over IPv6 gives', () => {
    const keyOf = (groups: number[]) => {
      const header = readProxyV2(proxyV2({ family: TCP_OVER_IPV6, addresses: ipv6Addresses(groups) }));
      return addressKey((header as { source: string }).source);
    };
    expect(keyOf([0, 0, 0, 0, 0, 0xffff, 0xcb00, 0x7107])).toBe('203.0.113.7');
    expect(keyOf([0, 0, 0, 0, 0, 0xffff, 0xc633, 0x6414])).toBe('198.51.100.20');
    expect(keyOf([0x2001, 0xdb8, 1, 2, 3, 4, 5, 6])).toBe('2001:db8:1:2::/64');
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

  it('names the window of a full limit in its last second', () => {
    const lastSecond = new Date(minutesAgo(60).getTime() + 500);
    expect(longestWait([{ oldest: lastSecond, windowMs: SIGN_IN_LIMITS.address.windowMs }], now)).toEqual({ retryAfterS: 1, windowMs: SIGN_IN_LIMITS.address.windowMs });
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
    /* PGlite has one connection, so this shows the order of the lock and the insert, and the next test their one
       transaction; tries really racing on a pool of connections need real Postgres, which plan 3 Task 1's harness
       brings (test/real/auth-locks.real.ts). */
    const inserts = seen.flatMap((s, at) => (s.sql.includes('INSERT INTO sign_in_attempts') ? [at] : []));
    expect(inserts).toHaveLength(100);
    for (const at of inserts) {
      expect(seen[at - 1]?.sql).toContain('pg_advisory_xact_lock');
      expect(seen[at - 1]?.params).toEqual([SIGN_IN_LOCK]);
    }
  });

  it('still holds the lock when the insert of a try runs, and lets it go with the try', async () => {
    const { app, db } = await testApp();
    await setUpCompany(app);
    const holders = lockHoldersAtEachInsert();
    await Promise.all(Array.from({ length: 5 }, (_, i) => app.inject(login(`x${i}@acme.com`, WRONG, '203.0.113.7'))));
    expect(holders).toEqual([1, 1, 1, 1, 1]);
    expect(rowsOf(await db.execute(sql.raw(SIGN_IN_LOCK_HOLDERS)))).toEqual([{ n: 0 }]);
  });
});
