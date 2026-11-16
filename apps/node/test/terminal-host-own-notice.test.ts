import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NodeMessage } from '@hornhoof/protocol';
import type { OperatorDelivery, OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalHost, type TermJob } from '../src/terminal/host.js';
import { claudeProgram, claudeTranscript } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';

/* Claude Code 2.1.325 starts a turn by itself for a task notice of its own, as a turn ends with background commands still
   unfinished. Hornhoof's next words went in half a second later and joined that turn, as the logs of two employees showed
   on 16.11 (claude-own-notice.jsonl holds the order of their lines). The screens are real ones: an idle Claude Code with
   its dim suggestion in the input row, and one at work. Only Hornhoof's side runs, behind a mocked tmux, on virtual time. */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const IDLE = fixture('claude-idle-screen.txt');
const BUSY = fixture('claude-busy-screen.txt');
const SUGGESTION = /❯ \x1b\[2m[^\n]*/;
const NOTICE = fixture('claude-own-notice.jsonl').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
const FIRST = 'Look at the copy of the database.';
const SECOND = 'You ended your last turn without moving the task. Go on with the work.';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* Virtual time goes on in small steps, and each step lets the files the host reads and writes settle. */
async function step(): Promise<void> {
  await vi.advanceTimersByTimeAsync(50);
  await new Promise(done => setImmediate(done));
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 300_000): Promise<void> {
  for (let spent = 0; spent <= ms; spent += 50) {
    if (await check()) return;
    await step();
  }
  throw new Error('The awaited state did not come.');
}

async function pass(ms: number): Promise<void> {
  for (let spent = 0; spent < ms; spent += 50) await step();
}

/* Claude Code as the node sees it: its screen, hooks and log. A notice it starts a turn for goes in just before the next
   words do; a turn it is told to hang on goes on until the test ends it. */
function program() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hh-own-notice-')));
  const workDir = join(home, 'work');
  mkdirSync(workDir, { recursive: true });
  const key = randomUUID();
  const tmux = new Tmux({ env: { HOME: home } });
  const frames: OperatorNodeMessage[] = [], sent: NodeMessage[] = [];
  const state = { input: '', session: '', working: false, suggests: true, notice: false, hang: false, prompts: [] as string[] };
  const record = (line: object) => appendFileSync(claudeTranscript(home, workDir, state.session), `${JSON.stringify(line)}\n`);
  const host = new TerminalHost({
    tmux, hornhoof: 'http://127.0.0.1:9', send: message => sent.push(message), secrets: () => [], pollMs: 50, lookMs: 100, enterWaitMs: 1000,
    operator: { dir: join(home, 'operator'), send: frame => { frames.push(frame); return true; }, connected: () => true, now: () => Date.now() },
  });
  /* Someone has the terminal open, so the program stays up between turns, as both programs did. */
  host['wanted'].set('watching', { key, size: { cols: 160, rows: 48 } });
  const agent = () => host['agents'].get(key)!;
  /* Claude Code ends a turn with its Stop hook and the turn's duration in its log. */
  const notice = () => {
    for (const line of NOTICE) record(line);
    host['drain'](agent());
  };
  const end = async () => {
    record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
    state.working = false;
    await host['hook'](key, 'stop', { last_assistant_message: 'Done.', session_id: state.session });
    record({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
  };
  const submit = async () => {
    if (!state.input) return;
    const text = state.input;
    state.input = '';
    state.working = true;
    if (state.notice) {
      state.notice = false;
      notice();
    }
    state.prompts.push(text);
    await host['hook'](key, 'prompt', { prompt: text, session_id: state.session });
    record({ type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' }, promptSource: 'typed' });
    const id = `toolu_${state.prompts.length}`;
    record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'git status' } }] } });
    record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'clean' }] } });
    if (!state.hang) await end();
  };
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  vi.spyOn(tmux, 'launch').mockImplementation(async (_name, spec) => {
    const at = spec.command.findIndex(arg => arg === '--session-id' || arg === '--resume');
    state.session = spec.command[at + 1]!;
    mkdirSync(dirname(claudeTranscript(home, workDir, state.session)), { recursive: true });
    record({ type: 'metadata' });
    await host['hook'](key, 'start', { session_id: state.session });
  });
  vi.spyOn(tmux, 'run').mockResolvedValue('160 48');
  vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  /* The input row: what is typed, or else the dim suggestion while the program offers one. */
  vi.spyOn(tmux, 'screen').mockImplementation(async () => {
    if (state.working) return BUSY.replace('❯ \n', () => `❯ ${state.input}\n`);
    return state.input || !state.suggests ? IDLE.replace(SUGGESTION, () => `❯ ${state.input}`) : IDLE;
  });
  vi.spyOn(tmux, 'paste').mockImplementation(async (_name, text) => { state.input += text; });
  vi.spyOn(tmux, 'keys').mockImplementation(async (_name, ...keys) => {
    for (const pressed of keys) {
      if (pressed === 'C-u') state.input = '';
      /* The program answers its Enter on its own time, as a real one does, not inside the key press. */
      if (pressed === 'Enter') void submit();
    }
  });
  const job = (prompt: string, operatorDelivery: OperatorDelivery): TermJob => ({
    key, program: claudeProgram, bin: 'claude', home, signedOut: /not logged in/i, operatorDelivery,
    input: { agentKey: key, jobId: randomUUID(), prompt, sessionId: state.session || null, model: null, workDir, secret: null, timeoutMs: 3_600_000, instructions: null, tools: null },
  });
  const start = (prompt: string, delivery = { id: randomUUID(), ordinal: 1 }) => ({ running: host.run(job(prompt, delivery)), delivery });
  const turn = async (prompt: string) => {
    let ended = false;
    const { running, delivery } = start(prompt);
    void running.finally(() => { ended = true; });
    await waitFor(() => ended);
    return { result: await running, delivery };
  };
  const ask = async <T extends OperatorNodeMessage['type']>(type: T, frame: object): Promise<Extract<OperatorNodeMessage, { type: T }>> => {
    const request = randomUUID();
    await host.operatorMessage({ ...frame, request } as Parameters<TerminalHost['operatorMessage']>[0]);
    return frames.find(sent => sent.type === type && 'request' in sent && sent.request === request) as Extract<OperatorNodeMessage, { type: T }>;
  };
  /* What program_screen and program_recovery_release are told of the program, asked at the same moment. */
  const looks = async () => ({
    view: await ask('program.view', { type: 'program.view_get', agentKey: key }),
    recovery: await ask('program.recovery_state', { type: 'program.recovery_state_get', agentKey: key, jobId: null, instance: randomUUID(), case: randomUUID() }),
  });
  const needed = () => frames.filter(frame => frame.type === 'program.operator_needed');
  const opened = () => sent.filter(message => message.type === 'turn.open');
  stops.push(async () => { if (state.working) await end(); await host.stop(); rmSync(home, { recursive: true, force: true }); });
  return { host, key, frames, state, start, turn, looks, needed, opened, notice, tmux, agent };
}

