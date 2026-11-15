import * as protocol from '../src/index.js';
import type { z } from 'zod';
import { describe, expect, it } from 'vitest';

/* Namespace lookup reports a missing public contract as an assertion rather
   than failing the test loader on a nonexistent export. */
function accepts(name: string, input: unknown): boolean {
  const schema = Reflect.get(protocol, name) as z.ZodType | undefined;
  expect(schema, `Missing public ${name}`).toBeDefined();
  return schema!.safeParse(input).success;
}

describe('external outcomes', () => {
  const child = { kind: 'child', exitCode: 1, signal: null, osCode: null, stderr: 'remote: temporary refusal', stderrTruncated: false };
  const http = { kind: 'http', status: 403, transportError: null, rateLimit: 'unknown', retryAfterMs: null };

  it.each([child, http, { ...http, status: null, transportError: 'timeout' }])('preserves typed producer evidence %#', input => {
    expect(accepts('ExternalGitOutcome', input)).toBe(true);
  });

  it.each([
    { ...child, exitCode: -1 },
    { ...child, stderr: 'x'.repeat(8193) },
    { ...child, trusted: true },
    { ...http, headers: { authorization: 'not-a-credential' } },
    { ...http, status: 999 },
  ])('refuses unbounded or authority-bearing result %#', input => {
    expect(accepts('ExternalGitOutcome', input)).toBe(false);
  });
});
