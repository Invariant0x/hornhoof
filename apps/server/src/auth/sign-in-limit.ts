import { eq, sql, type SQL } from 'drizzle-orm';
import { hashToken } from '../crypto/tokens.js';
import type { Db } from '../db/client.js';
import { signInAttempts } from '../db/schema.js';
import { PEER_ADDRESS } from './tunnel.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/* A try counts against all three: one email from one address, one email from anywhere, one address across all emails. */
export const SIGN_IN_LIMITS = {
  emailAddress: { max: 10, windowMs: 15 * MINUTE },
  email: { max: 50, windowMs: HOUR },
  address: { max: 30, windowMs: HOUR },
} as const;

type LimitName = keyof typeof SIGN_IN_LIMITS;
const LIMIT_NAMES = Object.keys(SIGN_IN_LIMITS) as LimitName[];
const KEEP_MS = Math.max(...LIMIT_NAMES.map(name => SIGN_IN_LIMITS[name].windowMs));

/* The pg_advisory_xact_lock key of sign-in tries, used for nothing else. */
export const SIGN_IN_LOCK = 0x68680001;

const DOTTED_TAIL = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const hexGroup = (n: number) => n.toString(16);
const asGroups = (side: string) => (side ? side.split(':') : []);

/* Replaces a trailing dotted IPv4 with its two hex groups, so every address is plain colon groups. */
function withoutDottedTail(address: string): string {
  const tail = DOTTED_TAIL.exec(address);
  if (!tail) return address;
  const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
  return `${address.slice(0, tail.index)}${hexGroup(a * 256 + b)}:${hexGroup(c * 256 + d)}`;
}

/* The eight groups of a colon address, in whatever form it came: with `::`, a dotted tail or a zone, in any case. */
function eightGroups(address: string): number[] {
  const [left = '', right = ''] = withoutDottedTail(address.split('%')[0]!).split('::');
  const head = asGroups(left);
  const tail = asGroups(right);
  const gap = Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0');
  return [...head, ...gap, ...tail].map(group => parseInt(group, 16));
}

const isIpv4Mapped = (groups: number[]) => groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
const asIpv4 = ([high, low]: number[]) => [high! >> 8, high! & 0xff, low! >> 8, low! & 0xff].join('.');

/* What the limit counts an address as: an IPv4 as its text, in whichever form it came, an IPv6 as its /64, since one
   visitor holds a whole /64, and a peer machine as itself. */
export function addressKey(address: string): string {
  if (!address.includes(':') || address.startsWith(PEER_ADDRESS)) return address;
  const groups = eightGroups(address);
  return isIpv4Mapped(groups) ? asIpv4(groups.slice(6)) : `${groups.slice(0, 4).map(hexGroup).join(':')}::/64`;
}

interface FullLimit {
  oldest: Date;
  windowMs: number;
}

/* How long to wait: the longest of the full limits, each free again when its oldest try leaves its window. */
export function longestWait(full: FullLimit[], now: Date): { retryAfterS: number; windowMs: number } {
  const waits = full.map(({ oldest, windowMs }) => ({ retryAfterS: Math.ceil((oldest.getTime() + windowMs - now.getTime()) / 1000), windowMs }));
  const longest = waits.reduce((a, b) => (b.retryAfterS > a.retryAfterS ? b : a), waits[0] ?? { retryAfterS: 1, windowMs: SIGN_IN_LIMITS.emailAddress.windowMs });
  return { ...longest, retryAfterS: Math.max(1, longest.retryAfterS) };
}

/* Db is generic over the driver, so a raw statement's result is unknown here; both drivers answer { rows }. */
const rowsIn = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;

type Hashes = { e: string; a: string };

const scopeOf = ({ e, a }: Hashes): Record<LimitName, SQL> => ({
  emailAddress: sql`email_hash = ${e} AND address_hash = ${a}`,
  email: sql`email_hash = ${e}`,
  address: sql`address_hash = ${a}`,
});

const inWindow = (windowMs: number) => sql`at > now() - ${windowMs / 1000}::int * interval '1 second'`;
const rowsOf = (name: LimitName, hashes: Hashes) => sql`FROM sign_in_attempts WHERE ${scopeOf(hashes)[name]} AND ${inWindow(SIGN_IN_LIMITS[name].windowMs)}`;
const underLimit = (name: LimitName, hashes: Hashes) => sql`(SELECT count(*) ${rowsOf(name, hashes)}) < ${SIGN_IN_LIMITS[name].max}`;

async function insertIfUnder(db: Db, hashes: Hashes): Promise<string | undefined> {
  const allUnder = sql.join(LIMIT_NAMES.map(name => underLimit(name, hashes)), sql` AND `);
  /* The lock is its own statement so the insert, run after it, takes a new snapshot that sees every try committed
     before; the commit lets the lock go before the password is checked. */
  const inserted: unknown = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SIGN_IN_LOCK}::bigint)`);
    return tx.execute(sql`INSERT INTO sign_in_attempts (email_hash, address_hash) SELECT ${hashes.e}, ${hashes.a} WHERE ${allUnder} RETURNING id`);
  });
  return rowsIn<{ id: string }>(inserted)[0]?.id;
}

async function fullLimits(db: Db, hashes: Hashes): Promise<{ full: FullLimit[]; now: Date }> {
  const perLimit = LIMIT_NAMES.map(name => sql`SELECT ${name}::text AS name, count(*)::int AS n, min(at) AS oldest, now() AS now ${rowsOf(name, hashes)}`);
  const rows = rowsIn<{ name: LimitName; n: number; oldest: Date | string | null; now: Date | string }>(await db.execute(sql.join(perLimit, sql` UNION ALL `)));
  const full = rows.filter(row => row.oldest && row.n >= SIGN_IN_LIMITS[row.name].max).map(row => ({ oldest: new Date(row.oldest!), windowMs: SIGN_IN_LIMITS[row.name].windowMs }));
  return { full, now: new Date(rows[0]!.now) };
}

type SignInTry = { allowed: true; id: string } | { allowed: false; retryAfterS: number; windowMs: number };

/* Writes the try before the password is checked, only while all three counts are under their limit, so a burst counts. */
export async function signInTry(db: Db, email: string, address: string): Promise<SignInTry> {
  const hashes = { e: hashToken(email), a: hashToken(addressKey(address)) };
  await db.delete(signInAttempts).where(sql`${signInAttempts.at} < now() - ${KEEP_MS / 1000}::int * interval '1 second'`);
  const id = await insertIfUnder(db, hashes);
  if (id) return { allowed: true, id };
  const { full, now } = await fullLimits(db, hashes);
  return { allowed: false, ...longestWait(full, now) };
}

/* A sign-in that worked is not a failure, so its try is taken back. */
export async function signInWorked(db: Db, id: string): Promise<void> {
  await db.delete(signInAttempts).where(eq(signInAttempts.id, id));
}
