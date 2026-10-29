import type { FastifyReply } from 'fastify';
import { ApiError } from '../errors.js';

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
/* Past this many keys, keys with no attempt in the window are dropped, so made-up emails cannot fill memory. */
const SWEEP_AT = 1000;

export type Attempts = ((key: string, now?: number) => { allowed: boolean; retryAfterS: number }) & { size(): number };

/* Counts attempts per key in memory: 10 in any 15 minutes. One per route, so login and invites do not share counts. */
export function limiter(): Attempts {
  const seen = new Map<string, number[]>();

  const attempts = (key: string, now = Date.now()) => {
    if (seen.size > SWEEP_AT) {
      for (const [k, times] of seen) if (times[times.length - 1]! <= now - WINDOW_MS) seen.delete(k);
    }
    const recent = (seen.get(key) ?? []).filter(t => t > now - WINDOW_MS);
    if (recent.length >= MAX_ATTEMPTS) {
      seen.set(key, recent);
      return { allowed: false, retryAfterS: Math.ceil((recent[0]! + WINDOW_MS - now) / 1000) };
    }
    recent.push(now);
    seen.set(key, recent);
    return { allowed: true, retryAfterS: 0 };
  };
  return Object.assign(attempts, { size: () => seen.size });
}

/* Answers 429 with Retry-After once the key is over the limit. */
export function guard(reply: FastifyReply, attempts: Attempts, key: string): void {
  const { allowed, retryAfterS } = attempts(key);
  if (allowed) return;
  reply.header('retry-after', String(retryAfterS));
  throw new ApiError(429, 'too_many', 'Too many attempts. Wait up to 15 minutes, then try again.', 'too_many_attempts');
}
