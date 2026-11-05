import { describe, expect, it } from 'vitest';
import type { Failure } from '@hornhoof/protocol';
import { turnCause } from '../src/handoff-runtime.js';
import { jobDone, type RunResult } from '../src/runner.js';
import { FAILURE, failure } from '../src/terminal/failures.js';

const ended: RunResult = { ok: false, sessionId: 'the-session', result: '', output: '', error: 'agent_failed', limits: null };

describe('what a typed failure of the current turn means for a handover', () => {
  it.each([
    ['codex', { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity' }],
    ['codex', { codex_error_info: 'other', message: 'Selected model is at capacity. Please try a different model.' }],
    ['codex', { message: 'Selected model is at capacity.' }],
    ['codex', { codex_error_info: { other: { http_status_code: 503 } }, message: 'Busy' }],
    ['claude', { error: 'overloaded', last_assistant_message: 'Overloaded' }],
    ['kimi', { code: 'provider.overloaded', message: 'Busy' }],
    ['antigravity', { short_error: 'Model overloaded' }],
  ] as const)('%s %j is a temporary overload, worth the same session again', (program, raw) => {
    const result = FAILURE[program](raw);
    expect(result).toMatchObject({ kind: 'overloaded', retryable: true });
    expect(turnCause(result)).toBe('temporary_overload');
    const done = jobDone('job', { ...ended, failure: result }, []);
    expect(done.sessionId).toBe('the-session');
    expect(done.failure?.kind).toBe('overloaded');
  });

  it('does not take the words for overload out of a report of something else', () => {
    expect(FAILURE.codex({ codex_error_info: 'other', message: 'A tool printed: Selected model is at capacity' }).kind).toBe('unknown');
    expect(FAILURE.codex({ codex_error_info: 'usage_limit_exceeded', message: 'Selected model is at capacity' }).kind).toBe('usage_limit');
  });

  it('keeps a limit a limit', () => {
    expect(turnCause(FAILURE.codex({ codex_error_info: 'usage_limit_exceeded', message: 'Used up' }))).toBe('usage_limit');
    expect(turnCause(FAILURE.kimi({ code: 'provider.quota_exhausted', message: 'Quota' }))).toBe('usage_limit');
    expect(turnCause(FAILURE.codex({ codex_error_info: 'rate_limit_exceeded', message: 'Slow down' }))).toBe('other');
  });

  it.each([
    ['codex', { codex_error_info: 'other', message: 'Unable to verify model access' }],
    ['codex', { codex_error_info: { other: { http_status_code: 403 } }, message: 'Unable to verify model access for this plan' }],
    ['kimi', { code: 'provider.other', message: 'Unable to verify model access' }],
    ['antigravity', { short_error: 'Unable to verify model access' }],
  ] as const)('%s %j is a denied model', (program, raw) => {
    expect(turnCause(FAILURE[program](raw))).toBe('model_access_denied');
  });

  it.each<[string, Failure]>([
    ['a phrase quoted in another error', failure('unknown', 'other: the tool result said: Unable to verify model access')],
    ['a phrase further into the words', failure('unknown', 'A file in the repository holds Unable to verify model access')],
    ['a sign-in failure', failure('auth', 'Unable to verify model access')],
    ['a safety refusal', failure('refused', 'cyber_policy: Unable to verify model access')],
    ['an overload', failure('overloaded', 'Unable to verify model access')],
  ])('%s is not a denied model', (_, given) => {
    expect(turnCause(given)).not.toBe('model_access_denied');
  });

  it('takes nothing from a program that only ended badly', () => {
    expect(turnCause(null)).toBe('other');
    expect(turnCause(undefined)).toBe('other');
    expect(turnCause(failure('crash', 'exit code 1'))).toBe('other');
    expect(turnCause(failure('unknown', 'exit code 1: Selected model is at capacity'))).toBe('other');
    expect(jobDone('job', { ...ended, output: 'Selected model is at capacity' }, []).failure).toBeUndefined();
  });
});
