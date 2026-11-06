import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/app.js';
import type { ToolJob } from '../src/modules/tools/job.js';
import { startRun } from '../src/modules/testruns/runs.js';
import * as environment from '../src/modules/testruns/describe.js';

describe('manual and product run mode boundaries', () => {
  it.each([{ suite: 'api' }, { profile: 'fast' }, { suite: 'api', profile: 'fast' }])('rejects command with product selectors before reading any database state: %j', selectors => {
    const ctx = { get db() { throw new Error('Database access preceded mode validation.'); } } as unknown as Ctx;
    const job = {} as ToolJob;
    return expect(startRun(ctx, job, { command: 'npm test', ...selectors })).rejects.toMatchObject({ status: 400, reason: 'test_mode_conflict' });
  });

  it('keeps the manual command text intact and defaults to product mode only when command is absent', () => {
    expect(environment.testRunMode({ command: ' npm ci && npm test ', parts: 2 }, 'tests')).toEqual({ mode: 'manual', command: ' npm ci && npm test ', parts: 2 });
    expect(environment.testRunMode({}, 'tests')).toEqual({ mode: 'product' });
    expect(environment.testRunMode({ suite: 'api', profile: 'fast' }, 'tests')).toEqual({ mode: 'product', suite: 'api', profile: 'fast' });
    expect(() => environment.testRunMode({ command: ' ' }, 'tests')).toThrow();
    expect(() => environment.testRunMode({}, 'work')).toThrow();
    expect(() => environment.testRunMode({ profile: 'fast', parts: 2 }, 'tests')).toThrow();
  });
});
