import { describe, expect, it } from 'vitest';
import { FAILURE, failure } from '../src/terminal/failures.js';
import { jobDone } from '../src/runner.js';
import rows from './fixtures/failure-kinds.json';

describe('program failure kinds from captured and documented signals', () => {
  it.each(rows)('$program $kind: $raw', ({ program, raw, kind }) => {
    const result = FAILURE[program as keyof typeof FAILURE](raw);
    expect(result.kind).toBe(kind);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.retryable).toBe(['overloaded', 'rate_limited', 'network', 'cut', 'crash'].includes(kind));
  });
  it('uses the program retryable flag when supplied', () => {
    expect(FAILURE.kimi({ code: 'provider.overloaded', message: 'Busy', retryable: false }).retryable).toBe(false);
    expect(FAILURE.antigravity({ short_error: 'Quota exhausted', retryable: true }).retryable).toBe(true);
  });
  it('bounds the reason and carries a redacted failure on job.done', () => {
    expect(failure('unknown', 'x'.repeat(3000)).text).toHaveLength(2000);
    const res = { ok: false, sessionId: 'session', result: '', output: '', error: 'agent_failed' as const, limits: null, failure: failure('crash', 'private-token process exited') };
    expect(jobDone('job', res, ['private-token']).failure).toEqual({ kind: 'crash', text: '[hidden] process exited', retryable: true });
    expect(jobDone('job', { ...res, failure: undefined, error: 'cancelled' }, []).failure).toBeUndefined();
  });
});

it('recognizes the captured Kimi StopFailure auth class with its 401 message', async () => {
  const { default: hooks } = await import('./fixtures/turn-hooks.json');
  const hook = hooks.find(h => h.program === 'kimi' && h.event === 'StopFailure' && h.input.error_type === 'APIStatusError')!;
  expect(FAILURE.kimi(hook.input)).toMatchObject({ kind: 'auth', retryable: false });
});
