import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeStatusContext, claudeStatusLimits, claudeUsageLimits, codexRollout, kimiUsageLimits, kimiWire, LineTail } from '../src/terminal/transcripts.js';

const item = (it: object) => ({ type: 'event_msg', payload: { type: 'item_completed', item: it } });
const loop = (event: object) => ({ type: 'context.append_loop_event', agentId: 'main', event, time: 1 });

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

  it('reads how full its context is as its own screen counts it, past the part every session starts with', () => {
    const info = { last_token_usage: { total_tokens: 112_000 }, total_token_usage: { total_tokens: 900_000 }, model_context_window: 212_000 };
    expect(codexRollout({ type: 'event_msg', payload: { type: 'token_count', info, rate_limits: null } })).toEqual({ events: [], context: 0.5 });
    expect(codexRollout({ type: 'event_msg', payload: { type: 'token_count', info: { ...info, last_token_usage: { total_tokens: 5000 } }, rate_limits: null } }).context).toBe(0);
    expect(codexRollout({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } })).toEqual({ events: [] });
  });

  it('leaves out what people need not see', () => {
    expect(codexRollout({ type: 'response_item', payload: { type: 'message', role: 'developer' } })).toEqual({ events: [] });
    expect(codexRollout('nonsense')).toEqual({ events: [] });
  });
});

