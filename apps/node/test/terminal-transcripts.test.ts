import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeStatusLimits, codexRollout, LineTail } from '../src/terminal/transcripts.js';

const item = (it: object) => ({ type: 'event_msg', payload: { type: 'item_completed', item: it } });

describe("Codex's session log", () => {
  it('shows its messages, commands, file changes and Hornhoof tool calls', () => {
    expect(codexRollout(item({ type: 'AgentMessage', content: [{ type: 'Text', text: 'Fixing ' }, { type: 'Text', text: 'the build.' }] }))).toEqual({ events: [{ kind: 'text', text: 'Fixing the build.' }] });
    expect(codexRollout(item({ type: 'CommandExecution', command: 'npm test', aggregated_output: '12 passed', exit_code: 0, status: 'completed' })).events).toEqual([
      { kind: 'tool', name: 'Bash', input: 'npm test' },
      { kind: 'tool_result', ok: true, summary: '12 passed' },
    ]);
    expect(codexRollout(item({ type: 'FileChange', changes: { '/w/a.ts': { type: 'update' }, '/w/b.ts': { type: 'add' } }, status: 'completed', stdout: 'Success.' })).events).toEqual([
      { kind: 'tool', name: 'Edit', input: '/w/a.ts, /w/b.ts' },
      { kind: 'tool_result', ok: true, summary: 'Success.' },
    ]);
    expect(codexRollout(item({ type: 'McpToolCall', server: 'hornhoof', tool: 'move_task', arguments: { task: 4 }, status: 'failed', error: { message: 'No such task.' } })).events).toEqual([
      { kind: 'tool', name: 'hornhoof.move_task', input: '{"task":4}' },
      { kind: 'tool_result', ok: false, summary: 'No such task.' },
    ]);
  });

  it('tells when a turn starts and ends, and which session it is', () => {
    expect(codexRollout({ type: 'session_meta', payload: { id: 'th-1', cwd: '/w' } })).toEqual({ events: [], session: { id: 'th-1', cwd: '/w' } });
    expect(codexRollout({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } })).toEqual({ events: [], started: true });
    expect(codexRollout({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Done.' } })).toEqual({ events: [], ended: { message: 'Done.' } });
  });

  it('tells what a person typed and when a person stopped the turn', () => {
    expect(codexRollout(item({ type: 'UserMessage', content: [{ type: 'text', text: 'Fix the build' }] }))).toEqual({ events: [], typed: 'Fix the build' });
    expect(codexRollout({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } })).toEqual({ events: [], aborted: true });
  });

  it('reads the limits it reports, by the length of each window', () => {
    const rate = { primary: { used_percent: 72, window_minutes: 10080, resets_at: 1793774136 }, secondary: { used_percent: 10, window_minutes: 300, resets_at: 1793380000 }, rate_limit_reached_type: null };
    expect(codexRollout({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rate } }).limits).toEqual({
      status: 'allowed',
      windows: [
        { name: 'seven_day', utilization: 0.72, resetsAt: new Date(1793774136000).toISOString() },
        { name: 'five_hour', utilization: 0.1, resetsAt: new Date(1793380000000).toISOString() },
      ],
    });
    expect(codexRollout({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { ...rate, rate_limit_reached_type: 'primary' } } }).limits?.status).toBe('rejected');
  });

  it('leaves out what people need not see', () => {
    expect(codexRollout({ type: 'response_item', payload: { type: 'message', role: 'developer' } })).toEqual({ events: [] });
    expect(codexRollout('nonsense')).toEqual({ events: [] });
  });
});

describe("Claude Code's status line", () => {
  it('gives the five-hour and seven-day windows', () => {
    expect(claudeStatusLimits({ rate_limits: { five_hour: { used_percentage: 11, resets_at: 1793379000 }, seven_day: { used_percentage: 86, resets_at: 1793516400 } } })).toEqual({
      status: 'allowed',
      windows: [
        { name: 'five_hour', utilization: 0.11, resetsAt: new Date(1793379000000).toISOString() },
        { name: 'seven_day', utilization: 0.86, resetsAt: new Date(1793516400000).toISOString() },
      ],
    });
    expect(claudeStatusLimits({ model: {} })).toBeNull();
  });
});

describe('following a log file', () => {
  it('gives each whole line once, and waits for the rest of a line', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hh-tail-')), 'log.jsonl');
    const tail = new LineTail(file);
    expect(tail.read()).toEqual([]);
    writeFileSync(file, '{"a":1}\n{"b"');
    expect(tail.read()).toEqual(['{"a":1}']);
    appendFileSync(file, ':2}\n');
    expect(tail.read()).toEqual(['{"b":2}']);
    expect(tail.read()).toEqual([]);
  });

  it('starts at the end of what a resumed session already wrote', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hh-tail-')), 'log.jsonl');
    writeFileSync(file, '{"old":1}\n');
    const tail = new LineTail(file, { fromEnd: true });
    appendFileSync(file, '{"new":1}\n');
    expect(tail.read()).toEqual(['{"new":1}']);
  });
});
