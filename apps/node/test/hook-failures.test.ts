import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookFailures } from '../src/terminal/hook-failures.js';

afterEach(() => vi.restoreAllMocks());
describe('hook refusal folding', () => {
  for (const start of [0, 100_000]) it(`folds each agent and cause independently from ${start} ms`, () => {
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const heard: unknown[] = [];
    const failures = new HookFailures((...args) => heard.push(args));
    failures.reject('one', 'stop', 'owner check failed');
    failures.reject('one', 'stop', 'owner check failed');
    now += 30_000;
    failures.reject('one', 'stop', 'request failed');
    failures.reject('one', 'stop', 'owner check failed');
    failures.reject('two', 'stop', 'owner check failed');
    expect(heard).toHaveLength(3);
    now += 30_000;
    failures.reject('one', 'stop', 'owner check failed');
    failures.reject('one', 'stop', 'request failed');
    expect(heard).toHaveLength(4);
  });

  it('can refuse a request when no reporter was installed', () => {
    expect(() => new HookFailures().reject(null, 'unknown', 'unknown bridge address')).not.toThrow();
  });
});
