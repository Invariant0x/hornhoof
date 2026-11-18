import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NodeMessage } from '@hornhoof/protocol';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { codexProgram } from '../src/providers/codex-terminal.js';
import { Tmux } from '../src/terminal/tmux.js';
import { userMessage } from './fakes/word-receipts.mjs';
import { job, onClock, untilOnClock } from './terminal-host-helpers.js';
import { codexPrompt } from './real-screens.js';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([['stable', false, false], ['changing', true, false], ['cancelled', false, true]] as const)('keeps an unknown pane and guards its assignment paste through %s recovery', async (_mode, changes, cancelled) => {
  vi.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), 'hh-operator-start-'));
  const agentKey = randomUUID(), jobId = randomUUID(), deliveryId = randomUUID(), sessionId = randomUUID();
  const workDir = join(home, 'work');
  const file = join(home, 'sessions/2026/11/04', `rollout-${sessionId}.jsonl`);
  const record = (line: object) => appendFileSync(file, JSON.stringify(line) + '\n');
  const tmux = new Tmux({ env: { HOME: home } });
  let ready = false, pasted = '', now = 0, changed = false;
  const abort = new AbortController();
  const sent: OperatorNodeMessage[] = [], ordinary: NodeMessage[] = [];
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  vi.spyOn(tmux, 'launch').mockImplementation(async () => {
    mkdirSync(dirname(file), { recursive: true });
    record({ type: 'session_meta', payload: { id: sessionId, cwd: workDir } });
  });
  vi.spyOn(tmux, 'run').mockResolvedValue('80 24');
  vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  vi.spyOn(tmux, 'screen').mockImplementation(async () => {
    if (cancelled && ready && host['agents'].get(agentKey)?.typing === 'Check the checkout.') { ready = false; abort.abort(); }
    if (!ready) return 'Choose the new display theme. Press Enter.';
    if (changes && !changed) { changed = true; queueMicrotask(() => { ready = false; }); }
    return `OpenAI Codex\n${codexPrompt(pasted)}`;
  });
  const paste = vi.spyOn(tmux, 'paste').mockImplementation(async (_target, text) => { pasted = text; });
  const keys = vi.spyOn(tmux, 'keys').mockImplementation(async (_target, ...pressed) => {
    if (!pressed.includes('Enter')) return;
    if (!ready) { ready = true; return; }
    record(userMessage(pasted));
    record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'work' } });
    record({ type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } });
    record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'work', last_agent_message: 'Done.' } });
  });
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: frame => ordinary.push(frame), secrets: () => [], readyMs: 20, pollMs: 5, lookMs: 10, enterWaitMs: 10,
    operator: { dir: join(home, 'operator'), send: frame => { sent.push(frame); return true; }, connected: () => true, now: () => now },
  });
  const running = host.run({ key: agentKey, program: codexProgram, bin: 'codex', home, signedOut: /signed out/i, operatorDelivery: { id: deliveryId, ordinal: 1 }, input: { agentKey, jobId, prompt: 'Check the checkout.', sessionId: null, model: null, workDir, secret: null, timeoutMs: 20000, instructions: null, tools: null, signal: abort.signal } });
  stops.push(async () => { ready = true; record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'work', last_agent_message: 'Done.' } }); await onClock(host.stop()); await onClock(running); rmSync(home, { recursive: true, force: true }); });
  await untilOnClock(() => sent.some(frame => frame.type === 'program.delivery' && frame.phase === 'attempt'));
  expect(paste).not.toHaveBeenCalled();
  now = 59999; host.operatorTick();
  expect(sent.filter(frame => frame.type === 'program.operator_needed')).toEqual([]);
  now = 60000; host.operatorTick(); host.operatorTick();
  await untilOnClock(() => sent.some(frame => frame.type === 'program.operator_needed'));
  host.operatorTick();
  const needed = sent.filter(frame => frame.type === 'program.operator_needed');
  expect(needed).toHaveLength(1);
  expect(needed[0]).toMatchObject({ reason: 'assignment_unrecorded', deliveryId, check: { input: 'unknown', screen: { cells: expect.stringContaining('Choose the new display theme') } } });
  const identity = { agentKey, jobId, instance: needed[0]!.instance };
  const capability = randomUUID(), caseId = randomUUID();
  /* Operations look at the program and press Enter on what it shows, as the server lets them. */
  const press = async () => {
    const request = randomUUID(), action = randomUUID();
    await host.operatorMessage({ type: 'program.view_get', agentKey, request });
    const view = sent.find(frame => frame.type === 'program.view' && frame.request === request);
    expect(view).toMatchObject({ result: 'ok', jobId, instance: identity.instance, cells: expect.stringContaining('Choose the new display theme') });
    if (view?.type !== 'program.view') throw new Error('The program view was not returned.');
    await host.operatorMessage({ type: 'program.input_send', agentKey, action, snapshot: view.snapshot!, keys: ['Enter'], text: null, auditReason: 'Continue the program.' });
    expect(sent.find(frame => frame.type === 'program.input_result' && frame.action === action)).toMatchObject({ result: 'applied', reason: null });
  };
  await host.operatorMessage({ type: 'program.operator_case', ...identity, case: caseId, capability, disposition: 'open', remainingMs: 600000, revision: 1 });
  await press();
  if (changes) {
    await untilOnClock(() => changed);
    await vi.advanceTimersByTimeAsync(600);
    expect(paste).not.toHaveBeenCalled();
    now += 1001;
    await press();
  }
  if (cancelled) {
    expect(await onClock(running)).toMatchObject({ ok: false, error: 'cancelled' });
    expect(paste).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({ type: 'program.delivery', deliveryId, phase: 'cancelled' }));
    return;
  }
  expect(await onClock(running)).toMatchObject({ ok: true });
  expect(paste.mock.calls.map(([, text]) => text)).toEqual(['Check the checkout.']);
  expect(keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(changes ? 3 : 2);
  expect(sent).toContainEqual(expect.objectContaining({ type: 'program.delivery', deliveryId, phase: 'taken' }));
});