describe("Kimi Code's session log", () => {
  it('shows its text, tool calls and their results, without its thinking', () => {
    expect(kimiWire(loop({ type: 'content.part', turnId: '0', step: 1, part: { type: 'text', text: 'Fixing the build.' } }))).toEqual({ events: [{ kind: 'text', text: 'Fixing the build.' }] });
    expect(kimiWire(loop({ type: 'content.part', turnId: '0', step: 1, part: { type: 'think', think: 'Hmm.' } }))).toEqual({ events: [] });
    expect(kimiWire(loop({ type: 'tool.call', toolCallId: 'c1', name: 'Bash', args: { command: 'npm test' } })).events).toEqual([{ kind: 'tool', name: 'Bash', input: 'npm test' }]);
    expect(kimiWire(loop({ type: 'tool.call', toolCallId: 'c2', name: 'mcp__hornhoof__move_task', args: { task: 4 } })).events).toEqual([{ kind: 'tool', name: 'hornhoof.move_task', input: '{"task":4}' }]);
    expect(kimiWire(loop({ type: 'tool.result', toolCallId: 'c1', result: { output: '12 passed', isError: false } })).events).toEqual([{ kind: 'tool_result', ok: true, summary: '12 passed' }]);
    expect(kimiWire(loop({ type: 'tool.result', toolCallId: 'c2', result: { output: [{ type: 'text', text: 'No such task.' }], isError: true } })).events).toEqual([
      { kind: 'tool_result', ok: false, summary: 'No such task.' },
    ]);
  });

  it("tells how many tokens the main agent's context holds now", () => {
    expect(kimiWire({ type: 'token_counting.measured', agentId: 'main', length: 4, tokens: 50_000 })).toEqual({ events: [], tokens: 50_000 });
    expect(kimiWire({ type: 'token_counting.rebased', agentId: 'main', length: 2, tokens: 9000, measured: false })).toEqual({ events: [], tokens: 9000 });
    expect(kimiWire({ type: 'token_counting.measured', agentId: 'sub-1', length: 4, tokens: 70_000 })).toEqual({ events: [] });
    /* A person picked another model with /model, whose context is another size. */
    expect(kimiWire({ type: 'config.update', agentId: 'main', modelAlias: 'kimi-code/k3' })).toEqual({ events: [], model: 'kimi-code/k3' });
    expect(kimiWire({ type: 'config.update', agentId: 'main', thinkingEffort: 'high' })).toEqual({ events: [] });
  });

  it('tells when a turn starts, ends, was stopped or failed', () => {
    expect(kimiWire({ type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: 'hi' }], origin: { kind: 'user' } })).toEqual({ events: [], started: true });
    expect(kimiWire({ type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed' })).toEqual({ events: [], ended: true });
    expect(kimiWire({ type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'cancelled' })).toEqual({ events: [], aborted: true });
    expect(kimiWire(loop({ type: 'step.begin', turnId: '1', step: 2 }))).toEqual({ events: [], step: true });
    expect(kimiWire({ type: 'prompt.completed', agentId: 'main', promptId: 'p1', reason: 'completed' })).toEqual({ events: [] });
    expect(kimiWire({ type: 'prompt.completed', agentId: 'main', promptId: 'p2', reason: 'blocked' })).toEqual({ events: [], failed: 'A hook in Kimi Code blocked this message.', blocked: true });
    expect(kimiWire({ type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'failed', error: { name: 'APIError', message: 'Quota exceeded.' } })).toEqual({ events: [], failed: 'Quota exceeded.' });
    expect(kimiWire({ type: 'turn.ended', agentId: 'main', turnId: 3, reason: 'blocked' })).toEqual({ events: [], failed: 'blocked' });
  });

  it("leaves out bookkeeping and other agents' turns", () => {
    expect(kimiWire({ type: 'metadata', protocol_version: '1.5' })).toEqual({ events: [] });
    expect(kimiWire({ type: 'usage.record', agentId: 'main' })).toEqual({ events: [] });
    expect(kimiWire({ type: 'turn.ended', agentId: 'sub-1', turnId: 0, reason: 'completed' })).toEqual({ events: [] });
    expect(kimiWire('nonsense')).toEqual({ events: [] });
  });

  it("reads the plan's limits Kimi's usage page gives", () => {
    expect(kimiUsageLimits({ usages: { limit_5h: { used_ratio: 0.25, reset_time: '2026-10-31T03:00:00Z' }, limit_7d: { used_ratio: '1', reset_time: '2026-11-04T00:00:00Z' } } })).toEqual({
      status: 'rejected',
      windows: [
        { name: 'five_hour', utilization: 0.25, resetsAt: '2026-10-31T03:00:00.000Z' },
        { name: 'seven_day', utilization: 1, resetsAt: '2026-11-04T00:00:00.000Z' },
      ],
    });
    expect(kimiUsageLimits({ usages: { limit_5h: { used_ratio: 0.1 } } })).toEqual({ status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.1, resetsAt: null }] });
    /* A plan with monthly limits, as Kimi's page answers for one: the fuller month speaks for both. */
    const monthly = {
      limit_5h: { used_ratio: 0.8923, reset_time: '2026-10-31T03:12:51Z' },
      limit_month_total: { used_ratio: 0.055, reset_time: '2026-12-01T00:00:00Z' },
      limit_month_code: { used_ratio: 0.0543, reset_time: '2026-12-01T00:00:00Z' },
    };
    expect(kimiUsageLimits({ usages: monthly })).toEqual({
      status: 'allowed',
      windows: [
        { name: 'five_hour', utilization: 0.8923, resetsAt: '2026-10-31T03:12:51.000Z' },
        { name: 'month', utilization: 0.055, resetsAt: '2026-12-01T00:00:00.000Z' },
      ],
    });
    expect(kimiUsageLimits({ error: 'nope' })).toBeNull();
  });

  it("reads the plan's limits Claude's usage page gives, in percent", () => {
    const page = {
      five_hour: { utilization: 16, resets_at: '2026-10-31T02:50:00.895244+00:00', limit_dollars: null },
      seven_day: { utilization: 100, resets_at: '2026-11-01T07:00:00.895267+00:00' },
      seven_day_opus: null,
      extra_usage: { is_enabled: false, utilization: null },
    };
    expect(claudeUsageLimits(page)).toEqual({
      status: 'rejected',
      windows: [
        { name: 'five_hour', utilization: 0.16, resetsAt: '2026-10-31T02:50:00.895Z' },
        { name: 'seven_day', utilization: 1, resetsAt: '2026-11-01T07:00:00.895Z' },
      ],
    });
    expect(claudeUsageLimits({ five_hour: { utilization: 3, resets_at: null }, seven_day: null })).toEqual({ status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.03, resetsAt: null }] });
    expect(claudeUsageLimits({ error: { type: 'authentication_error' } })).toBeNull();
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

  it('gives how full the context is', () => {
    expect(claudeStatusContext({ context_window: { used_percentage: 42.5, context_window_size: 200_000 } })).toBe(0.425);
    expect(claudeStatusContext({ context_window: { used_percentage: null } })).toBeNull();
    expect(claudeStatusContext({ model: {} })).toBeNull();
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
