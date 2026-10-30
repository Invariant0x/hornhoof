import { describe, expect, it } from 'vitest';
import { cut, DEPARTMENT_TEMPLATES, parseNodeMessage, parseServerMessage, type AgentEvent, type NodeMessage, type ServerMessage } from '../src/index.js';

const LIMITS = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.38, resetsAt: '2026-10-29T21:30:00.000Z' }] };

const NODE: NodeMessage[] = [
  { type: 'hello', version: '0.2.0', loggedIn: true, running: ['job-1'] },
  { type: 'status', loggedIn: false, limits: LIMITS },
  { type: 'status', loggedIn: true, limits: null },
  { type: 'job.started', jobId: 'job-1' },
  { type: 'job.done', jobId: 'job-1', ok: true, sessionId: 'abc', result: 'ready', tail: '', error: null },
  { type: 'job.done', jobId: 'job-2', ok: false, sessionId: null, result: '', tail: 'boom', error: 'timeout' },
  { type: 'removed' },
  { type: 'job.event', jobId: 'job-1', seq: 0, event: { kind: 'text', text: 'Hello' } },
  { type: 'job.event', jobId: 'job-1', seq: 1, event: { kind: 'tool', name: 'propose_structure', input: '{"brief":"Shoes"}' } },
  { type: 'job.event', jobId: 'job-1', seq: 2, event: { kind: 'tool_result', ok: true, summary: 'Proposal p1 shown' } },
  { type: 'job.event', jobId: 'job-1', seq: 3, event: { kind: 'todo', items: [{ text: 'Ask about products', state: 'done' }, { text: 'Propose', state: 'doing' }] } },
];

const SERVER: ServerMessage[] = [
  { type: 'job.run', jobId: 'job-1', subscriptionId: 's1', provider: 'claude', prompt: 'Reply with one word: ready', sessionId: null, model: null, timeoutMs: 120000, secret: null, instructions: null, toolToken: null },
  { type: 'job.run', jobId: 'job-2', subscriptionId: 's2', provider: 'openai_api', prompt: 'hi', sessionId: 'thread', model: 'gpt-5', timeoutMs: 1000, secret: 'sk-test', instructions: 'You are the orchestrator.', toolToken: 'tok' },
  { type: 'job.cancel', jobId: 'job-1' },
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

  it('give null for ids that could leave the node folder, since the node puts them in paths', () => {
    for (const id of ['../../etc', 'a/b', '', 'x'.repeat(65)]) {
      expect(parseServerMessage(JSON.stringify({ ...SERVER[0], jobId: id }))).toBeNull();
      expect(parseServerMessage(JSON.stringify({ ...SERVER[0], subscriptionId: id }))).toBeNull();
    }
  });
});

describe('live agent events', () => {
  const event = (e: unknown) => parseNodeMessage(JSON.stringify({ type: 'job.event', jobId: 'job-1', seq: 0, event: e }));

  it('refuse a tool input longer than 300 characters', () => {
    expect(event({ kind: 'tool', name: 'Bash', input: 'x'.repeat(300) })).not.toBeNull();
    expect(event({ kind: 'tool', name: 'Bash', input: 'x'.repeat(301) })).toBeNull();
  });

  it('refuse an unknown kind, a negative seq and an unknown todo state', () => {
    expect(event({ kind: 'thinking', text: 'hm' })).toBeNull();
    expect(parseNodeMessage(JSON.stringify({ type: 'job.event', jobId: 'job-1', seq: -1, event: { kind: 'text', text: 'a' } }))).toBeNull();
    expect(event({ kind: 'todo', items: [{ text: 'a', state: 'later' }] })).toBeNull();
  });

  it('keep at most 20 plan items', () => {
    const items = (n: number): AgentEvent => ({ kind: 'todo', items: Array.from({ length: n }, (_, i) => ({ text: `step ${i}`, state: 'todo' as const })) });
    expect(event(items(20))).not.toBeNull();
    expect(event(items(21))).toBeNull();
  });
});

describe('calling a job off', () => {
  it('refuses an id with a slash', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'job.cancel', jobId: 'a/b' }))).toBeNull();
  });
});

describe('job.run', () => {
  it('needs instructions and a tool token, even when they are null', () => {
    const { instructions: _, ...noInstructions } = SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>;
    const { toolToken: __, ...noToken } = SERVER[0] as Extract<ServerMessage, { type: 'job.run' }>;
    expect(parseServerMessage(JSON.stringify(noInstructions))).toBeNull();
    expect(parseServerMessage(JSON.stringify(noToken))).toBeNull();
  });
});

describe('department templates', () => {
  it('are the eight starting departments, with operations always on', () => {
    expect(DEPARTMENT_TEMPLATES.map(t => t.key)).toEqual(['operations', 'development', 'marketing', 'sales', 'business_development', 'design', 'support', 'finance']);
    expect(DEPARTMENT_TEMPLATES.filter(t => t.always).map(t => t.key)).toEqual(['operations']);
    expect(DEPARTMENT_TEMPLATES.filter(t => t.ticked).map(t => t.key)).toEqual(['operations', 'development', 'marketing', 'sales', 'business_development']);
  });
});

describe('cut', () => {
  it('keeps short text and ends cut text with an ellipsis', () => {
    expect(cut('abcdef', 4)).toBe('abc…');
    expect(cut('abc', 4)).toBe('abc');
    expect(cut('abcd', 4)).toBe('abcd');
  });
});
