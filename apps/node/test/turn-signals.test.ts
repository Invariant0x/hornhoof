import { describe, expect, it } from 'vitest';
import { TurnEnds, hookCalls, claudeEnd } from '../src/terminal/turn-signals.js';
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
