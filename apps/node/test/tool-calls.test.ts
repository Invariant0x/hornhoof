import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CALLS } from '../src/terminal/tool-calls.js';
import { agySteps } from '../src/terminal/transcripts.js';

const lines = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as unknown);
const none = { began: [], ended: [] };

describe('the tool calls a line of a program’s log begins and ends', () => {
  it('reads Claude Code’s calls by their ids, as it logs them', () => {
    expect(lines('claude-tools').map(CALLS.claude)).toEqual([
      none,
      { began: [{ id: 'toolu_015kg76rPSrd3Y4uMc4vkZNp', name: 'hornhoof.ping' }], ended: [] },
      { began: [], ended: ['toolu_015kg76rPSrd3Y4uMc4vkZNp'] },
      none,
      none,
      none,
    ]);
    const ask = { type: 'assistant', message: { content: [{ type: 'text', text: 'One question.' }, { type: 'tool_use', id: 'toolu_2', name: 'AskUserQuestion', input: {} }] } };
    expect(CALLS.claude(ask)).toEqual({ began: [{ id: 'toolu_2', name: 'AskUserQuestion' }], ended: [] });
  });

  it('reads Kimi Code’s calls of its main agent', () => {
    const loop = (event: object, agentId = 'main') => ({ type: 'context.append_loop_event', agentId, event: { turnId: '0', step: 1, ...event } });
    expect(CALLS.kimi(loop({ type: 'tool.call', toolCallId: 'c1', name: 'Bash', args: { command: 'ls' } }))).toEqual({ began: [{ id: 'c1', name: 'Bash' }], ended: [] });
    expect(CALLS.kimi(loop({ type: 'tool.result', toolCallId: 'c1', result: { output: 'a.txt' } }))).toEqual({ began: [], ended: ['c1'] });
    expect(CALLS.kimi(loop({ type: 'tool.call', toolCallId: 'c2', name: 'Bash' }, 'sub-1'))).toEqual(none);
    expect(CALLS.kimi(loop({ type: 'content.part', part: { type: 'text', text: 'hi' } }))).toEqual(none);
  });

  it('reads the Codex items that run a tool, from when they start to when they complete', () => {
    const msg = (type: string, item: object) => ({ type: 'event_msg', payload: { type, item } });
    const command = { type: 'CommandExecution', id: 'i1', command: 'ls' };
    expect(CALLS.codex(msg('item_started', command))).toEqual({ began: [{ id: 'i1', name: 'Bash' }], ended: [] });
    expect(CALLS.codex(msg('item_completed', { ...command, exit_code: 0 }))).toEqual({ began: [], ended: ['i1'] });
    expect(CALLS.codex(msg('item_started', { type: 'McpToolCall', id: 'i2', server: 'hornhoof', tool: 'ping' }))).toEqual({ began: [{ id: 'i2', name: 'hornhoof.ping' }], ended: [] });
    expect(CALLS.codex(msg('item_started', { type: 'FileChange', id: 'i3', changes: {} }))).toEqual({ began: [{ id: 'i3', name: 'Edit' }], ended: [] });
    expect(CALLS.codex(msg('item_started', { type: 'AgentMessage', id: 'i4' }))).toEqual(none);
    expect(CALLS.codex({ type: 'event_msg', payload: { type: 'task_started' } })).toEqual(none);
  });

  it('reads nothing from what is no log line', () => {
    for (const read of Object.values(CALLS)) for (const line of [null, 42, 'text', [], {}]) expect(read(line)).toEqual(none);
  });
});

it('ends an Antigravity tool in ERROR', () => {
  const read = agySteps();
  expect(read({ type: 'PLANNER_RESPONSE', step_index: 3, tool_calls: [{ name: 'run_command', args: { CommandLine: 'make' } }] }).began).toEqual([{ id: '3:0', name: 'run_command' }]);
  expect(read({ type: 'GENERIC', status: 'ERROR', content: 'denied' })).toEqual({ began: [], ended: ['3:0'], events: [{ kind: 'tool_result', ok: false, summary: 'denied' }] });
});