it("takes Hornhoof's words that join a turn Claude Code started by itself for its own task notice, and opens no case", async () => {
  const c = program();
  expect((await c.turn(FIRST)).result).toMatchObject({ ok: true });
  c.state.notice = true;
  const second = c.start(SECOND);
  let ended = false;
  void second.running.finally(() => { ended = true; });
  /* The program took both and finished its turn; two minutes of the node's own ticks follow. */
  await waitFor(() => c.state.prompts.length === 2 && !c.state.working);
  await pass(120_000);
  expect(c.state.prompts).toEqual([FIRST, SECOND]);
  expect(c.frames).toContainEqual(expect.objectContaining({ type: 'program.delivery', deliveryId: second.delivery.id, phase: 'taken' }));
  expect(c.needed()).toEqual([]);
  expect(c.opened()).toEqual([]);
  expect(ended).toBe(true);
  expect(await second.running).toMatchObject({ ok: true });
});

it('still opens a turn of its own for a notice Claude Code takes up while no words of Hornhoof wait to go in', async () => {
  const c = program();
  expect((await c.turn(FIRST)).result).toMatchObject({ ok: true });
  c.notice();
  expect(c.opened()).toEqual([expect.objectContaining({ type: 'turn.open', agentKey: c.key, text: expect.stringContaining('<task-notification>') })]);
});

it('still opens the case of words the program never took', async () => {
  const c = program();
  expect((await c.turn(FIRST)).result).toMatchObject({ ok: true });
  /* Enter goes nowhere now, as on an overloaded machine. */
  vi.spyOn(c.tmux, 'keys').mockResolvedValue();
  const { delivery } = c.start(SECOND);
  await waitFor(() => c.needed().length > 0, 120_000);
  expect(c.needed()).toEqual([expect.objectContaining({ reason: 'assignment_unrecorded', deliveryId: delivery.id })]);
});

it.each([
  ['an empty input', false],
  ['the dim suggestion in its input', true],
])('tells program_screen and the release alike that a program done with its turn, showing %s, is free', async (_name, suggests) => {
  const c = program();
  c.state.suggests = suggests;
  expect((await c.turn(FIRST)).result).toMatchObject({ ok: true });
  const { view, recovery } = await c.looks();
  expect(view).toMatchObject({ result: 'ok', state: 'idle', input: 'empty', question: null, tool: null });
  expect(recovery).toMatchObject({ program: 'here', input: 'empty', wait: null, runningTool: false, retrying: false, busy: false });
});

it('tells program_screen and the release alike that a program at work on a turn is busy', async () => {
  const c = program();
  c.state.hang = true;
  c.start(FIRST);
  await waitFor(() => c.state.prompts.length === 1 && c.agent().busy);
  const { view, recovery } = await c.looks();
  expect(view).toMatchObject({ result: 'ok', state: 'working', input: 'empty' });
  expect(recovery).toMatchObject({ program: 'here', input: 'empty', busy: true });
});
