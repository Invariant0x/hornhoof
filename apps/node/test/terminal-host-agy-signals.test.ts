import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { agyProgram, agyTranscript } from '../src/providers/antigravity-terminal.js';
import { claudeProgram } from '../src/providers/claude-terminal.js';
import { TurnWords } from '../src/terminal/program-restart.js';
import { agySteps, LineTail } from '../src/terminal/transcripts.js';
import { Tmux } from '../src/terminal/tmux.js';
import { ownFs, type AgentFs } from '../src/agent-fs.js';
import { onClock, until, untilOnClock } from './terminal-host-helpers.js';

const FAKE_CLOCK = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] as const;
const fakeClock = () => vi.useFakeTimers({ toFake: [...FAKE_CLOCK] });

const folders: string[] = [];
const hosts: TerminalHost[] = [];
const runs: { mock: { calls: unknown[][] } }[] = [];

function standInTmux(home: string): Tmux {
  const tmux = new Tmux({ env: { HOME: home }, recordingsDir: join(home, 'recordings') });
  runs.push(vi.spyOn(tmux, 'run').mockRejectedValue(new Error('Real tmux command must not run in unit tests.')));
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  vi.spyOn(tmux, 'alive').mockResolvedValue(false);
  vi.spyOn(tmux, 'screen').mockResolvedValue('');
  vi.spyOn(tmux, 'programCursor').mockResolvedValue(null);
  vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  vi.spyOn(tmux, 'stop').mockResolvedValue();
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  return tmux;
}

function fixture(withOperator = false) {
  const home = mkdtempSync(join(tmpdir(), 'hh-agy-signals-'));
  folders.push(home);
  const sent: NodeMessage[] = [];
  const events: AgentEvent[] = [];
  const tmux = standInTmux(home);
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: m => sent.push(m), secrets: () => [], pollMs: 100, lookMs: 100, reportMs: 1000, ...(withOperator ? { operator: { dir: join(home, 'operator'), connected: () => true, send: () => true } } : {}) });
  hosts.push(host);
  const agent = host['agent']('agy');
  Object.assign(agent, { home, workDir: home, program: agyProgram, sessionId: 'session', busy: true, took: true, agyRead: agySteps() });
  agent.turn = { jobId: 'job', typed: false, seq: 0, words: new TurnWords(), onEvent: e => events.push(e) };
  agent.ends.started();
  const file = agyTranscript(home, 'session')!;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '');
  agent.tail = new LineTail(file);
  return { host, agent, tmux, sent, events };
}

afterEach(async () => {
  const checks = runs.splice(0);
  try {
    for (const host of hosts.splice(0)) await host.stop();
    for (const run of checks) expect(run).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  }
});

