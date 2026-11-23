import { describe, expect, it } from 'vitest';
import { TurnEnds, agyHookSession, claudeEnd, foreignAgyHook, hookCalls, keepsAgySession, stopIsLate, stopSession } from '../src/terminal/turn-signals.js';
import { kimiWire } from '../src/terminal/transcripts.js';
import { ProgramWatch, programState } from '../src/terminal/program-state.js';
import hooks from './fixtures/turn-hooks.json' with { type: 'json' };
import retry from './fixtures/kimi-retry.json' with { type: 'json' };

describe('one end from two channels', () => {
  it.each([['done', 'failed'], ['failed', 'done']] as const)('keeps the first %s end and diagnoses a later %s once', (first, later) => {
    const ends = new TurnEnds();
    ends.begin(); ends.started('turn-1');
    expect(ends.end(first, true, 'turn-1')).toEqual({ accept: true, conflict: false });
    expect(ends.end(first, true, 'turn-1')).toEqual({ accept: false, conflict: false });
    expect(ends.end(later, true, 'turn-1')).toEqual({ accept: false, conflict: true });
    expect(ends.end(later, true, 'turn-1')).toEqual({ accept: false, conflict: false });
  });
  it('keeps ends before a prompt with the last turn and matches Codex turn ids', () => {
    const ends = new TurnEnds();
    ends.begin(); ends.started('old'); ends.end('done', true, 'old');
    ends.begin();
    expect(ends.end('failed', false, 'old')).toEqual({ accept: false, conflict: true });
    ends.started('new');
    expect(ends.end('failed', true, 'old').accept).toBe(false);
    expect(ends.end('done', true, 'new').accept).toBe(true);
  });
  it('closes Claude from turn_duration, using its API error or answer', () => {
    expect(claudeEnd({ type: 'system', subtype: 'turn_duration' }, 'Answer', null)).toEqual({ status: 'done', message: 'Answer' });
    const error = { kind: 'auth' as const, text: 'Invalid API key', retryable: false };
    expect(claudeEnd({ type: 'system', subtype: 'turn_duration' }, 'Invalid API key', error)).toEqual({ status: 'failed', message: '', failure: error });
    expect(claudeEnd({ type: 'user' }, '', null)).toBeNull();
  });
});

describe('whose a stop hook is', () => {
  const left = new Set(['old']);
  it.each([
    ['before the running turn took its prompt, from any session', { promptIn: false, from: 'new', session: 'new', left }, true],
    ['before the running turn took its prompt, from no session', { promptIn: false, from: undefined, session: null, left }, true],
    ['from a session the agent left', { promptIn: true, from: 'old', session: 'new', left }, true],
    ['from the session the agent is in', { promptIn: true, from: 'new', session: 'new', left }, false],
    ['from a session the agent left and went back to', { promptIn: true, from: 'old', session: 'old', left }, false],
    ['from a session the host has not heard of, as a cleared conversation goes on in', { promptIn: true, from: 'unknown', session: 'new', left }, false],
    ['from a program that names no session', { promptIn: true, from: undefined, session: 'new', left }, false],
    ["that answers a person's own words, sent while the prompt waited", { promptIn: false, answersPerson: true, from: 'new', session: 'new', left }, false],
  ])('%s', (_, stop, late) => {
    expect(stopIsLate(stop)).toBe(late);
  });

  it('tells Antigravity main conversation hooks apart from subagent and left conversations', () => {
    expect(agyHookSession({ conversationId: ' main ' })).toBe('main');
    expect(agyHookSession({ conversationId: '  ', session_id: 'fallback' })).toBe('fallback');
    expect(agyHookSession({ conversationId: 42 })).toBeNull();
    expect(stopSession('antigravity', { conversationId: 'main' })).toBe('main');
    expect(stopSession('claude', { session_id: 'c1', conversationId: 'ignored' })).toBe('c1');

    expect(foreignAgyHook('claude', 'main', left, { conversationId: 'sub' })).toBe(false);
    expect(foreignAgyHook(undefined, 'main', left, { conversationId: 'sub' })).toBe(false);
    expect(foreignAgyHook('antigravity', 'main', left, {})).toBe(false);
    expect(foreignAgyHook('antigravity', 'main', left, { conversationId: 'main' })).toBe(false);
    expect(foreignAgyHook('antigravity', 'main', left, { conversationId: 'sub' })).toBe(true);
    expect(foreignAgyHook('antigravity', 'main', left, { session_id: 'sub' })).toBe(true);
    expect(foreignAgyHook('antigravity', null, left, { conversationId: 'old' })).toBe(true);
    expect(foreignAgyHook('antigravity', null, left, { conversationId: 'fresh' })).toBe(false);
    expect(keepsAgySession('antigravity', 'main')).toBe(true);
    expect(keepsAgySession('antigravity', null)).toBe(false);
    expect(keepsAgySession('claude', 'main')).toBe(false);
  });
});

describe('tool and retry evidence', () => {
  it.each(hooks.filter(h => ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(h.event)))('$program $event uses the log call id', ({ event, input }) => {
    const calls = hookCalls(event === 'PreToolUse' ? 'tool' : event === 'PostToolUseFailure' ? 'toolfail' : 'tooldone', input);
    const id = 'tool_call_id' in input ? input.tool_call_id : input.tool_use_id;
    expect(calls).toEqual(event === 'PreToolUse' ? { began: [{ id, name: input.tool_name }], ended: [] } : { began: [], ended: [id] });
  });
  it('reads the measured Kimi retry fields without rounding nextAt below the delay', () => {
    expect(kimiWire(retry).retry).toEqual({ attempt: retry.failedAttempt, max: retry.maxAttempts, delayMs: retry.delayMs });
    expect(programState('screen', null, true, { attempt: 1, max: 10, nextAt: 2000 })).toBe('retrying');
    expect(programState('screen', { name: 'Bash', at: 1 }, true, { attempt: 1, max: 10, nextAt: 2000 })).toBe('tool');
  });
  it('reports signs of life and retry separately from screen changes', () => {
    const sent: unknown[] = [];
    const watch = new ProgramWatch('job', m => sent.push(m), 100);
    watch.look(1000, 'screen', null, true, 950, { attempt: 1, max: 10, nextAt: 1500 });
    watch.look(1100, 'screen', null, true, 1050, null);
    expect(sent).toEqual([
      expect.objectContaining({ state: 'retrying', screenAt: 1000, signAt: 950, retry: { attempt: 1, max: 10, nextAt: 1500 } }),
      expect.objectContaining({ state: 'thinking', screenAt: 1000, signAt: 1050 }),
    ]);
    expect(sent[1]).not.toHaveProperty('retry');
  });
});

it('includes the last sign on a gone report even before the first screen look', () => {
  const sent: unknown[] = [];
  const watch = new ProgramWatch('job', m => sent.push(m));
  watch.gone(1200, { code: 3, signal: null }, 'exit', 1150);
  expect(sent).toEqual([expect.objectContaining({ state: 'gone', signAt: 1150 })]);
});

it('diagnoses an identified late end even after two newer turns', () => {
  const ends = new TurnEnds();
  for (const id of ['old', 'middle', 'new']) {
    ends.begin(); ends.started(id); ends.end('done', true, id);
  }
  expect(ends.end('failed', false, 'old')).toEqual({ accept: false, conflict: true });
  expect(ends.end('failed', false, 'old')).toEqual({ accept: false, conflict: false });
});
