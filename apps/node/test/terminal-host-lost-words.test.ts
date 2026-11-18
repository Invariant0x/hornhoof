import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NodeMessage } from '@hornhoof/protocol';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { codexProgram } from '../src/providers/codex-terminal.js';
import { Tmux } from '../src/terminal/tmux.js';
import { userMessage } from './fakes/word-receipts.mjs';
import { onClock, untilOnClock } from './terminal-host-helpers.js';
import { codexPrompt } from './real-screens.js';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
const WORDS = 'Check the checkout.';

type Program = {
  /* What the input shows now. */
  input: string;
  /* What the screen shows besides, which a program at work keeps changing. */
  status: string;
  /* What it does with a paste and an Enter; the test decides what gets lost. */
  onPaste(text: string): void;
  onEnter(): void;
  /* What the keys that erase the input do. */
  onErase?(): void;
};

/* A host with a program it started, whose screen and keys the test plays, on a clock that moves only as the test moves it. */
async function started(program: Program, { plain = false, remember, readyMs, toolsMs }: { plain?: boolean; remember?: (sessionId: string, workDir: string) => void; readyMs?: number; toolsMs?: number } = {}) {
  vi.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), 'hh-lost-words-'));
  const agentKey = randomUUID(), jobId = randomUUID(), deliveryId = randomUUID(), sessionId = randomUUID();
  const workDir = join(home, 'work');
  const file = join(home, 'sessions/2026/11/05', `rollout-${sessionId}.jsonl`);
  const record = (line: object) => appendFileSync(file, JSON.stringify(line) + '\n');
  const finish = (words = WORDS, turn = 'work') => {
    record(userMessage(words));
    record({ type: 'event_msg', payload: { type: 'task_started', turn_id: turn } });
    record({ type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } });
    record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: 'Done.' } });
  };
  const tmux = new Tmux({ env: { HOME: home } });
  const sent: OperatorNodeMessage[] = [];
  const reports: NodeMessage[] = [];
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  /* A program that sleeps ends; the next launch starts it again. */
  let asleep = false;
  vi.spyOn(tmux, 'launch').mockImplementation(async () => {
    if (asleep) alive.mockResolvedValue(true);
    asleep = false;
    mkdirSync(dirname(file), { recursive: true });
    record({ type: 'session_meta', payload: { id: sessionId, cwd: workDir } });
  });
  vi.spyOn(tmux, 'run').mockResolvedValue('80 24');
  const alive = vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  vi.spyOn(tmux, 'stop').mockImplementation(async () => {
    asleep = true;
    alive.mockResolvedValue(false);
  });
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  vi.spyOn(tmux, 'screen').mockImplementation(async () => `OpenAI Codex\n${program.status}\n${codexPrompt(program.input)}`);
  const paste = vi.spyOn(tmux, 'paste').mockImplementation(async (_target, text) => program.onPaste(text));
  const keys = vi.spyOn(tmux, 'keys').mockImplementation(async (_target, ...pressed) => {
    if (pressed.includes('C-u')) program.onErase?.();
    if (pressed.includes('Enter')) program.onEnter();
  });
  const host = new TerminalHost({
    tmux, hornhoof: 'http://127.0.0.1:9', send: frame => { reports.push(frame); }, remember, secrets: () => [], readyMs: readyMs ?? (plain ? 3000 : 20), toolsMs, pollMs: 5, lookMs: 10, reportMs: 10, enterWaitMs: 10, wordsQuietMs: 40,
    operator: { dir: join(home, 'operator'), send: frame => { sent.push(frame); return true; }, connected: () => true },
  });
  const abort = new AbortController();
  const running = host.run({ key: agentKey, program: codexProgram, bin: 'codex', home, signedOut: /signed out/i, ...(plain ? {} : { operatorDelivery: { id: deliveryId, ordinal: 1 } }), input: { agentKey, jobId, prompt: WORDS, sessionId: null, model: null, workDir, signal: abort.signal, timeoutMs: 60000, onEvent: () => {} } } as never);
  stops.push(async () => { abort.abort(); await onClock(host.stop()); await onClock(running.catch(() => {})); rmSync(home, { recursive: true, force: true }); });
  const enters = () => keys.mock.calls.filter(([, key]) => key === 'Enter').length;
  /* The next turn of the same program, in the same session. */
  const next = (prompt: string, more: object = {}) => host.run({ key: agentKey, program: codexProgram, bin: 'codex', home, signedOut: /signed out/i, operatorDelivery: { id: randomUUID(), ordinal: 2 }, input: { agentKey, jobId: randomUUID(), prompt, sessionId, model: null, workDir, signal: abort.signal, timeoutMs: 60000, onEvent: () => {}, ...more } } as never);
  return { host, running, next, paste, keys, enters, finish, sent, reports, record, agentKey, deliveryId, sessionId, workDir, tmux };
}

