import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { agyProgram, agyTranscript } from '../src/providers/antigravity-terminal.js';
import { claudeProgram } from '../src/providers/claude-terminal.js';
import { TurnWords } from '../src/terminal/program-restart.js';
import { idleScreen } from '../src/terminal/program-state.js';
import { agySteps, LineTail } from '../src/terminal/transcripts.js';
import { Tmux } from '../src/terminal/tmux.js';

const folders: string[] = [];
function fixture(withOperator = false) {
  const home = mkdtempSync(join(tmpdir(), 'hh-agy-signals-'));
  folders.push(home);
  const sent: NodeMessage[] = [];
  const events: AgentEvent[] = [];
  const tmux = new Tmux({ env: { HOME: home } });
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: m => sent.push(m), secrets: () => [], pollMs: 100, lookMs: 100, reportMs: 1000, ...(withOperator ? { operator: { dir: join(home, 'operator'), connected: () => true, send: () => true } } : {}) });
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
afterEach(() => { vi.useRealTimers(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('Antigravity execution boundaries', () => {
  it('keeps an execution Stop open while the conversation is not fully idle', async () => {
    const c = fixture();
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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


  it('keeps a turn running while agy shows an earlier answer done at its empty prompt and no receipt came', async () => {
    const c = fixture();
    vi.useFakeTimers();
    c.agent.took = false;
    c.agent.typing = 'Please submit the review.';
    c.agent.turn!.observed = c.host['observeProgram'](c.agent, 'job');
    const idle = readFileSync(new URL('./fixtures/agy-tui/screen-done.ansi', import.meta.url), 'utf8');
    expect(idleScreen('antigravity', idle)).toBe(true);
    vi.spyOn(c.tmux, 'alive').mockResolvedValue(true);
    vi.spyOn(c.tmux, 'screen').mockResolvedValue(idle);
    vi.spyOn(c.tmux, 'keys').mockResolvedValue();
    const job = { key: 'agy', program: agyProgram, bin: 'agy', home: c.agent.home, signedOut: /signed out/, input: { jobId: 'job', prompt: 'Please submit the review.', workDir: c.agent.home, sessionId: 'session', model: null, secret: null, instructions: null, tools: null, timeoutMs: 120_000 } };
    void c.host['waitAgyReceipt'](c.agent, job, job.input.prompt);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(c.agent.turn!.ending).toBeUndefined();
    expect(c.agent.busy).toBe(true);
    c.agent.took = true;
    await vi.advanceTimersByTimeAsync(100);
  });

  it('keeps the next job waiting past its timeout while the previous agy turn is active', async () => {
    const c = fixture();
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
