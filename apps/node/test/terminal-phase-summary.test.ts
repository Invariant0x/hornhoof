import { parseNodeMessage } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { jobDone } from '../src/runner.js';

const ATTEMPT = '00000000-0000-4000-8000-000000000074';
const summary = { attemptId: ATTEMPT, seq: 16, phase: 'done' as const, finish: 'pane_query_failed' as const, durable: false, code: 'record_limit' as const };
const warning = 'Output capture did not finish before the wait expired.';
const last = 'Program ended: code 3, signal none, at 2026-11-01T00:00:00.000Z';
const raw = Array.from({ length: 80 }, (_, index) => `ordinary-${index} ${'x'.repeat(100)}`).join('\n');

function rendered(phaseSummary: unknown = summary, secrets: string[] = []) {
  return jobDone('phase-summary-job', {
    ok: false, sessionId: null, result: '', output: 'pre-rendered output is not the raw capture', error: 'agent_failed', limits: null,
    programOutput: { text: raw, code: 3, signal: null, at: '2026-11-01T00:00:00.000Z', complete: false }, phaseSummary,
  }, secrets);
}

describe('terminal phase in the shared job completion boundary', () => {
  it('keeps missing identity and finish explicitly unknown in a bounded ASCII footer', () => {
    const done = rendered({ ...summary, attemptId: null, seq: 0, phase: 'launch', finish: null, code: 'not_saved' });
    const line = done.tail.split('\n').find(value => value.startsWith('hh-terminal-phase-v1'));
    expect(line).toContain('attempt=unknown');
    expect(line).toContain('finish=unknown');
    expect(line).toMatch(/^[\x20-\x7e]+$/);
    expect(Buffer.byteLength(line!)).toBeLessThanOrEqual(160);
    expect(Buffer.byteLength(done.tail.slice(done.tail.indexOf('hh-terminal-phase-v1')))).toBeLessThanOrEqual(400);
    expect(done.tail.endsWith(last)).toBe(true);
  });

  it('keeps phase, incomplete warning and the trusted final line together in the final 400 characters', () => {
    const done = rendered();
    expect(Buffer.byteLength(raw)).toBeGreaterThan(4096);
    expect(raw.split('\n')).toHaveLength(80);
    expect(done.tail).toContain('hh-terminal-phase-v1');
    expect(done.tail).toContain(`attempt=${ATTEMPT}`);
    expect(done.tail.slice(-400)).toContain('code=record_limit');
    expect(done.tail.indexOf('hh-terminal-phase-v1')).toBeLessThan(done.tail.indexOf(warning));
    expect(done.tail.endsWith(`${warning}\n${last}`)).toBe(true);
    expect(Buffer.byteLength(done.tail)).toBeLessThanOrEqual(4096);
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(parseNodeMessage(JSON.stringify(done))).toEqual(done);
    expect('phaseSummary' in done).toBe(false);
  });

  it('adds phase after selecting fifty raw lines, without spending a raw line on metadata', () => {
    const done = jobDone('short-capture', { ok: false, sessionId: null, result: '', output: '', error: 'agent_failed', limits: null,
      programOutput: { text: Array.from({ length: 70 }, (_, i) => `line-${i}`).join('\n'), code: 3, signal: null, at: '2026-11-01T00:00:00.000Z', complete: false }, phaseSummary: summary }, []);
    expect(done.tail.split('\n').filter(line => line.startsWith('line-'))).toHaveLength(50);
    expect(done.tail).toContain('line-20\n');
    expect(done.tail).toContain('hh-terminal-phase-v1');
    expect(done.tail.endsWith(last)).toBe(true);
  });

  it('redacts the whole metadata line and the whole raw multiline secret before any bounds', () => {
    const secret = 'synthetic-multiline-secret\nsecret-suffix-0123456789';
    const done = jobDone('secret-boundary', { ok: false, sessionId: null, result: '', output: '', error: 'agent_failed', limits: null,
      programOutput: { text: `${secret}\n${Array.from({ length: 49 }, (_, i) => `line-${i}`).join('\n')}`, code: 3, signal: null, at: '2026-11-01T00:00:00.000Z', complete: false }, phaseSummary: { ...summary, unexpected: secret } }, [secret, ATTEMPT]);
    expect(done.tail).not.toContain('secret-suffix');
    expect(done.tail).not.toContain(ATTEMPT);
    expect(done.tail).toContain('attempt=[hidden]');
    expect(done.tail.split('\n').filter(line => line.startsWith('line-'))).toHaveLength(49);
    expect(done.tail.endsWith(last)).toBe(true);
  });

  it.each([
    null, 'raw text', { ...summary, attemptId: '../secret-path' }, { ...summary, seq: 17 }, { ...summary, seq: -1 },
    { ...summary, phase: 'secret-phase' }, { ...summary, finish: 'OOM' }, { ...summary, durable: 'yes' }, { ...summary, code: 'secret-error' },
  ])('ignores an invalid internal DTO instead of reflecting it: %j', value => {
    const done = rendered(value);
    expect(done.tail).not.toContain('hh-terminal-phase-v1');
    expect(done.tail).not.toContain('secret-');
    expect(done.tail.endsWith(last)).toBe(true);
  });

  it('does not create a program exit when only phase evidence exists', () => {
    const done = jobDone('no-exit', { ok: false, sessionId: null, result: '', output: 'original failure', error: 'agent_failed', limits: null, phaseSummary: summary }, []);
    expect(done.tail).toContain('original failure');
    expect(done.tail).not.toContain('Program ended');
    expect(done).toMatchObject({ error: 'agent_failed', ok: false });
  });
});