const empty = (over: Partial<Program> = {}): Program => ({ input: '', status: 'idle', onPaste() {}, onEnter() {}, ...over });

it('types lost words again though the program still said something of before them as they went in', async () => {
  const c = await started(empty());
  await untilOnClock(() => c.sent.some(frame => frame.type === 'program.delivery' && frame.phase === 'attempt'));
  await untilOnClock(() => {
    try { c.record({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'The end of what it said before.' }] } } }); return true; }
    catch { return false; }
  });
  await untilOnClock(() => c.paste.mock.calls.length > 1);
  expect(c.paste.mock.calls.map(([, text]) => text)).toEqual([WORDS, WORDS]);
});

it('tells the server the session of a turn while it runs, as a node that restarts cannot tell it later', async () => {
  const c = await started(empty({ onEnter: () => { c.record(userMessage(WORDS)); c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'work' } }); } }));
  await untilOnClock(() => c.reports.some(frame => frame.type === 'job.program' && frame.session === c.sessionId));
  c.finish();
  expect(await onClock(c.running)).toMatchObject({ ok: true });
});

/* A node goes on only in a session it remembers, and a restart keeps it from hearing the end of the turn it cut. */
it('remembers the session it tells the server of while the turn runs', async () => {
  const remembered: [string, string][] = [];
  const c = await started(empty({ onEnter: () => { c.record(userMessage(WORDS)); c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'work' } }); } }), { remember: (session, dir) => remembered.push([session, dir]) });
  await untilOnClock(() => c.reports.some(frame => frame.type === 'job.program' && frame.session === c.sessionId));
  expect(remembered).toEqual([[c.sessionId, c.workDir]]);
  c.finish();
  await onClock(c.running);
});

it('presses Enter again while the words stay in the input', async () => {
  const program = empty();
  let presses = 0;
  const c = await started({ ...program, get input() { return program.input; }, get status() { return 'idle'; }, onPaste: text => { program.input = text; }, onEnter: () => { if (++presses === 3) { program.input = ''; c.finish(); } } });
  expect(await onClock(c.running)).toMatchObject({ ok: true });
  expect(c.paste.mock.calls.map(([, text]) => text)).toEqual([WORDS]);
  expect(presses).toBe(3);
  expect(c.sent.filter(frame => frame.type === 'program.delivery' && frame.phase === 'attempt')).toHaveLength(1);
  expect(c.sent).toContainEqual(expect.objectContaining({ type: 'program.delivery', phase: 'taken', deliveryId: c.deliveryId }));
});

it('types the words again in the same turn when the program lost them', async () => {
  let pastes = 0;
  const program = empty();
  const c = await started({ ...program, onPaste: () => { pastes++; }, onEnter: () => { if (pastes === 2) c.finish(); } });
  expect(await onClock(c.running)).toMatchObject({ ok: true });
  expect(c.paste.mock.calls.map(([, text]) => text)).toEqual([WORDS, WORDS]);
  expect(c.sent.filter(frame => frame.type === 'program.delivery' && frame.phase === 'attempt')).toHaveLength(1);
  expect(c.sent.filter(frame => frame.type === 'program.operator_needed')).toEqual([]);
});

it('does not type them again while the program shows that it works', async () => {
  let ticks = 0;
  const c = await started({ input: '', get status() { return `Working ${++ticks}`; }, onPaste() {}, onEnter() {} });
  await untilOnClock(() => c.paste.mock.calls.length === 1);
  await vi.advanceTimersByTimeAsync(200);
  expect(c.paste).toHaveBeenCalledTimes(1);
  c.finish();
  expect(await onClock(c.running)).toMatchObject({ ok: true });
  expect(c.paste).toHaveBeenCalledTimes(1);
});

it('does not type them again after the program recorded them', async () => {
  let pasted = false;
  const c = await started(empty({ onPaste: () => { pasted = true; }, onEnter: () => { if (pasted) c.finish(); } }));
  expect(await onClock(c.running)).toMatchObject({ ok: true });
  await vi.advanceTimersByTimeAsync(120);
  expect(c.paste).toHaveBeenCalledTimes(1);
});

/* On a busy machine a program can take the words and say so only after it stood still long enough for them to be typed
   again. The copy then stays in its input, folded as a long paste: the next turn erases it rather than waiting on it. */