describe('Antigravity execution boundaries', () => {
  it('keeps an execution Stop open while the conversation is not fully idle', async () => {
    const c = fixture();
    fakeClock();
    c.host['agyNews'](c.agent, { type: 'PLANNER_RESPONSE', step_index: 1, status: 'DONE', content: 'Using dev-security-review.' });
    await c.host['hook']('agy', 'stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL', error: '' });
    await vi.advanceTimersByTimeAsync(4000);
    expect(c.agent.busy).toBe(true);
    expect(c.agent.turn!.ending).toBeUndefined();
    c.host['agyNews'](c.agent, { type: 'PLANNER_RESPONSE', step_index: 2, status: 'DONE', tool_calls: [{ name: 'view_file', args: { path: 'file.ts' } }] });
    expect(c.agent.calls.size).toBe(1);
    c.host['agyNews'](c.agent, { type: 'GENERIC', step_index: 3, status: 'DONE', content: 'file contents' });
    c.host['agyNews'](c.agent, { type: 'PLANNER_RESPONSE', step_index: 4, status: 'DONE', content: 'Review complete.' });
    await c.host['hook']('agy', 'stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '' });
    await vi.advanceTimersByTimeAsync(100);
    expect(c.agent.turn!.ending).toEqual({ status: 'done', message: 'Review complete.' });
    expect(c.events.filter(e => e.kind === 'text')).toEqual([{ kind: 'text', text: 'Using dev-security-review.' }, { kind: 'text', text: 'Review complete.' }]);
  });

  it('reports activity beyond 120 seconds and delivers the waiting prompt once agy is ready', async () => {
    const c = fixture();
    const busy = readFileSync(new URL('./fixtures/agy-tui/screen-busy.ansi', import.meta.url), 'utf8');
    const idle = readFileSync(new URL('./fixtures/agy-tui/screen-idle.ansi', import.meta.url), 'utf8');
    fakeClock();
    c.agent.took = false;
    let ready = false;
    let ended = false;
    const delivered: string[] = [];
    vi.spyOn(c.tmux, 'alive').mockResolvedValue(true);
    vi.spyOn(c.tmux, 'screen').mockImplementation(async () => ready ? idle : busy);
    vi.spyOn(c.tmux, 'programCursor').mockResolvedValue(null);
    vi.spyOn(c.tmux, 'paste').mockImplementation(async (_name, text) => { delivered.push(text); });
    vi.spyOn(c.tmux, 'keys').mockImplementation(async (_name, ...keys) => {
      if (ready && delivered.length && keys.includes('Enter')) await c.host['hook']('agy', 'invocation', { invocationNum: 0, lastUserInput: 'Please submit the review.' });
    });
    const job = { key: 'agy', program: agyProgram, bin: 'agy', home: c.agent.home, signedOut: /signed out/, input: { jobId: 'job', prompt: 'Please submit the review.', workDir: c.agent.home, sessionId: 'session', model: null, secret: null, instructions: null, tools: null, timeoutMs: 120_000 } };
    const sending = c.host['typePrompt'](c.agent, job, job.input.prompt).then(result => { ended = true; return result; });
    await vi.advanceTimersByTimeAsync(121_000);
    expect(ended).toBe(false);
    expect(delivered).toEqual([]);
    const reports = c.sent.filter(m => m.type === 'job.program');
    expect(reports.at(-1)).toMatchObject({ jobId: 'job', state: 'thinking' });
    ready = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await sending).toBeNull();
    expect(delivered).toEqual(['Please submit the review.']);
    expect(c.agent.took).toBe(true);
  });


  it('keeps an already queued prompt alive beyond the receipt timeout without another Enter', async () => {
    const c = fixture();
    fakeClock();
    c.agent.took = false;
    c.agent.typing = 'Queued review reminder';
    c.agent.turn!.observed = c.host['observeProgram'](c.agent, 'job');
    const busy = readFileSync(new URL('./fixtures/agy-tui/screen-busy.ansi', import.meta.url), 'utf8');
    vi.spyOn(c.tmux, 'alive').mockResolvedValue(true);
    vi.spyOn(c.tmux, 'screen').mockResolvedValue(busy);
    const keys = vi.spyOn(c.tmux, 'keys').mockResolvedValue();
    const job = { key: 'agy', program: agyProgram, bin: 'agy', home: c.agent.home, signedOut: /signed out/, input: { jobId: 'job', prompt: 'Queued review reminder', workDir: c.agent.home, sessionId: 'session', model: null, secret: null, instructions: null, tools: null, timeoutMs: 120_000 } };
    let ended = false;
    const sending = c.host['waitAgyReceipt'](c.agent, job, job.input.prompt).then(result => { ended = true; return result; });
    await vi.advanceTimersByTimeAsync(130_000);
    expect(ended).toBe(false);
    expect(keys).not.toHaveBeenCalled();
    expect(c.sent.filter(m => m.type === 'job.program').at(-1)).toMatchObject({ state: 'thinking', jobId: 'job' });
    c.agent.took = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(await sending).toBeNull();
  });


  it('keeps the next job waiting past its timeout while the previous agy turn is active', async () => {
    const c = fixture();
    fakeClock();
    const busy = readFileSync(new URL('./fixtures/agy-tui/screen-busy.ansi', import.meta.url), 'utf8');
    vi.spyOn(c.tmux, 'screen').mockResolvedValue(busy);
    const job = { key: 'agy', program: agyProgram, bin: 'agy', home: c.agent.home, signedOut: /signed out/, input: { jobId: 'next-job', prompt: 'Next review', workDir: c.agent.home, sessionId: 'session', model: null, secret: null, instructions: null, tools: null, timeoutMs: 120_000 } };
    vi.spyOn(c.tmux, 'alive').mockResolvedValue(true);
    let waiting = true;
    const wait = c.host['waitForTurn'](c.agent, job).then(() => { waiting = false; });
    await vi.advanceTimersByTimeAsync(130_000);
    expect(waiting).toBe(true);
    expect(c.agent.turn!.jobId).toBe('job');
    expect(c.sent.filter(m => m.type === 'job.program').at(-1)).toMatchObject({ jobId: 'next-job', state: 'thinking' });
    c.agent.busy = false;
    await vi.advanceTimersByTimeAsync(100);
    await wait;
    expect(waiting).toBe(false);
  });

  it('uses the same waiting delivery with the program operator enabled', async () => {
    const c = fixture();
    fakeClock();
    const busy = readFileSync(new URL('./fixtures/agy-tui/screen-busy.ansi', import.meta.url), 'utf8');
    const stop = new AbortController();
    vi.spyOn(c.tmux, 'screen').mockResolvedValue(busy);
    vi.spyOn(c.tmux, 'alive').mockResolvedValue(true);
    vi.spyOn(c.host as unknown as { operatorEnabled: () => boolean }, 'operatorEnabled').mockReturnValue(true);
    const paste = vi.spyOn(c.tmux, 'paste').mockResolvedValue();
    const job = { key: 'agy', program: agyProgram, bin: 'agy', home: c.agent.home, signedOut: /signed out/, operatorDelivery: { id: '197503fd-4dc9-40ab-a124-713813d9d865', ordinal: 1 }, input: { jobId: 'job', prompt: 'Next review', workDir: c.agent.home, sessionId: 'session', model: null, secret: null, instructions: null, tools: null, timeoutMs: 120_000, signal: stop.signal } };
    const sending = c.host['typePrompt'](c.agent, job, job.input.prompt);
    await vi.advanceTimersByTimeAsync(130_000);
    expect(paste).not.toHaveBeenCalled();
    expect(c.sent.filter(m => m.type === 'job.program').at(-1)).toMatchObject({ jobId: 'job', state: 'thinking' });
    stop.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(await sending).toMatchObject({ ok: false, error: 'cancelled' });
  });


  it('waits for the final transcript after a non-idle execution and a later idle Stop', async () => {
    const c = fixture();
    fakeClock();
    c.host['agyNews'](c.agent, { type: 'PLANNER_RESPONSE', step_index: 1, status: 'DONE', content: 'Using dev-security-review.' });
    await c.host['hook']('agy', 'stop', { fullyIdle: false });
    await c.host['hook']('agy', 'stop', { fullyIdle: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(c.agent.turn!.ending).toBeUndefined();
    c.host['agyNews'](c.agent, { type: 'PLANNER_RESPONSE', step_index: 2, status: 'DONE', content: 'Review complete.' });
    await vi.advanceTimersByTimeAsync(100);
    expect(c.agent.turn!.ending).toEqual({ status: 'done', message: 'Review complete.' });
  });


  it('waits in the input lane and rechecks readiness before pasting', async () => {
    const c = fixture(true);
    fakeClock();
    c.agent.took = false;
    let screen = readFileSync(new URL('./fixtures/agy-tui/screen-idle.ansi', import.meta.url), 'utf8');
    vi.spyOn(c.tmux, 'screen').mockImplementation(async () => screen);
    vi.spyOn(c.tmux, 'alive').mockResolvedValue(true);
    const paste = vi.spyOn(c.tmux, 'paste').mockResolvedValue();
    vi.spyOn(c.tmux, 'keys').mockResolvedValue();
    let release!: () => void;
    const lane = c.host['operator']!.serial('agy', () => new Promise<void>(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(1);
    const stop = new AbortController();
    const job = { key: 'agy', program: agyProgram, bin: 'agy', home: c.agent.home, signedOut: /signed out/, input: { jobId: 'job', prompt: 'Review reminder', workDir: c.agent.home, sessionId: 'session', model: null, secret: null, instructions: null, tools: null, timeoutMs: 120_000, signal: stop.signal } };
    const sending = c.host['typePrompt'](c.agent, job, job.input.prompt);
    await vi.advanceTimersByTimeAsync(1000);
    expect(paste).not.toHaveBeenCalled();
    screen = readFileSync(new URL('./fixtures/agy-tui/screen-busy.ansi', import.meta.url), 'utf8');
    release();
    await lane;
    await vi.advanceTimersByTimeAsync(1000);
    expect(paste).not.toHaveBeenCalled();
    stop.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(await sending).toMatchObject({ ok: false, error: 'cancelled' });
  });


  it('does not submit a canceled prompt when the retry screen arrives late', async () => {
    const c = fixture();
    c.agent.took = false;
    let show!: (screen: string) => void;
    vi.spyOn(c.tmux, 'screen').mockImplementation(() => new Promise<string>(resolve => { show = resolve; }));
    const keys = vi.spyOn(c.tmux, 'keys').mockResolvedValue();
    const stop = new AbortController();
    const retry = c.host['retryAgyEnter'](c.agent, 'Reminder', stop.signal);
    stop.abort();
    show('────\n> Reminder\n────\n? for shortcuts');
    await retry;
    expect(keys).not.toHaveBeenCalled();
  });


  it('retries Enter only for the same prompt at an idle input', async () => {
    const c = fixture();
    c.agent.took = false;
    const screen = vi.spyOn(c.tmux, 'screen').mockResolvedValue('────\n> Reminder\n────\n? for shortcuts');
    const keys = vi.spyOn(c.tmux, 'keys').mockResolvedValue();
    await c.host['retryAgyEnter'](c.agent, 'Reminder');
    expect(keys.mock.calls).toEqual([['a-agy', 'Enter']]);
    screen.mockResolvedValue("────\n> A person's draft\n────\n? for shortcuts");
    await c.host['retryAgyEnter'](c.agent, 'Reminder');
    expect(keys.mock.calls).toEqual([['a-agy', 'Enter']]);
  });

  it.each(['deadline', 'cancelled', 'ended'])("preserves the other programs' waiting rule: %s", async reason => {
    const c = fixture();
    c.agent.program = claudeProgram;
    fakeClock();
    const stop = new AbortController();
    const job = { key: 'agy', program: claudeProgram, bin: 'claude', home: c.agent.home, signedOut: /signed out/, input: { jobId: 'next-job', prompt: 'Next review', workDir: c.agent.home, sessionId: 'session', model: null, secret: null, instructions: null, tools: null, timeoutMs: 300, signal: stop.signal } };
    let ended = false;
    const waiting = c.host['waitForTurn'](c.agent, job).then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(ended).toBe(false);
    if (reason === 'cancelled') stop.abort();
    if (reason === 'ended') c.agent.busy = false;
    await vi.advanceTimersByTimeAsync(300);
    await waiting;
    expect(ended).toBe(true);
    expect(c.agent.turn!.jobId).toBe('job');
  });
});

describe('Antigravity subagent conversations', () => {
  function subagentHost(options: { fs?: AgentFs; onStop?: () => Promise<void> } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'hh-agy-subagent-'));
    folders.push(home);
    const workDir = join(home, 'work');
    mkdirSync(workDir);
    const remembered: string[] = [];
    const launches: string[][] = [];
    const idle = readFileSync(new URL('./fixtures/agy-tui/screen-idle.ansi', import.meta.url), 'utf8');
    const tmux = standInTmux(home);
    const host = new TerminalHost({
      tmux, fs: options.fs, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], env: { VITEST_MAX_WORKERS: '2' },
      remember: sessionId => { remembered.push(sessionId); }, pollMs: 50, lookMs: 50, readyMs: 1000, toolsMs: 1000,
    });
    hosts.push(host);
    fakeClock();
    let alive = false;
    let promptText = '';
    vi.spyOn(tmux, 'launch').mockImplementation(async (_name, opts) => {
      launches.push(opts.command);
      alive = true;
    });
    vi.spyOn(tmux, 'alive').mockImplementation(async () => alive);
    vi.spyOn(tmux, 'stop').mockImplementation(async () => {
      await options.onStop?.();
      alive = false;
    });
    vi.spyOn(tmux, 'screen').mockResolvedValue(idle);
    vi.spyOn(tmux, 'paste').mockImplementation(async (_name, text) => { promptText = text; });
    const job = (jobId: string, prompt: string, sessionId: string | null) => ({
      key: 'designer', program: agyProgram, bin: 'agy', home, signedOut: /signed out/,
      input: { jobId, prompt, workDir, sessionId, model: null, secret: null, instructions: null, tools: null, timeoutMs: 60_000 },
    });
    return { home, tmux, host, remembered, launches, job, setAlive: (next: boolean) => { alive = next; }, prompt: () => promptText };
  }

  it('keeps the main session and open turn when a subagent runs, and resumes the main session on the next turn', async () => {
    const s = subagentHost();
    vi.spyOn(s.tmux, 'keys').mockImplementation(async (_name, ...keys) => {
      if (!keys.includes('Enter')) return;
      const agent = s.host['agent']('designer');
      const mainId = 'main-conversation-1';
      await s.host['hook']('designer', 'invocation', { conversationId: mainId, invocationNum: 0, lastUserInput: s.prompt() });
      const transcript = agyTranscript(s.home, mainId)!;
      mkdirSync(join(transcript, '..'), { recursive: true });
      if (s.prompt().includes('first turn')) {
        appendFileSync(transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, status: 'DONE', tool_calls: [{ name: 'invoke_subagent', args: { TypeName: 'image-generator' } }] }) + '\n');
        await s.host['hook']('designer', 'invocation', { conversationId: 'subagent-conversation-1', invocationNum: 0, lastUserInput: 'Generate a banner' });
        await s.host['hook']('designer', 'invocation', { conversationId: 'subagent-conversation-1', invocationNum: 1, lastUserInput: 'Generate a banner' });
        await s.host['hook']('designer', 'stop', { conversationId: 'subagent-conversation-1', fullyIdle: false, terminationReason: 'NO_TOOL_CALL', error: '' });
        await s.host['hook']('designer', 'stop', { conversationId: 'subagent-conversation-1', fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '' });
        await s.host['hook']('designer', 'stop', { conversationId: 'subagent-conversation-2', fullyIdle: true, terminationReason: 'ERROR', error: 'image failed' });
        expect(agent.sessionId).toBe(mainId);
        expect(agent.turn!.ending).toBeUndefined();
        expect([...agent.cleared]).toEqual([]);
        expect([...agent.left]).toEqual([]);
        await s.host['hook']('designer', 'invocation', { conversationId: mainId, invocationNum: 1, lastUserInput: s.prompt() });
        appendFileSync(transcript, JSON.stringify({ type: 'GENERIC', step_index: 2, status: 'DONE', content: 'banner.png' }) + '\n');
        appendFileSync(transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 3, status: 'DONE', content: 'Banner ready.' }) + '\n');
        await s.host['hook']('designer', 'stop', { conversationId: mainId, fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '' });
      } else {
        appendFileSync(transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 4, status: 'DONE', content: 'Resumed with tools.' }) + '\n');
        await s.host['hook']('designer', 'stop', { conversationId: mainId, fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '' });
      }
    });

    const res1 = await onClock(s.host.run(s.job('job-1', 'Run first turn with subagent', null)), { stepMs: 50 });
    expect(res1).toMatchObject({ ok: true, sessionId: 'main-conversation-1', result: 'Banner ready.' });
    expect(s.remembered).not.toContain('subagent-conversation-1');
    expect(s.launches[0]).not.toContain('--conversation');

    /* Simulate program exit so the next turn must relaunch Antigravity with the saved session id. */
    s.setAlive(false);
    const res2 = await onClock(s.host.run(s.job('job-2', 'Run second turn after restart', res1.sessionId)), { stepMs: 50 });
    expect(s.launches[1]).toEqual(expect.arrayContaining(['--conversation', 'main-conversation-1']));
    expect(res2).toMatchObject({ ok: true, sessionId: 'main-conversation-1', result: 'Resumed with tools.' });
  });

  it('finishes starting and resuming on the virtual clock when setup and idle stop wait past 10 seconds under load', async () => {
    let delayed = false;
    let stopEntered = false;
    let over = false;
    onTestFinished(() => { over = true; });
    const slowFs: AgentFs = {
      ...ownFs,
      async mkdir(dir: string) {
        if (!delayed) {
          delayed = true;
          const startedAt = Date.now();
          await until(() => over || Date.now() - startedAt >= 11_000);
        }
        return ownFs.mkdir(dir);
      },
    };
    const s = subagentHost({
      fs: slowFs,
      async onStop() {
        stopEntered = true;
        const stoppedAt = Date.now();
        await until(() => over || Date.now() - stoppedAt >= 11_000);
      },
    });
    vi.spyOn(s.tmux, 'keys').mockImplementation(async (_name, ...keys) => {
      if (!keys.includes('Enter')) return;
      const mainId = 'main-conversation-load';
      await s.host['hook']('designer', 'invocation', { conversationId: mainId, invocationNum: 0, lastUserInput: s.prompt() });
      const transcript = agyTranscript(s.home, mainId)!;
      mkdirSync(join(transcript, '..'), { recursive: true });
      const step = s.prompt().includes('first') ? { step_index: 1, content: 'First loaded turn ready.' } : { step_index: 2, content: 'Second loaded turn ready.' };
      appendFileSync(transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', ...step }) + '\n');
      await s.host['hook']('designer', 'stop', { conversationId: mainId, fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '' });
    });

    const res1 = await onClock(s.host.run(s.job('job-load-1', 'Run first turn under load', null)), { stepMs: 50 });
    expect(res1).toMatchObject({ ok: true, sessionId: 'main-conversation-load', result: 'First loaded turn ready.' });
    await untilOnClock(() => stopEntered, { stepMs: 50 });

    const res2 = await onClock(s.host.run(s.job('job-load-2', 'Run second turn under load', res1.sessionId)), { stepMs: 50 });
    expect(s.launches[1]).toEqual(expect.arrayContaining(['--conversation', 'main-conversation-load']));
    expect(res2).toMatchObject({ ok: true, sessionId: 'main-conversation-load', result: 'Second loaded turn ready.' });
  });

  it('keeps a resumed main session and transcript intact when a subagent fires hooks', async () => {
    const c = fixture();
    fakeClock();
    const file = agyTranscript(c.agent.home, 'session')!;
    await c.host['hook']('agy', 'invocation', { conversationId: 'child-subagent', invocationNum: 0, lastUserInput: 'Draw mockup' });
    await c.host['hook']('agy', 'invocation', { conversationId: 'child-subagent', invocationNum: 1, lastUserInput: 'Draw mockup' });
    await c.host['hook']('agy', 'stop', { conversationId: 'child-subagent', fullyIdle: false, error: '' });
    await c.host['hook']('agy', 'stop', { conversationId: 'child-subagent', fullyIdle: true, error: '' });
    await c.host['hook']('agy', 'stop', { session_id: 'child-subagent', fullyIdle: true, error: 'boom' });
    await vi.advanceTimersByTimeAsync(4000);
    expect(c.agent.sessionId).toBe('session');
    expect([...c.agent.cleared]).toEqual([]);
    expect([...c.agent.left]).toEqual([]);
    expect(c.agent.turn!.ending).toBeUndefined();
    appendFileSync(file, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, status: 'DONE', content: 'Main done.' }) + '\n');
    await c.host['hook']('agy', 'stop', { conversationId: 'session', fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '' });
    await vi.advanceTimersByTimeAsync(200);
    expect(c.agent.turn!.ending).toEqual({ status: 'done', message: 'Main done.' });
    expect(c.agent.sessionId).toBe('session');
  });

  it('ignores a background subagent between turns and while the next prompt waits', async () => {
    const c = fixture();
    c.agent.turn = null;
    c.agent.busy = false;
    c.agent.took = false;
    c.agent.promptWaits = true;
    await c.host['hook']('agy', 'invocation', { conversationId: 'bg-subagent', invocationNum: 0, lastUserInput: 'Background work' });
    await c.host['hook']('agy', 'stop', { conversationId: 'bg-subagent', fullyIdle: true, error: '' });
    expect(c.agent.sessionId).toBe('session');
    expect(c.agent.busy).toBe(false);
    expect(c.agent.personWords).toBeFalsy();
    expect(c.agent.turn).toBeNull();
    expect(c.sent).toEqual([]);
  });

  it('ignores a stale hook from a left Antigravity session before a fresh run names its own', async () => {
    const c = fixture();
    c.agent.sessionId = null;
    c.agent.left.add('previous-main');
    c.agent.busy = false;
    await c.host['hook']('agy', 'invocation', { conversationId: 'previous-main', invocationNum: 1 });
    expect(c.agent.sessionId).toBeNull();
    expect(c.agent.busy).toBe(false);
    await c.host['hook']('agy', 'invocation', { conversationId: 'fresh-main', invocationNum: 1 });
    expect(c.agent.sessionId).toBe('fresh-main');
    expect(c.agent.busy).toBe(true);
  });
});
