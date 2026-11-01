import { describe, expect, it } from 'vitest';
import { limiter } from '../src/auth/limit.js';

const MINUTE = 60_000;

describe('limiter', () => {
  it('allows 10 attempts per key in 15 minutes and says when to come back', () => {
    const attempts = limiter();
    const start = 1_000_000;
    for (let i = 0; i < 10; i++) expect(attempts('ivan@acme.com', start + i * 1000).allowed).toBe(true);
    expect(attempts('ivan@acme.com', start + 10_000)).toEqual({ allowed: false, retryAfterS: 890 });
    expect(attempts('maria@acme.com', start + 10_000).allowed).toBe(true);
    expect(attempts('ivan@acme.com', start + 15 * MINUTE).allowed).toBe(true);
  });

  it('takes another count and window, like 50 in an hour', () => {
    const attempts = limiter({ max: 50, windowMs: 60 * MINUTE });
    for (let i = 0; i < 50; i++) expect(attempts('ivan@acme.com', i).allowed).toBe(true);
    expect(attempts('ivan@acme.com', 50)).toEqual({ allowed: false, retryAfterS: 3600 });
    expect(attempts('ivan@acme.com', 60 * MINUTE).allowed).toBe(true);
    expect(attempts.windowMs).toBe(60 * MINUTE);
  });

  it('forgets keys whose window has passed', () => {
    const attempts = limiter();
    for (let i = 0; i < 2000; i++) attempts(`person-${i}@acme.com`, 0);
    attempts('late@acme.com', 16 * MINUTE);
    expect(attempts.size()).toBe(1);
  });
});
