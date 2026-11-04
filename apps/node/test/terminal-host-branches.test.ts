import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentEvent, NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { agyProgram, agyTranscript, claudeProgram, claudeTranscript, codexProgram, kimiProgram } from '../src/terminal/programs.js';
import { TurnWords } from '../src/terminal/program-restart.js';
import { agySteps, LineTail } from '../src/terminal/transcripts.js';
import { Tmux } from '../src/terminal/tmux.js';

const programs = { claude: claudeProgram, codex: codexProgram, kimi: kimiProgram, antigravity: agyProgram };
type Kind = keyof typeof programs;
const folders: string[] = [];
const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('The context was not written.');
};

function fixture(kind: Kind | null = 'claude') {
  const home = mkdtempSync(join(tmpdir(), 'hh-host-branches-'));
  folders.push(home);
  const workDir = join(home, 'work');
  mkdirSync(workDir);
  const sent: NodeMessage[] = [];
  const events: AgentEvent[] = [];
  const tmux = new Tmux({ env: { HOME: home }, recordingsDir: join(home, 'recordings') });
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: message => sent.push(message), secrets: () => [], log: () => {} });
  const agent = host['agent']('branches');
  Object.assign(agent, { home, workDir, sessionId: 'old', program: kind === null ? null : programs[kind] });
  agent.turn = { jobId: 'job', typed: false, seq: 0, onEvent: event => events.push(event) };
  agent.busy = agent.took = true;
  agent.ends.started('current');
  let resolve!: (message: string) => void;
  const finished = new Promise<string>(done => { resolve = done; });
  agent.ended = { promise: finished, resolve, settled: false };
  const file = (session = 'old') => kind === 'claude' ? claudeTranscript(home, workDir, session)
    : kind === 'codex' ? join(home, 'sessions', '2026', '11', '03', `rollout-${session}.jsonl`)
    : kind === 'kimi' ? join(home, 'sessions', 'workspace', session, 'agents', 'main', 'wire.jsonl')
    : agyTranscript(home, session)!;
  return { host, tmux, agent, sent, events, file, home, workDir, finished };
}

