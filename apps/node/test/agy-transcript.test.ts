import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { agyTranscript } from '../src/terminal/programs.js';
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
});
