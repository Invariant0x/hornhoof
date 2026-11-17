import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/* The cookie of a person who signs in on a machine that only reads the company's data: no session can be written
   there, so the cookie itself says who signed in and until when, under a mark only this company can make. The mark
   covers the person's password as it was, so a password that changed or was reset ends every such cookie. */

const READ_COOKIE = 'hh_read';
/* Over the link, as the session's: a page on another company's name under hornhoof.org cannot set it. */
const LINK_READ_COOKIE = '__Host-hh_read';
export const readCookieOf = (req: FastifyRequest): string => (req.overLink ? LINK_READ_COOKIE : READ_COOKIE);
export const READ_MS = 12 * 3_600_000;

const PERSON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNTIL = /^[1-9][0-9]{0,15}$/;

function markOf(personId: string, until: string, passwordHash: string, secret: Buffer): Buffer {
  const key = createHmac('sha256', secret).update('hh_read v1').digest();
  const password = createHash('sha256').update(passwordHash).digest('base64url');
  return createHmac('sha256', key).update(`${personId}.${until}.${password}`).digest();
}

/* until: when it ends, in ms. secret: the company's. */
export function signRead(personId: string, passwordHash: string, until: number, secret: Buffer): string {
  return `${personId}.${until}.${markOf(personId, String(until), passwordHash, secret).toString('base64url')}`;
}

function parts(value: string | undefined): { person: string; until: string; mark: string } | null {
  const [person, until, mark, ...more] = (value ?? '').split('.');
  if (!person || !until || !mark || more.length || !PERSON.test(person) || !UNTIL.test(until)) return null;
  return { person, until, mark };
}

/* The person a well-formed value names; whether it holds is checkRead's to say. */
export function readPerson(value: string | undefined): string | null {
  return parts(value)?.person ?? null;
}

/* True while its time is ahead, the person has a password, and the mark is the one this company makes for that person,
   that time and that password. */
export function checkRead(value: string | undefined, passwordHash: string | null, secret: Buffer, now: number): boolean {
  const said = parts(value);
  if (!said || passwordHash === null || Number(said.until) <= now) return false;
  const mark = Buffer.from(said.mark, 'base64url');
  const right = markOf(said.person, said.until, passwordHash, secret);
  /* One mark has one spelling: a value that decodes to it and is written another way is not the cookie that was given. */
  return mark.length === right.length && timingSafeEqual(mark, right) && mark.toString('base64url') === said.mark;
}