afterEach(() => { vi.useRealTimers(); for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('the host transcript and session branches', () => {
  it.each(Object.keys(programs) as Kind[])('starts a resumed %s reader after the old log and reads only new bytes', kind => {
    const c = fixture(kind);
    const header = kind === 'codex' ? { type: 'session_meta', payload: { id: 'old', cwd: c.workDir } } : { old: true };
    write(c.file(), JSON.stringify(header) + '\n');
    const tail = c.host['tailFor'](c.agent)!;
    expect(tail.read()).toEqual([]);
    appendFileSync(c.file(), '{"new":true}\n');
    expect(tail.read()).toEqual(['{"new":true}']);
  });

  it.each([null, ...Object.keys(programs)] as (Kind | null)[])('has no reader for %s without a session', kind => {
    const c = fixture(kind);
    c.agent.sessionId = null;
    expect(c.host['tailFor'](c.agent)).toBeNull();
  });

  it.each(['codex', 'kimi', 'antigravity'] as const)('rejects a missing or invalid %s transcript', kind => {
    const c = fixture(kind);
    if (kind === 'antigravity') c.agent.sessionId = '../other';
    expect(c.host['tailFor'](c.agent)).toBeNull();
  });

  it('uses the real Claude workspace path through a link', () => {
    const c = fixture();
    const link = join(c.home, 'link');
    symlinkSync(c.workDir, link);
    c.agent.workDir = link;
    write(c.file(), 'old\n');
    const tail = c.host['tailFor'](c.agent)!;
    appendFileSync(c.file(), 'new\n');
    expect(tail.read()).toEqual(['new']);
  });

  it('resets native agy tool receipts even before a session is known', () => {
    const c = fixture('antigravity');
    c.agent.agyRead = agySteps();
    c.agent.agyRead({ type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'Bash' }] });
    c.agent.sessionId = null;
    expect(c.host['tailFor'](c.agent)).toBeNull();
    expect(c.agent.agyRead({ type: 'GENERIC', status: 'DONE' })).toEqual({ events: [], began: [], ended: [] });
  });

  it.each(['', 'old'])('does not clear a session or rewind its reader for the same/empty id %j', session => {
    const c = fixture();
    write(c.file(), 'old\n');
    c.agent.tail = c.host['tailFor'](c.agent);
    c.agent.enqueuedWords = ['Held'];
    c.agent.dequeued = true;
    c.host['follow'](c.agent, session);
    appendFileSync(c.file(), 'new\n');
    expect(c.agent.tail!.read()).toEqual(['new']);
    expect([...c.agent.cleared]).toEqual([]);
    expect(c.agent.enqueuedWords).toEqual(['Held']);
    expect(c.agent.dequeued).toBe(true);
  });

  it('drains the former session and reports its unheard words before following the new Claude log', () => {
    const c = fixture();
    write(c.file(), '{"type":"assistant","message":{"content":[{"type":"text","text":"Old answer"}]}}\n');
    write(c.file('new'), '{"type":"assistant","message":{"content":[{"type":"text","text":"New answer"}]}}\n');
    c.agent.tail = new LineTail(c.file());
    const words = new TurnWords();
    const word = words.add('Unheard words', 'old-job');
    word.accepted = true;
    words.end(Date.now());
    c.agent.waitingWords.push(words);
    c.agent.enqueuedWords = ['Held'];
    c.agent.dequeued = true;
    c.host['follow'](c.agent, 'new');
    expect(c.events).toEqual([{ kind: 'text', text: 'Old answer' }]);
    expect(c.sent).toContainEqual({ type: 'agent.unheard', agentKey: 'branches', jobId: 'old-job', text: 'Unheard words' });
    expect([...c.agent.cleared]).toEqual(['old']);
    expect(c.agent.enqueuedWords).toEqual([]);
    expect(c.agent.dequeued).toBe(false);
    c.host['drain'](c.agent);
    expect(c.events).toEqual([{ kind: 'text', text: 'Old answer' }, { kind: 'text', text: 'New answer' }]);
  });

  it.each(['kimi', 'antigravity'] as const)('keeps a named %s session context and reads its new transcript from the beginning', async kind => {
    const c = fixture(kind);
    c.agent.sessionId = null;
    c.agent.keep = 'Earlier conversation';
    write(c.file('new'), kind === 'kimi' ? '{"type":"context.append_loop_event","event":{"type":"content.part","part":{"type":"text","text":"New answer"}}}\n' : '{"type":"PLANNER_RESPONSE","content":"New answer"}\n');
    c.host['follow'](c.agent, 'new');
    const context = join(c.workDir, '.hh-context', 'new.md');
    await until(() => { try { return readFileSync(context, 'utf8') === 'Earlier conversation'; } catch { return false; } });
    expect(c.agent.keep).toBeNull();
    expect(c.agent.sessionId).toBe('new');
    expect([...c.agent.cleared]).toEqual([]);
    if (kind === 'kimi') {
      expect(c.agent.tail).toBeNull();
    }
    c.host['drain'](c.agent);
    expect(c.events).toEqual([{ kind: 'text', text: 'New answer' }]);
  });

  it('follows an invalid agy transcript id without accepting its path or leaking pending tools', () => {
    const c = fixture('antigravity');
    c.agent.agyRead = agySteps();
    c.agent.agyRead({ type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'Bash' }] });
    c.host['follow'](c.agent, '../other');
    expect(c.agent.tail).toBeNull();
    expect(c.agent.agyRead({ type: 'GENERIC', status: 'DONE' })).toEqual({ events: [], began: [], ended: [] });
  });

  it.each(['codex', null] as const)('preserves the existing %s reader when following its session', kind => {
    const c = fixture(kind);
    write(c.file(), 'old\n');
    c.agent.tail = new LineTail(c.file());
    c.host['follow'](c.agent, 'new');
    appendFileSync(c.file(), 'new\n');
    expect(c.agent.tail!.read()).toEqual(['new']);
  });
});

