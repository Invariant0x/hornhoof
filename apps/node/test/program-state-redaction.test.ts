import type { NodeMessage } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { ProgramWatch } from '../src/terminal/program-state.js';

const SECRET = 'fixture-private-tool-token';
const WORKING = '❯ hello\n✻ Thinking (esc to interrupt)';
const WAITING = '─'.repeat(50) + '\n❯ \n' + '─'.repeat(50);
type Report = Extract<NodeMessage, { type: 'job.program' }>;

describe('program diagnostics leaving the node', () => {
  it('masks every diagnostic string while preserving each state', () => {
    const sent: Report[] = [];
    const watch = new ProgramWatch('job-one', 'claude', m => sent.push(m as Report), 60_000, () => [SECRET, 'AskUserQuestion']);
    watch.look(1, `${SECRET}\n${WORKING}`, null, true);
    watch.look(2, WORKING, { name: `tool-${SECRET}`, at: 2 }, true);
    watch.look(3, WORKING, { name: 'AskUserQuestion', at: 3 }, true);
    watch.look(4, `${SECRET}\n${WAITING}`, null, false);
    watch.gone(5, { code: 3, signal: SECRET }, `Error: ${SECRET}`);
    expect(sent.map(m => m.state)).toEqual(['thinking', 'tool', 'asking', 'idle', 'gone']);
    expect(sent[1]?.tool).toBe('tool-[hidden]');
    expect(sent[2]?.tool).toBe('[hidden]');
    expect(sent[4]).toMatchObject({ screen: 'Error: [hidden]', signal: '[hidden]', exitCode: 3 });
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(JSON.stringify(sent)).not.toContain('AskUserQuestion');
  });

  it('masks whole values before clipping tool names and gone screens', () => {
    const sent: Report[] = [];
    const watch = new ProgramWatch('job-one', 'claude', m => sent.push(m as Report), 60_000, () => [SECRET]);
    watch.look(1, WORKING, { name: 'x'.repeat(90) + SECRET, at: 1 }, true);
    watch.gone(2, null, SECRET + 'y'.repeat(3990));
    expect(sent[0]?.tool).toBe('x'.repeat(90) + '[hidden]');
    expect(sent[1]?.screen).toBe('[hidden]' + 'y'.repeat(3990));
  });

  it('uses current secrets when a confirmed job receives diagnostics collected before its acknowledgement', () => {
    const sent: Report[] = [];
    const secrets: string[] = [];
    const watch = new ProgramWatch(null, 'claude', m => sent.push(m as Report), 60_000, () => secrets);
    watch.look(1, WORKING, { name: SECRET, at: 1 }, true);
    watch.gone(2, { code: 3, signal: null }, `Error: ${SECRET}`);
    expect(sent).toEqual([]);
    secrets.push(SECRET);
    watch.bind('confirmed-job', 3);
    expect(sent).toEqual([{ type: 'job.program', jobId: 'confirmed-job', state: 'gone', since: 2, screenAt: 2, screen: 'Error: [hidden]', exitCode: 3, signal: null }]);
  });

  it('preserves zero tool times and exit codes and measures idle time from a nonzero start', () => {
    const sent: Report[] = [];
    const watch = new ProgramWatch('job-one', 'claude', m => sent.push(m as Report));
    watch.look(10, WORKING, { name: 'Bash', at: 0 }, true);
    expect(sent[0]?.since).toBe(0);
    watch.look(20, WAITING, null, false);
    expect(watch.idleFor(100)).toBe(80);
    watch.gone(110, { code: 0, signal: null }, 'Done');
    expect(sent.at(-1)).toMatchObject({ state: 'gone', exitCode: 0 });
  });
});
