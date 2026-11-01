import { describe, expect, it } from 'vitest';
import fixture from './fixtures/kimi-native-2.4.1.json' with { type: 'json' };
import { projectNativeRecord } from '../src/terminal/native-records.js';

const time = 1793518200000;
const quota = fixture.cases[0].payload;
const prompt = { type: 'turn.prompt', agentId: 'main', turnId: 6, promptId: 'synthetic-input', time };
const ended = { type: 'turn.ended', agentId: 'main', turnId: 6, reason: 'failed', error: quota, time: time + 1000 };

describe('pinned Kimi native metadata projection, without runtime or job authority', () => {
  it('keeps source record type, exact IDs, numeric event time and nested error metadata', () => {
    expect(projectNativeRecord({ ...prompt, input: [{ text: 'private input' }], origin: { kind: 'user' } })).toEqual(prompt);
    const { message: _message, ...error } = quota;
    expect(projectNativeRecord({ ...ended, durationMs: 1000, traceId: 'separate-root-trace' })).toEqual({
      ...ended, error, durationMs: 1000, traceId: 'separate-root-trace',
    });
  });

  it.each(fixture.cases)('preserves the distinct $name serializer payload without its message', ({ payload }) => {
    const { message: _message, ...error } = payload;
    expect(projectNativeRecord({ ...ended, error: payload })).toEqual({ ...ended, error });
  });

  it('preserves absent, null and separate IDs without inventing a join or a start', () => {
    expect(projectNativeRecord({ ...prompt, turnId: undefined, promptId: undefined })).toEqual({
      type: 'turn.prompt', agentId: 'main', time, turnId: undefined, promptId: undefined,
    });
    expect(projectNativeRecord({ ...ended, error: undefined })).toEqual({ ...ended, error: undefined });
    expect(projectNativeRecord({ type: 'metadata', protocol_version: '1.5', created_at: time })).toEqual({
      type: 'metadata', protocol_version: '1.5', created_at: time,
    });
  });

  it.each([
    { ...ended, time: '2026-11-01T10:00:00Z' },
    { ...ended, turnId: '6' },
    { ...ended, turnId: -1 },
    { ...ended, turnId: 1.5 },
    { ...ended, time: NaN },
    { ...ended, time: -1 },
    { ...ended, reason: 'unknown' },
    { ...ended, agentId: '' },
    { ...ended, error: { ...quota, retryable: undefined }, retryable: false },
    { ...ended, error: { ...quota, details: { statusCode: '429' } } },
    { ...ended, type: 'turn.started' },
    { type: 'event', event: ended },
    { kind: 'turn.ended', ...Object.fromEntries(Object.entries(ended).filter(([key]) => key !== 'type')) },
    { type: 'full_compaction', message: 'quota exceeded' },
    { type: 'content.part', text: JSON.stringify(ended) },
    null,
  ])('does not normalize unsupported or malformed record %# into the qualified source shape', value => {
    expect(projectNativeRecord(value)).toBeNull();
  });

  it('strips content, credentials, exception detail and claimed authority from every level', () => {
    const canary = 'SYNTHETIC-PRIVATE-62';
    const value = projectNativeRecord({
      ...ended, source: { version: '2.4.1', trusted: true }, quotaRefusal: { kind: 'provider_quota' },
      jobId: canary, sessionId: canary, authorization: canary, content: canary, reasoning: canary,
      error: { ...quota, message: canary, stack: canary, cause: { message: canary }, details: {
        ...quota.details, token: canary, path: canary, request: { headers: { Authorization: canary } },
      } },
    });
    expect(value).toEqual({ ...ended, error: {
      name: quota.name, code: quota.code, retryable: quota.retryable, details: quota.details,
    } });
    expect(JSON.stringify(value)).not.toContain(canary);
    expect(JSON.stringify(value)).not.toContain('quotaRefusal');
  });

  it('keeps projected metadata immutable and distinguishes missing IDs from explicit null', () => {
    const value = projectNativeRecord(ended);
    expect(Object.isFrozen(value)).toBe(true);
    if (value?.type !== 'turn.ended') throw new Error('Missing synthetic ended projection.');
    expect(Object.isFrozen(value.error)).toBe(true);
    expect(Object.isFrozen(value.error?.details)).toBe(true);
    const omitted = projectNativeRecord({ ...ended, error: { code: 'internal', retryable: false } });
    expect(omitted).toEqual({ ...ended, error: { code: 'internal', retryable: false } });
    expect(JSON.stringify(omitted)).not.toContain('requestId');
  });

  it('does not promote protocol metadata, supplied versions or repeated trace IDs to authority', () => {
    expect(projectNativeRecord({ type: 'metadata', protocol_version: 'unknown', created_at: time, trusted: true })).toEqual({
      type: 'metadata', protocol_version: 'unknown', created_at: time,
    });
    const changed = { ...ended, turnId: 7, version: '2.4.1', sourceCommit: fixture.sourceCommit };
    expect(projectNativeRecord(changed)).toMatchObject({ turnId: 7, error: { details: { requestId: null, traceId: 'synthetic-trace-72' } } });
    expect(JSON.stringify(projectNativeRecord(changed))).not.toContain(fixture.sourceCommit);
  });
});
