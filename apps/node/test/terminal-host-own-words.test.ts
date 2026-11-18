import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OperatorDelivery, OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { RESTART_AFTER_MS } from '@hornhoof/protocol/map';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalHost, type TermJob } from '../src/terminal/host.js';
import { inputOf } from '../src/terminal/input.js';
import { claudeProgram, claudeTranscript } from '../src/providers/claude-terminal.js';
import { Tmux } from '../src/terminal/tmux.js';
import { real } from './real-screens.js';

/* Words Hornhoof typed into a program that missed their Enter, on the screen real Claude Code 2.1.319 shows after it was
   interrupted and started again. Only Hornhoof's side runs: a program stand-in behind a mocked tmux, on virtual time. */
const ROW = '❯ ';
const INTERRUPTED = real('claude-2.1.319-interrupted-resumed');
const PROMPT = 'Check the checkout.';
const PERSON = 'please also look at the failing check';
const HANG = 'Think on until the program is restarted.';

/* The real screen with what its input row holds now, drawn as the real capture with words in it draws them. */
function shown(input: string): string {
  const at = INTERRUPTED.lastIndexOf(ROW) + ROW.length;
  return INTERRUPTED.slice(0, at) + input + INTERRUPTED.slice(INTERRUPTED.indexOf('\n', at));
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* Virtual time goes on in small steps, and each step lets the files the host reads and writes settle. */
async function waitFor(check: () => boolean | Promise<boolean>, ms = 300_000): Promise<void> {
  for (let spent = 0; spent <= ms; spent += 50) {
    if (await check()) return;
    await vi.advanceTimersByTimeAsync(50);
    await new Promise(done => setImmediate(done));
  }
  throw new Error('The awaited state did not come.');
}

/* Claude Code as the node sees it: its screen, its input row, its hooks and its transcript. Enter goes nowhere while it
   takes no words, as on an overloaded machine. */
function program() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hh-own-words-')));
  const workDir = join(home, 'work');
  mkdirSync(workDir, { recursive: true });
  const key = randomUUID();
  const tmux = new Tmux({ env: { HOME: home } });
  const frames: OperatorNodeMessage[] = [];
  const state = { input: '', session: '', takes: false, launches: 0, prompts: [] as string[], keys: [] as string[] };
  const record = (line: object) => appendFileSync(claudeTranscript(home, workDir, state.session), `${JSON.stringify(line)}\n`);
  const host = new TerminalHost({
    tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], pollMs: 50, lookMs: 100, enterWaitMs: 1000,
    operator: { dir: join(home, 'operator'), send: frame => { frames.push(frame); return true; }, connected: () => true, now: () => Date.now() },
  });
  const submit = async () => {
    if (!state.input || !state.takes) return;
    const text = state.input;
    state.input = '';
    state.prompts.push(text);
    await host['hook'](key, 'prompt', { prompt: text, session_id: state.session });
    record({ type: 'user', message: { role: 'user', content: text } });
    /* A turn told to hang thinks on, as one a restart is for. */
    if (text === HANG) return;
    record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
    record({ type: 'system', subtype: 'turn_duration' });
  };
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  vi.spyOn(tmux, 'launch').mockImplementation(async (_name, spec) => {
    const at = spec.command.findIndex(arg => arg === '--session-id' || arg === '--resume');
    state.session = spec.command[at + 1]!;
    state.input = '';
    state.launches++;
    mkdirSync(dirname(claudeTranscript(home, workDir, state.session)), { recursive: true });
    record({ type: 'metadata' });
    await host['hook'](key, 'start', { session_id: state.session });
  });
  vi.spyOn(tmux, 'run').mockResolvedValue('160 48');
  vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  vi.spyOn(tmux, 'screen').mockImplementation(async () => shown(state.input));
  const paste = vi.spyOn(tmux, 'paste').mockImplementation(async (_name, text) => { state.input += text; });
  vi.spyOn(tmux, 'keys').mockImplementation(async (_name, ...keys) => {
    for (const pressed of keys) {
      state.keys.push(pressed);
      if (pressed === 'C-u') state.input = state.input.slice(0, state.input.lastIndexOf('\n') + 1);
      if (pressed === 'BSpace') state.input = state.input.slice(0, -1);
      if (pressed === 'Enter') await submit();
    }
  });
  const job = (jobId: string, more: Partial<TermJob> = {}, prompt = PROMPT): TermJob => ({
    key, program: claudeProgram, bin: 'claude', home, signedOut: /not logged in/i, ...more,
    input: { agentKey: key, jobId, prompt, sessionId: state.session || null, model: null, workDir, secret: null, timeoutMs: 3_600_000, instructions: null, tools: null },
  });
  const pastes = (text: string) => paste.mock.calls.filter(([, pasted]) => pasted === text).length;
  const recovery = async () => {
    const request = randomUUID();
    await host.operatorMessage({ type: 'program.recovery_state_get', agentKey: key, jobId: null, instance: randomUUID(), request, case: randomUUID() });
    return frames.find(frame => frame.type === 'program.recovery_state' && frame.request === request);
  };
  const view = async () => {
    const request = randomUUID();
    await host.operatorMessage({ type: 'program.view_get', agentKey: key, request });
    return frames.find(frame => frame.type === 'program.view' && frame.request === request);
  };
  stops.push(async () => { state.takes = true; await host.stop(); rmSync(home, { recursive: true, force: true }); });
  return { host, key, frames, state, job, pastes, recovery, view, agent: () => host['agents'].get(key)! };
}

