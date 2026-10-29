import { describe, expect, it } from 'vitest';
import { parseNodeMessage, parseServerMessage, type NodeMessage, type ServerMessage } from '../src/index.js';

const LIMITS = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.38, resetsAt: '2026-10-29T21:30:00.000Z' }] };

const NODE: NodeMessage[] = [
  { type: 'hello', version: '0.2.0', loggedIn: true, running: ['job-1'] },
  { type: 'status', loggedIn: false, limits: LIMITS },
  { type: 'status', loggedIn: true, limits: null },
  { type: 'job.started', jobId: 'job-1' },
  { type: 'job.done', jobId: 'job-1', ok: true, sessionId: 'abc', result: 'ready', tail: '', error: null },
  { type: 'job.done', jobId: 'job-2', ok: false, sessionId: null, result: '', tail: 'boom', error: 'timeout' },
  { type: 'removed' },
];

const SERVER: ServerMessage[] = [
  { type: 'job.run', jobId: 'job-1', subscriptionId: 's1', provider: 'claude', prompt: 'Reply with one word: ready', sessionId: null, model: null, timeoutMs: 120000, secret: null },
  { type: 'job.run', jobId: 'job-2', subscriptionId: 's2', provider: 'openai_api', prompt: 'hi', sessionId: 'thread', model: 'gpt-5', timeoutMs: 1000, secret: 'sk-test' },
  { type: 'remove' },
];

describe('node messages', () => {
  it('round-trip through JSON', () => {
    for (const m of NODE) expect(parseNodeMessage(JSON.stringify(m))).toEqual(m);
  });

  it('give null for broken JSON, an unknown type or a missing field', () => {
    expect(parseNodeMessage('{nope')).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'hack' }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'job.done', jobId: 'x', ok: true }))).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'status', loggedIn: true, limits: { status: 'fine', windows: [] } }))).toBeNull();
  });
});

describe('server messages', () => {
  it('round-trip through JSON', () => {
    for (const m of SERVER) expect(parseServerMessage(JSON.stringify(m))).toEqual(m);
  });

  it('give null for a job without a timeout or an unknown provider', () => {
    const { timeoutMs: _, ...noTimeout } = SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>;
    expect(parseServerMessage(JSON.stringify(noTimeout))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...SERVER[0], provider: 'gemini' }))).toBeNull();
    expect(parseServerMessage('null')).toBeNull();
  });
});