/* A busy node may check who sends Claude Code's start only after the caller gave up waiting, and then refuses it. */
it('types the words into a Claude Code whose start the node could not prove came from it, once its input shows', async () => {
  /* The host runs on the fake clock, which moves only as the test moves it; turns of the event loop stay real, for the
     socket of the bridge. */
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  const home = mkdtempSync(join(tmpdir(), 'hh-operator-unproven-'));
  const agentKey = randomUUID(), jobId = randomUUID(), words = 'Check the checkout.';
  const tmux = new Tmux({ env: { HOME: home } });
  let input = '';
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  vi.spyOn(tmux, 'run').mockResolvedValue('80 24');
  vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  vi.spyOn(tmux, 'screen').mockImplementation(async () => `❯ ${input}\n`);
  vi.spyOn(tmux, 'keys').mockResolvedValue();
  const paste = vi.spyOn(tmux, 'paste').mockImplementation(async (_target, text) => { input = text; });
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], log: () => {}, readyMs: 20, pollMs: 5, lookMs: 10, enterWaitMs: 10,
    owner: () => ({ owns: async () => false }),
    operator: { dir: join(home, 'operator'), send: () => true, connected: () => true },
  });
  await host.start();
  const starts: number[] = [];
  /* The start reaches the bridge on a real socket: while it is on its way there and back, the clock stands still. */
  let transit = 0;
  const clocked = { held: () => transit > 0 };
  vi.spyOn(tmux, 'launch').mockImplementation(async () => {
    transit++;
    try { starts.push((await fetch(`${host['bridge'].agent(agentKey).hookUrl}/start`, { method: 'POST', body: '{}' })).status); }
    finally { transit--; }
  });
  const abort = new AbortController();
  const running = host.run({ ...job(agentKey, words, { jobId, workDir: join(home, 'work'), signal: abort.signal }), home, operatorDelivery: { id: randomUUID(), ordinal: 1 } });
  stops.push(async () => { abort.abort(); await onClock(host.stop(), clocked); await onClock(running.catch(() => {}), clocked); rmSync(home, { recursive: true, force: true }); });
  await untilOnClock(() => paste.mock.calls.length > 0, clocked);
  expect(starts).toEqual([403]);
  expect(paste.mock.calls.map(([, text]) => text)).toEqual([words]);
});