it('erases a copy of its words it typed again while the program was on its way to record them', async () => {
  const program = empty();
  let pastes = 0, busy = false;
  const c = await started({
    ...program, get input() { return program.input; },
    onPaste: () => { program.input = '[Pasted Content 2047 chars]'; if (++pastes === 2) c.finish(); },
    onEnter: () => { if (!busy) { busy = true; program.input = ''; } },
    onErase: () => { program.input = ''; },
  });
  expect(await onClock(c.running)).toMatchObject({ ok: true });
  expect(program.input).not.toBe('');
  /* The program took these words: whoever looks at its screen is not told to send them. */
  expect(await c.host['programFacts'](c.agentKey)).toMatchObject({ input: 'words', undelivered: false });
  busy = false;
  const next = c.next('Look at the release.');
  await untilOnClock(() => c.paste.mock.calls.length > 2);
  expect(c.paste.mock.calls.map(([, text]) => text)).toEqual([WORDS, WORDS, 'Look at the release.']);
  c.finish('Look at the release.', 'next');
  expect(await onClock(next)).toMatchObject({ ok: true });
  expect(c.reports.filter(frame => frame.type === 'agent.input_left')).toEqual([]);
});

/* A program that connects to its tools only after the short turn that started it ended is turned away, as no turn answers
   for them then, and goes without them for the rest of its session. The next turn starts it anew in its session before it
   types, so that turn has its tools. */
it('starts anew for the next turn a program whose tools were turned away as it connected', async () => {
  let turn = 0;
  const program = empty();
  const c = await started({ ...program, get input() { return program.input; }, onPaste: text => { program.input = text; }, onEnter: () => {
    const words = program.input;
    program.input = '';
    if (!words) return;
    /* The program lists its tools as it takes its words, as one that connected to them as it started. */
    c.host['bridge']['heardList'](c.agentKey, Date.now());
    c.finish(words, `turn-${++turn}`);
  } }, { toolsMs: 100 });
  /* Someone has its terminal open, so it stays up between the turns. */
  vi.spyOn(c.tmux, 'attach').mockReturnValue(Object.assign(new EventEmitter(), { stdin: { write: () => true }, stdout: new EventEmitter(), kill: () => {} }) as never);
  await onClock(c.host.open({ type: 'term.open', termId: 'watching', agentKey: c.agentKey, cols: 80, rows: 24, write: false }));
  expect(await onClock(c.running)).toMatchObject({ ok: true });
  await c.host.start();
  /* No turn opens while it waits for one. */
  const connect = await onClock(fetch(c.host['bridge'].agent(c.agentKey).mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) }));
  expect((await connect.json()).error).toMatchObject({ code: -32001 });
  const tools = { url: 'http://127.0.0.1:9/mcp', token: 'tok-turn' };
  expect(await onClock(c.next('Look at the release.', { tools }))).toMatchObject({ ok: true });
  expect(c.tmux.launch).toHaveBeenCalledTimes(2);
  /* Started anew, it has its tools: the turn after goes on in it, and no turn ends as one without tools. */
  expect(await onClock(c.next('Look at the checkout.', { tools }))).toMatchObject({ ok: true });
  expect(c.tmux.launch).toHaveBeenCalledTimes(2);
  expect(c.paste.mock.calls.map(([, text]) => text)).toEqual([WORDS, 'Look at the release.', 'Look at the checkout.']);
});

it('stops typing them after a few tries and leaves it to the operator case', async () => {
  const c = await started(empty());
  await untilOnClock(() => c.paste.mock.calls.length >= 3);
  await vi.advanceTimersByTimeAsync(300);
  expect(c.paste).toHaveBeenCalledTimes(3);
});

it('presses nothing into words a person typed in the input instead', async () => {
  const program: Program = empty();
  const c = await started({ ...program, get input() { return program.input; }, onPaste: () => { program.input = 'A draft of my own'; } });
  await untilOnClock(() => c.paste.mock.calls.length === 1);
  const before = c.enters();
  await vi.advanceTimersByTimeAsync(150);
  expect(c.enters()).toBe(before);
  expect(c.paste).toHaveBeenCalledTimes(1);
});

it('leaves the input to a person who started typing', async () => {
  const program: Program = empty();
  const c = await started({ ...program, get input() { return program.input; }, onPaste: text => { program.input = text; } });
  await untilOnClock(() => c.paste.mock.calls.length === 1);
  c.host['ownerTyped'](c.agentKey, { type: 'term.input', termId: 'x', data: 'x' }, () => {});
  const before = c.enters();
  await vi.advanceTimersByTimeAsync(150);
  expect(c.enters()).toBe(before);
});

