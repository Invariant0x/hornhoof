import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agyTranscript } from '../src/providers/antigravity-terminal.js';
import { agySteps } from '../src/terminal/transcripts.js';

const lines = readFileSync(new URL('./fixtures/agy-tui/transcript.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));

describe('Antigravity terminal transcripts', () => {
  it('finds the transcript only under the agent home and conversation', () => {
    expect(agyTranscript('/home/agent', 'conversation-1')).toBe('/home/agent/.gemini/antigravity-cli/brain/conversation-1/.system_generated/logs/transcript_full.jsonl');
    expect(agyTranscript('/home/agent', '../other')).toBeNull();
  });

  it('reads the real two turns as tool, result and text, keeping the active tool until its result', () => {
    const read = agySteps();
    const news = lines.map(read);
    expect(news.flatMap(n => n.events)).toEqual([
      { kind: 'tool', name: 'run_command', input: 'sleep 8; echo slept' },
      { kind: 'tool_result', ok: true, summary: lines[2].content },
      { kind: 'text', text: 'FINISHED' }, { kind: 'text', text: 'BANANA' },
    ]);
    expect(news[1].began).toEqual([{ id: '1:0', name: 'run_command' }]);
    expect(news[2].ended).toEqual(['1:0']);
    expect(news.filter(n => n.events.length === 0)).toHaveLength(2);
  });

  it("drops an interrupted turn's pending calls at the next user input", () => {
    const read = agySteps();
    read(lines[1]);
    expect(read(lines[4]).ended).toEqual(['1:0']);
    expect(read({ type: 'GENERIC', content: 'unrelated' }).events).toEqual([]);
  });

  it('pairs multiple calls with results in order and ignores unrelated steps', () => {
    const read = agySteps();
    for (const line of [null, 42, {}, { type: 'UNKNOWN', content: 'skip' }, { type: 'GENERIC', content: 'unrelated' }]) expect(read(line).events).toEqual([]);
    expect(read({ step_index: 8, type: 'PLANNER_RESPONSE', content: 'Working.', tool_calls: [
      { name: 'mcp__hornhoof__ping', args: { note: 'hi' } }, { name: 'run_command', args: { CommandLine: 'false' } },
    ] }).events).toEqual([
      { kind: 'text', text: 'Working.' }, { kind: 'tool', name: 'hornhoof.ping', input: '{"note":"hi"}' }, { kind: 'tool', name: 'run_command', input: 'false' },
    ]);
    expect(read({ type: 'GENERIC', status: 'DONE', content: 'pong' }).ended).toEqual(['8:0']);
    expect(read({ type: 'GENERIC', status: 'ERROR', content: 'failed' }).events).toEqual([{ kind: 'tool_result', ok: false, summary: 'failed' }]);
    expect(read({ type: 'GENERIC', content: 'unrelated' }).events).toEqual([]);
  });
  it('publishes a completed planner step only once when the transcript repeats it', () => {
    const read = agySteps();
    const step = { step_index: 8, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Using dev-security-review.', tool_calls: [{ name: 'view_file', args: {} }] };
    expect(read(step).events).toHaveLength(2);
    expect(read(step)).toEqual({ events: [], began: [], ended: [] });
    expect(read({ step_index: 9, type: 'GENERIC', status: 'DONE', content: 'source' }).ended).toEqual(['8:0']);
    expect(read({ step_index: 10, type: 'GENERIC', status: 'DONE', content: 'unrelated' }).events).toEqual([]);
  });

  it('keeps a running tool pending until its completed result', () => {
    const read = agySteps();
    read({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'view_file', args: {} }] });
    expect(read({ step_index: 2, type: 'GENERIC', status: 'RUNNING', content: 'Reading' })).toEqual({ events: [], began: [], ended: [] });
    expect(read({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'source' }).ended).toEqual(['1:0']);
  });

  it('allows step indexes to repeat after the next user input', () => {
    const read = agySteps();
    read({ type: 'USER_INPUT', step_index: 0, content: 'First' });
    read({ type: 'PLANNER_RESPONSE', step_index: 1, status: 'DONE', content: 'First answer' });
    read({ type: 'USER_INPUT', step_index: 0, content: 'Second' });
    expect(read({ type: 'PLANNER_RESPONSE', step_index: 1, status: 'DONE', content: 'Second answer' }).events).toEqual([{ kind: 'text', text: 'Second answer' }]);
  });

  it('ignores a replayed input without closing its tool or replaying its planner response', () => {
    const read = agySteps();
    const input = { type: 'USER_INPUT', step_index: 0, status: 'DONE', content: 'Review this file' };
    const response = { type: 'PLANNER_RESPONSE', step_index: 1, status: 'DONE', content: 'Using dev-security-review.', tool_calls: [{ name: 'view_file', args: {} }] };
    read(input);
    read(response);
    expect(read(input)).toEqual({ events: [], began: [], ended: [] });
    expect(read(response)).toEqual({ events: [], began: [], ended: [] });
    expect(read({ type: 'GENERIC', step_index: 2, status: 'DONE', content: 'source' }).ended).toEqual(['1:0']);
  });

  it('closes a backgrounded running tool at the next planner response so a later failed MCP call closes itself', () => {
    const read = agySteps();
    expect(read({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }] }).began).toEqual([
      { id: '1:0', name: 'run_command' },
    ]);
    expect(read({ step_index: 2, type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task' })).toEqual({
      events: [],
      began: [],
      ended: [],
    });
    const next = read({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'call_mcp_tool', args: { ServerName: 'hornhoof', ToolName: 'track_work', Arguments: { task: 12 } } }],
    });
    expect(next.ended).toEqual(['1:0']);
    expect(next.began).toEqual([{ id: '3:0', name: 'call_mcp_tool' }]);
    const failed = read({ step_index: 4, type: 'GENERIC', status: 'ERROR', content: 'Encountered error in step execution: task is paused' });
    expect(failed.ended).toEqual(['3:0']);
    expect(failed.events).toEqual([{ kind: 'tool_result', ok: false, summary: 'Encountered error in step execution: task is paused' }]);
    const final = read({ step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Recorded progress.' });
    expect(final).toEqual({ events: [{ kind: 'text', text: 'Recorded progress.' }], began: [], ended: [], answered: true });
  });

  it('closes a tool call whose result never arrived once the planner answers', () => {
    const read = agySteps();
    expect(read({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'call_mcp_tool', args: { ToolName: 'test_run' } }] }).began).toEqual([
      { id: '1:0', name: 'call_mcp_tool' },
    ]);
    const final = read({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Finished.' });
    expect(final).toEqual({ events: [{ kind: 'text', text: 'Finished.' }], began: [], ended: ['1:0'], answered: true });
  });

});