describe('stop hook branches before extraction', () => {
  it('keeps a person stopping ahead of failure classification and rejects a mismatched turn id', async () => {
    const c = fixture();
    await c.host['hook']('branches', 'stop', { turn_id: 'other', stopped: true });
    expect(c.agent.busy).toBe(true);
    await c.host['hook']('branches', 'stop', { turn_id: 'current', stopped: true, error: 'overloaded' });
    expect(await c.finished).toBe('');
    expect(c.agent.turn!.ending).toEqual({ status: 'stopped', message: '' });
    expect(c.agent.failure).toBeNull();
  });

  it.each([{ hook_event_name: 'StopFailure' }, { error: 'overloaded' }, { error_type: 'api_error' }])('fails from the independent failure signal %j', async data => {
    const c = fixture();
    await c.host['hook']('branches', 'stop', data);
    expect(await c.finished).toBe('');
    expect(c.agent.turn!.ending?.status).toBe('failed');
    expect(c.agent.failure).not.toBeNull();
  });

  it('classifies explicit agy diagnostics before generic hook fields', async () => {
    const c = fixture('antigravity');
    await c.host['hook']('branches', 'stop', { error: 'network issue', agy_error: { short_error: 'overloaded', retryable: false } });
    expect(c.agent.failure).toEqual({ kind: 'overloaded', text: 'overloaded', retryable: false });
  });

  it.each([true, false])('uses fresh recorded agy detail when it matches the Stop reason: %s', async matches => {
    const c = fixture('antigravity');
    const recording = c.tmux['recordings'].create(c.agent.name, c.workDir);
    const output = 'AGY_ERROR: {"short_error":"overloaded","retryable":false}\n';
    writeFileSync(recording.file, output);
    const position = Buffer.alloc(24);
    position.writeDoubleBE(Buffer.byteLength(output), 8);
    position.writeDoubleBE(Buffer.byteLength(output), 16);
    writeFileSync(recording.position, position);
    c.agent.agyCursor = { file: recording.file, offset: 0 };
    await c.host['hook']('branches', 'stop', { error: matches ? 'overloaded' : 'network issue' });
    expect(c.agent.failure).toEqual(matches
      ? { kind: 'overloaded', text: 'overloaded', retryable: false }
      : { kind: 'network', text: 'network issue', retryable: true });
  });

  it('keeps unknown failures without a program', async () => {
    const failed = fixture(null);
    await failed.host['hook']('branches', 'stop', { error: 17 });
    expect(failed.agent.failure).toMatchObject({ kind: 'unknown', text: '17' });
  });

  it.each([[null, ''], [undefined, ''], [0, '0'], [false, 'false'], [23, '23']])('normalizes a successful hook answer %j without a program', async (answer, expected) => {
    const c = fixture(null);
    const stopping = c.host['hook']('branches', 'stop', { last_assistant_message: answer });
    expect(c.agent.turn!.ending).toEqual({ status: 'done', message: expected });
    await stopping;
    expect(await c.finished).toBe(expected);
  });

  it('follows a session named only by Stop and accepts an empty successful answer', async () => {
    const c = fixture('codex');
    await c.host['hook']('branches', 'stop', { session_id: 'new' });
    expect(c.agent.sessionId).toBe('new');
    expect(await c.finished).toBe('');
  });

  it('settles the Kimi wire answer instead of the hook text', async () => {
    const c = fixture('kimi');
    write(c.file(), '{"type":"turn.ended","reason":"completed"}\n');
    c.agent.tail = new LineTail(c.file());
    c.agent.lastText = 'Wire answer';
    await c.host['hook']('branches', 'stop', { last_assistant_message: 'Wrong hook answer' });
    expect(await c.finished).toBe('Wire answer');
  });

  it('leaves a newer Kimi turn alone while the former Stop is settling', async () => {
    const c = fixture('kimi');
    const stopping = c.host['hook']('branches', 'stop', { last_assistant_message: 'Old hook answer' });
    const next = { ...c.agent.turn!, jobId: 'next' };
    c.agent.turn = next;
    await stopping;
    expect(next.ending).toBeUndefined();
    expect(c.agent.busy).toBe(true);
  });

  it('ignores a Kimi Stop after its turn has already disappeared', async () => {
    const c = fixture('kimi');
    c.agent.turn = null;
    c.agent.busy = false;
    await c.host['hook']('branches', 'stop', {});
    expect(c.agent.turn).toBeNull();
    expect(c.agent.failure).toBeNull();
    expect(c.agent.busy).toBe(false);
  });

  it('does not end a new turn queued between a wire check and its Stop continuation', async () => {
    const c = fixture('kimi');
    const next = { ...c.agent.turn!, jobId: 'next' };
    c.agent.turn = null;
    const stopping = c.host['hook']('branches', 'stop', {});
    queueMicrotask(() => {
      c.host['beginTurn'](c.agent);
      c.agent.turn = next;
      c.agent.ends.started('next');
    });
    await stopping;
    expect(next.ending).toBeUndefined();
  });

  it.each([null, 'Wire answer'])('bounds a missing Kimi wire end and keeps its last text %j', async answer => {
    const c = fixture('kimi');
    c.agent.lastText = answer;
    vi.useFakeTimers();
    const stopping = c.host['hook']('branches', 'stop', { last_assistant_message: 'Wrong hook answer' });
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(await c.finished).toBe(answer ?? '');
  });

  it('checks the current program after waiting for the Kimi wire', async () => {
    const c = fixture('kimi');
    c.agent.lastText = 'Former wire text';
    vi.useFakeTimers();
    const stopping = c.host['hook']('branches', 'stop', { last_assistant_message: 'Current hook text' });
    c.agent.program = codexProgram;
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(await c.finished).toBe('Current hook text');
  });

  it('answers native agy Stop before its final planner response is appended', async () => {
    const c = fixture('antigravity');
    write(c.file(), '');
    c.agent.agyRead = agySteps();
    c.agent.tail = new LineTail(c.file());
    await c.host['hook']('branches', 'stop', { last_assistant_message: 'Wrong hook answer' });
    expect(c.agent.turn!.ending).toBeUndefined();
    appendFileSync(c.file(), '{"type":"PLANNER_RESPONSE","content":"Native answer"}\n');
    await c.agent.settling;
    expect(await c.finished).toBe('Native answer');
  });
});