/* What the browser of a person who opens the view says by itself, as tmux attaches or its window takes focus. */
const TERMINAL_ANSWERS = ['\x1b[>0;276;0c', '\x1b[I', '\x1b[O'];

it('goes on typing lost words though the terminal of a person who opens the view answers by itself', async () => {
  const c = await started(empty());
  await untilOnClock(() => c.paste.mock.calls.length === 1);
  const owner = vi.spyOn(c.host['operator']!, 'ownerInput');
  const written: string[] = [];
  for (const data of TERMINAL_ANSWERS) c.host['ownerTyped'](c.agentKey, { type: 'term.input', termId: 'x', data }, keys => { written.push(keys); });
  await untilOnClock(() => c.paste.mock.calls.length > 1);
  await untilOnClock(() => written.length === TERMINAL_ANSWERS.length);
  expect(written).toEqual(TERMINAL_ANSWERS);
  expect(owner).not.toHaveBeenCalled();
});

it('takes a shown paste for its words, as the programs fold a long one', async () => {
  const program: Program = empty();
  let presses = 0;
  const c = await started({ ...program, get input() { return program.input; }, onPaste: () => { program.input = '[Pasted Content 2047 chars]'; }, onEnter: () => { if (++presses === 2) { program.input = ''; c.finish(); } } });
  expect(await onClock(c.running)).toMatchObject({ ok: true });
  expect(presses).toBe(2);
});

describe('a program a node types into without a receipt, as a plan with no operator', () => {
  it('types the words again in the same turn when the program lost them', async () => {
    let pastes = 0;
    const c = await started(empty({ onPaste: () => { pastes++; }, onEnter: () => { if (pastes === 2) c.finish(); } }), { plain: true });
    expect(await onClock(c.running)).toMatchObject({ ok: true });
    expect(c.paste.mock.calls.map(([, text]) => text)).toEqual([WORDS, WORDS]);
  });

  it('only presses Enter while the words stay in the input', async () => {
    const program = empty();
    let presses = 0;
    const c = await started({ ...program, get input() { return program.input; }, onPaste: text => { program.input = text; }, onEnter: () => { if (++presses === 3) { program.input = ''; c.finish(); } } }, { plain: true });
    expect(await onClock(c.running)).toMatchObject({ ok: true });
    expect(c.paste).toHaveBeenCalledTimes(1);
  });

  it('types nothing again over a program that shows it works', async () => {
    let ticks = 0;
    const c = await started({ input: '', get status() { return `Working ${++ticks}`; }, onPaste() {}, onEnter() {} }, { plain: true });
    await untilOnClock(() => c.paste.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(200);
    c.finish();
    expect(await onClock(c.running)).toMatchObject({ ok: true });
    expect(c.paste).toHaveBeenCalledTimes(1);
  });

  it('goes on typing lost words though the terminal of a person who opens the view answers by itself', async () => {
    const c = await started(empty(), { plain: true });
    await untilOnClock(() => c.paste.mock.calls.length === 1);
    for (const data of TERMINAL_ANSWERS) c.host['ownerTyped'](c.agentKey, { type: 'term.input', termId: 'x', data }, () => {});
    await untilOnClock(() => c.paste.mock.calls.length > 1);
    c.finish();
    expect(await onClock(c.running)).toMatchObject({ ok: true });
  });

  /* On a busy machine the last look before the deadline can be slow, and the program take the words while it lasts. */
  it('takes the words the program took during its last look before the deadline', async () => {
    let entered = false, slowed = false;
    const c = await started(empty({ onEnter: () => { entered = true; } }), { plain: true, readyMs: 60 });
    vi.mocked(c.tmux.alive).mockImplementation(async () => {
      if (entered && !slowed) {
        slowed = true;
        c.finish();
        /* A look that lasts past the deadline, on the fake clock. */
        await new Promise(done => setTimeout(done, 120));
      }
      return true;
    });
    expect(await onClock(c.running)).toMatchObject({ ok: true });
    expect(slowed).toBe(true);
  });

  it('leaves the input to a person who started typing', async () => {
    const c = await started(empty(), { plain: true });
    await untilOnClock(() => c.paste.mock.calls.length === 1);
    c.host['ownerTyped'](c.agentKey, { type: 'term.input', termId: 'x', data: 'x' }, () => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(c.paste).toHaveBeenCalledTimes(1);
    c.finish();
    expect(await onClock(c.running)).toMatchObject({ ok: true });
  });
});
