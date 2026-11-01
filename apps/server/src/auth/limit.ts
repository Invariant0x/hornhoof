import type { FastifyReply } from 'fastify';
import { ApiError } from '../errors.js';

/* Past this many keys, keys with no attempt in the window are dropped, so made-up emails cannot fill memory. */
const SWEEP_AT = 1000;

export type Attempts = ((key: string, now?: number) => { allowed: boolean; retryAfterS: number }) & { size(): number; windowMs: number };

/* Counts attempts per key in memory: 10 in any 15 minutes unless told otherwise. One per route, so login and invites do
   not share counts. */
export function limiter({ max = 10, windowMs = 15 * 60 * 1000 }: { max?: number; windowMs?: number } = {}): Attempts {
  const seen = new Map<string, number[]>();

  const attempts = (key: string, now = Date.now()) => {
    if (seen.size > SWEEP_AT) {
      for (const [k, times] of seen) if (times[times.length - 1]! <= now - windowMs) seen.delete(k);
    }
    const recent = (seen.get(key) ?? []).filter(t => t > now - windowMs);
    if (recent.length >= max) {
      seen.set(key, recent);
      return { allowed: false, retryAfterS: Math.ceil((recent[0]! + windowMs - now) / 1000) };
    }
    recent.push(now);
    seen.set(key, recent);
    return { allowed: true, retryAfterS: 0 };
  };
  return Object.assign(attempts, { size: () => seen.size, windowMs });
}

/* Answers 429 with Retry-After once the key is over the limit. */
export function guard(reply: FastifyReply, attempts: Attempts, key: string): void {
  const { allowed, retryAfterS } = attempts(key);
  if (allowed) return;
  reply.header('retry-after', String(retryAfterS));
  throw new ApiError(429, 'too_many', `Too many attempts. Wait up to ${Math.round(attempts.windowMs / 60_000)} minutes, then try again.`, 'too_many_attempts');
}
