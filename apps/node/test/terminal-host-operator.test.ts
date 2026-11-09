import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NodeMessage } from '@hornhoof/protocol';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { codexProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';
import { userMessage } from './fakes/word-receipts.mjs';
import { until } from './terminal-host-helpers.js';
import { codexPrompt } from './real-screens.js';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.restoreAllMocks(); });

it.each([['stable', false, false], ['changing', true, false], ['cancelled', false, true]] as const)('keeps an unknown pane and guards its assignment paste through %s recovery', async (_mode, changes, cancelled) => {
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
  stops.push(async () => { ready = true; record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'work', last_agent_message: 'Done.' } }); await host.stop(); await running; rmSync(home, { recursive: true, force: true }); });
  await until(() => sent.some(frame => frame.type === 'program.delivery' && frame.phase === 'attempt'));
  expect(paste).not.toHaveBeenCalled();
  now = 59999; host.operatorTick();
  expect(sent.filter(frame => frame.type === 'program.operator_needed')).toEqual([]);
  now = 60000; host.operatorTick(); host.operatorTick();
  await until(() => sent.some(frame => frame.type === 'program.operator_needed'));
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
    await host.operatorMessage({ type: 'program.input_send', agentKey, action, snapshot: view.snapshot!, keys: ['Enter'], text: null });
    expect(sent.find(frame => frame.type === 'program.input_result' && frame.action === action)).toMatchObject({ result: 'applied', reason: null });
  };
  await host.operatorMessage({ type: 'program.operator_case', ...identity, case: caseId, capability, disposition: 'open', remainingMs: 600000, revision: 1 });
  await press();
  if (changes) {
    await until(() => changed);
    await new Promise(done => setTimeout(done, 600));
    expect(paste).not.toHaveBeenCalled();
    now += 1001;
    await press();
  }
  if (cancelled) {
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
    expect(paste).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({ type: 'program.delivery', deliveryId, phase: 'cancelled' }));
    return;
  }
  expect(await running).toMatchObject({ ok: true });
  expect(paste.mock.calls.map(([, text]) => text)).toEqual(['Check the checkout.']);
  expect(keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(changes ? 3 : 2);
  expect(sent).toContainEqual(expect.objectContaining({ type: 'program.delivery', deliveryId, phase: 'taken' }));
});