/* An assignment the program never took: its words stay in the input, the server's case for them closes, the turn ends. */
async function heldWithOwnWords(c: ReturnType<typeof program>, source: OperatorDelivery, meanwhile = () => {}) {
  const jobId = randomUUID();
  const running = c.host.run(c.job(jobId, { operatorDelivery: source }));
  await waitFor(() => c.state.input === PROMPT);
  await waitFor(() => c.frames.some(frame => frame.type === 'program.operator_needed' && frame.reason === 'assignment_unrecorded'));
  expect(await c.view()).toMatchObject({ result: 'ok', input: 'hornhoof', undelivered: true });
  const needed = c.frames.find(frame => frame.type === 'program.operator_needed')!;
  const incident = { agentKey: c.key, jobId, instance: needed.instance, case: randomUUID(), capability: randomUUID(), reason: 'assignment_unrecorded' as const };
  meanwhile();
  await c.host.operatorMessage({ type: 'program.operator_case', ...incident, revision: 1, disposition: 'open', remainingMs: 600_000 });
  await c.host.operatorMessage({ type: 'program.operator_case', ...incident, revision: 2, disposition: 'revoke', remainingMs: 0, closedBecause: 'operator_unavailable' });
  let ended = false;
  void running.then(() => { ended = true; });
  await waitFor(() => ended);
  expect(await running).toMatchObject({ ok: false, error: 'agent_failed' });
  return { jobId, incident, sessionId: (await running).sessionId };
}

const readies = (c: ReturnType<typeof program>) => c.frames.filter(frame => frame.type === 'program.recovery_ready');

it('reads the real interrupted screens of Claude Code 2.1.319 as an empty input, a paste and a draft', () => {
  expect(inputOf('claude', real('claude-2.1.319-interrupted'))).toBe('');
  expect(inputOf('claude', INTERRUPTED)).toBe('');
  expect(inputOf('claude', real('claude-2.1.319-interrupted-resumed-pasted'))).toBe('Continue task #42: read the task with the task tool first, then go on with the work.');
  expect(inputOf('claude', real('claude-2.1.319-interrupted-resumed-draft'))).toBe(PERSON);
  expect(inputOf('claude', shown(PERSON))).toBe(PERSON);
});

it("delivers Hornhoof's own words left in a held program's input, once, without a person's Enter", async () => {
  const c = program();
  const source = { id: randomUUID(), ordinal: 1 };
  const held = await heldWithOwnWords(c, source);
  expect(c.state.input).toBe(PROMPT);
  await c.host['look'](c.agent());
  await c.host['look'](c.agent());
  expect(readies(c)).toEqual([expect.objectContaining({ case: held.incident.case, owner: false })]);
  expect(await c.recovery()).toMatchObject({ program: 'here', input: 'hornhoof' });
  c.state.takes = true;
  const continuation = c.host.run(c.job(randomUUID(), { operatorDelivery: { id: randomUUID(), ordinal: 2 }, operatorSourceDelivery: source }));
  let ended = false;
  void continuation.then(() => { ended = true; });
  await waitFor(() => ended);
  expect(await continuation).toMatchObject({ ok: true });
  expect(c.state.prompts).toEqual([PROMPT]);
  expect(c.pastes(PROMPT)).toBe(2);
});

