import { describe, expect, it } from 'vitest';
import { SIGNED_OUT } from '../src/providers/antigravity.js';
import { FAILURE, failure } from '../src/terminal/failures.js';
import { jobDone } from '../src/runner.js';
import rows from './fixtures/failure-kinds.json' with { type: 'json' };

describe('program failure kinds from captured and documented signals', () => {
  it.each(rows)('$program $kind: $raw', ({ program, raw, kind, retryable }) => {
    const result = FAILURE[program as keyof typeof FAILURE](raw);
    expect(result.kind).toBe(kind);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.retryable).toBe(retryable ?? ['overloaded', 'rate_limited', 'network', 'cut', 'crash'].includes(kind));
  });
  it.each([
    ['claude', { error: 'server_error', last_assistant_message: 'API Error: 500 Internal Server Error' }],
    ['claude', { error: 'server_error', last_assistant_message: 'API Error: 502 Bad Gateway' }],
    ['codex', { codex_error_info: 'internal_server_error', message: 'Internal Server Error' }],
    ['codex', { codex_error_info: { http_connection_failed: { http_status_code: 502 } }, message: 'Bad Gateway' }],
    ['codex', { codex_error_info: { other: { http_status_code: 599 } }, message: 'Server error' }],
    ['kimi', { code: 'provider.other', name: 'APIStatusError', details: { statusCode: 500 }, message: 'Internal Server Error' }],
    ['kimi', { error_type: 'APIStatusError', error_message: '502 Bad Gateway' }],
  ] as const)('retries %s provider server error %j', (program, raw) => {
    expect(FAILURE[program](raw)).toMatchObject({ kind: 'unknown', retryable: true });
  });
  it('uses the program retryable flag when supplied', () => {
    expect(FAILURE.kimi({ code: 'provider.overloaded', message: 'Busy', retryable: false }).retryable).toBe(false);
    expect(FAILURE.antigravity({ short_error: 'Quota exhausted', retryable: true }).retryable).toBe(true);
  });
  it('uses the Antigravity sign-in signal when its provider is loaded first', () => {
    const short_error = 'Please sign in';
    expect(SIGNED_OUT.test(short_error)).toBe(true);
    expect(FAILURE.antigravity({ short_error })).toMatchObject({ kind: 'auth', retryable: false });
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

describe('model access denial', () => {
  it('classifies the current Codex access diagnostic explicitly, not as unknown or overload', () => {
    expect(FAILURE.codex({ codex_error_info: { model_access_denied: { http_status_code: 403 } }, message: 'Unable to verify model access' })).toMatchObject({ kind: 'model_access_denied', retryable: false });
  });

  it('keeps server overload separate from access denial and unknown failures', () => {
    expect(FAILURE.codex({ codex_error_info: { server_overloaded: { http_status_code: 503 } }, message: 'Selected model is at capacity' })).toMatchObject({ kind: 'overloaded', retryable: true });
    expect(FAILURE.codex({ codex_error_info: { unauthorized: { http_status_code: 403 } }, message: 'Unauthorized' })).toMatchObject({ kind: 'auth', retryable: false });
    expect(FAILURE.codex({ codex_error_info: { other: { http_status_code: 500 } }, message: 'Internal Server Error' })).toMatchObject({ kind: 'unknown', retryable: true });
  });
});