/* Neo's turn b559a00c on 17.11, as recorded: the node had no receipt of its assignment (delivery 268), as it refused the
   program's hooks, but it recorded the live words after it (delivery 269) taken at 01:50:48. The operator's case 5f366ecb
   closed as failed at 02:06:13, and the program ran tools after that. A case that ends fails no turn whose program went on
   past its words: the turn runs until its end comes, someone stops it or its program is gone. */
it.each([['is stopped', true], ['loses its program', false]] as const)('runs a turn whose program took later words on after its case closed, until it %s', async (_name, alive) => {
  vi.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), 'hh-operator-later-'));
  const agentKey = randomUUID(), jobId = randomUUID(), sessionId = randomUUID();
  const workDir = join(home, 'work');
  const file = join(home, 'sessions/2026/11/17', `rollout-${sessionId}.jsonl`);
  const record = (line: object) => appendFileSync(file, JSON.stringify(line) + '\n');
  const tmux = new Tmux({ env: { HOME: home } });
  let input = '', running = true;
  const sent: OperatorNodeMessage[] = [];
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  vi.spyOn(tmux, 'launch').mockImplementation(async () => {
    mkdirSync(dirname(file), { recursive: true });
    record({ type: 'session_meta', payload: { id: sessionId, cwd: workDir } });
  });
  vi.spyOn(tmux, 'run').mockResolvedValue('80 24');
  vi.spyOn(tmux, 'alive').mockImplementation(async () => running);
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  vi.spyOn(tmux, 'screen').mockImplementation(async () => `OpenAI Codex\n${codexPrompt(input)}`);
  vi.spyOn(tmux, 'paste').mockImplementation(async (_target, text) => { input = text; });
  /* The program takes its words, and nothing of that reaches the node. */
  let entered = 0;
  vi.spyOn(tmux, 'keys').mockImplementation(async (_target, ...pressed) => { if (pressed.includes('Enter') && input) { input = ''; entered++; } });
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], readyMs: 20, pollMs: 5, lookMs: 10, enterWaitMs: 10,
    operator: { dir: join(home, 'operator'), send: frame => { sent.push(frame); return true; }, connected: () => true },
  });
  const abort = new AbortController();
  const turn = host.run({ key: agentKey, program: codexProgram, bin: 'codex', home, signedOut: /signed out/i, operatorDelivery: { id: randomUUID(), ordinal: 268 }, input: { agentKey, jobId, prompt: 'Check the checkout.', sessionId: null, model: null, workDir, secret: null, timeoutMs: 600000, instructions: null, tools: null, signal: abort.signal } });
  let result: Awaited<typeof turn> | null = null;
  void turn.then(done => { result = done; });
  stops.push(async () => { running = false; await onClock(host.stop()); await onClock(turn); rmSync(home, { recursive: true, force: true }); });
  /* The assignment went into the program, and later the live words after it, which the node recorded as taken. */
  await untilOnClock(() => entered > 0);
  await vi.advanceTimersByTimeAsync(200);
  const runtime = host['operator']!, later = { id: randomUUID(), ordinal: 269 };
  runtime.live(agentKey, later, 'Also read the review.');
  runtime.receipt(agentKey, later, 'taken');
  const opened = { type: 'program.operator_case' as const, ...runtime.identity(agentKey)!, case: randomUUID(), capability: randomUUID(), remainingMs: 600000, revision: 1, reason: 'assignment_unrecorded' as const };
  await host.operatorMessage({ ...opened, disposition: 'open' });
  await host.operatorMessage({ ...opened, disposition: 'revoke', revision: 2, remainingMs: 0, closedBecause: 'failed' });
  await vi.advanceTimersByTimeAsync(200);
  expect(result).toBeNull();
  if (!alive) {
    running = false;
    expect(await onClock(turn)).toMatchObject({ ok: false, error: 'agent_failed' });
    return;
  }
  record({ type: 'event_msg', payload: { type: 'item_completed', turn_id: 'work', item: { type: 'CommandExecution', command: 'git diff', exit_code: 0, aggregated_output: '' } } });
  await vi.advanceTimersByTimeAsync(1000);
  expect(result).toBeNull();
  abort.abort();
  expect(await onClock(turn)).toMatchObject({ ok: false, error: 'cancelled' });
});