it('leaves words a person typed after Hornhoof alone: no Enter, no erasing, no readiness', async () => {
  const c = program();
  /* A person at the terminal adds to the words while the turn waits for the program: Hornhoof hears each of their keys. */
  await heldWithOwnWords(c, { id: randomUUID(), ordinal: 1 }, () => { c.agent().typedAt = Date.now(); c.state.input = `${PROMPT} ${PERSON}`; });
  const pressed = c.state.keys.length;
  for (let look = 0; look < 5; look++) {
    await c.host['look'](c.agent());
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(readies(c)).toEqual([]);
  expect(c.state.keys.slice(pressed)).toEqual([]);
  expect(c.state.input).toBe(`${PROMPT} ${PERSON}`);
  expect(c.state.prompts).toEqual([]);
  expect(await c.view()).toMatchObject({ result: 'ok', input: 'words', undelivered: true });
  expect(await c.recovery()).toMatchObject({ program: 'here', input: 'words' });
});

it('types an assignment into a program resumed at the real interrupted screen with its first Enter', async () => {
  const c = program();
  c.state.takes = true;
  const source = { id: randomUUID(), ordinal: 1 };
  const running = c.host.run(c.job(randomUUID(), { operatorDelivery: source }));
  let ended = false;
  void running.then(() => { ended = true; });
  await waitFor(() => ended);
  expect(await running).toMatchObject({ ok: true });
  expect(c.state.prompts).toEqual([PROMPT]);
  expect(c.state.keys.filter(pressed => pressed === 'Enter')).toHaveLength(1);
  expect(c.frames).toContainEqual(expect.objectContaining({ type: 'program.delivery', deliveryId: source.id, phase: 'taken' }));
  expect(c.frames.filter(frame => frame.type === 'program.operator_needed')).toEqual([]);
});

it('presses Enter again for the words a restarted program shows but did not take', async () => {
  const c = program();
  c.state.takes = true;
  const jobId = randomUUID();
  const running = c.host.run(c.job(jobId, {}, HANG));
  await waitFor(() => c.state.prompts.length === 1);
  c.state.prompts.length = 0;
  c.state.takes = false;
  /* The program gave no sign for longer than a restart waits: the clock jumps there, no look runs in between. */
  vi.setSystemTime(Date.now() + RESTART_AFTER_MS.claude! + 1000);
  let restarted: unknown = null;
  void c.host.restart(c.key, jobId, 'Continue.').then(result => { restarted = result; });
  await waitFor(() => restarted !== null);
  expect(restarted).toEqual({ ok: true, reason: null });
  expect(c.state.launches).toBe(2);
  expect(c.state.input).toBe('Continue.');
  expect(await c.view()).toMatchObject({ result: 'ok', input: 'hornhoof', undelivered: true });
  await vi.advanceTimersByTimeAsync(5000);
  c.state.takes = true;
  let ended = false;
  void running.then(() => { ended = true; });
  await waitFor(() => ended);
  expect(await running).toMatchObject({ ok: true });
  expect(c.state.prompts).toEqual(['Continue.']);
});

it('does not submit a person\'s words when they edit during the retry input capture', async () => {
  const c = program();
  c.state.takes = true;
  void c.host.run(c.job(randomUUID(), {}, HANG));
  await waitFor(() => c.state.prompts.length === 1);
  const agent = c.agent();
  const turn = agent.turn!;
  agent.took = false;
  const pastedAt = Date.now();
  c.state.input = PROMPT;
  const before = c.state.keys.length;
  const reader = c.host as unknown as { readInput(agent: unknown): Promise<string | null> };
  vi.spyOn(reader, 'readInput').mockImplementationOnce(async () => {
    /* The capture began before the person's key, but its answer arrives after that key. */
    agent.typedAt = Date.now();
    c.state.input = `${PROMPT} ${PERSON}`;
    return PROMPT;
  });
  void c.host['enterUntilTaken'](agent, turn, PROMPT, pastedAt);
  await vi.advanceTimersByTimeAsync(1000);
  expect(c.state.keys.slice(before)).not.toContain('Enter');
  expect(c.state.input).toBe(`${PROMPT} ${PERSON}`);
  expect(c.state.prompts).toEqual([HANG]);
});
