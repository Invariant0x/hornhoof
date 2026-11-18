import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { NodeMessage } from '@hornhoof/protocol';
import { vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { jobDone } from '../src/runner.js';
import { claudeTranscript } from '../src/providers/claude-terminal.js';
import { Tmux } from '../src/terminal/tmux.js';
import { claudePasted, claudeQueue, kimiSteer, userMessage } from './fakes/word-receipts.mjs';
import { codexJob, job, kimiJob, kimiScreen, listsAtStart, onClock, passOnClock, untilOnClock } from './terminal-host-helpers.js';
import { codexPrompt } from './real-screens.js';

/* What the tests of program receipts for live words share: an agent at work whose program, Claude, Codex or Kimi, records
   in its own log the words it takes. The test plays tmux: what it shows and what the keys do. */

export const SESSION = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a';
const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));
/* hh-hook's own deadline on a clock of its process that never moves: it runs only to the bridge and back. */
const CLOCK = fileURLToPath(new URL('./fakes/hook-clock.cjs', import.meta.url));
const runHook = promisify(execFile);
export const TEXT = 'From Hornhoof:\n\nKeep these exact words.';
export const cleanups: (() => Promise<void>)[] = [];
type Kind = 'claude' | 'codex' | 'kimi';
type Mode = 'taken' | 'queued' | 'pasted' | 'silent' | 'lost' | 'hook' | 'bridge';

export async function atWork(kind: Kind, mode: Mode, { watched = true }: { watched?: boolean } = {}) {
  /* The host runs on the fake clock, which moves only as the test moves it: c.until, c.on and c.pass. Turns of the event
     loop stay real, for the hook a real hh-hook sends through the bridge. */
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  /* While hh-hook runs and its hook travels on real sockets, the clock stands still. */
  let transit = 0;
  const clocked = { held: () => transit > 0 };
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hh-receipts-')));
  const workDir = join(home, 'work');
  const file = kind === 'claude' ? claudeTranscript(home, workDir, SESSION)
    : kind === 'codex' ? join(home, 'sessions/2026/11/03', `rollout-${SESSION}.jsonl`)
    : join(home, 'sessions/work', SESSION, 'agents/main/wire.jsonl');
  const record = (line: object) => appendFileSync(file, JSON.stringify(line) + '\n');
  const sent: NodeMessage[] = [];
  const tmux = new Tmux({ env: { HOME: home } });
  let input = '';
  let initial = true;
  /* Codex gives each turn an id of its own; the first is 'turn'. */
  let turns = 0;
  const turnId = () => (turns > 1 ? `turn-${turns}` : 'turn');
  const screen = () => kind === 'claude' ? `❯ ${input}\n` : kind === 'codex' ? `OpenAI Codex\n${codexPrompt(input)}`
    : kimiScreen(input);
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  /* No other agent's program runs on the node: tmux is not asked, so no real process runs while the clock moves. */
  vi.spyOn(tmux, 'livePrograms').mockResolvedValue([]);
  /* A program that sleeps ends; the next launch starts it again. */
  let asleep = false;
  vi.spyOn(tmux, 'launch').mockImplementation(async () => {
    if (asleep) alive.mockResolvedValue(true);
    asleep = false;
    mkdirSync(dirname(file), { recursive: true });
    if (kind === 'codex') record({ type: 'session_meta', payload: { id: SESSION, cwd: workDir } });
    else record({ type: 'metadata' });
    if (kind !== 'codex') await host['hook']('receipt', 'start', { session_id: SESSION });
  });
  const alive = vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  vi.spyOn(tmux, 'stop').mockImplementation(async () => {
    asleep = true;
    alive.mockResolvedValue(false);
  });
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  vi.spyOn(tmux, 'screen').mockImplementation(async () => screen());
  vi.spyOn(tmux, 'paste').mockImplementation(async (_name, text) => { input += text; });
  const keys = vi.spyOn(tmux, 'keys').mockImplementation(async (_name, ...pressed) => {
    for (const key of pressed) {
      if (key === 'C-u') input = input.slice(0, input.lastIndexOf('\n') + 1);
      if (key === 'BSpace') input = input.slice(0, -1);
      if (key !== 'Enter' && key !== 'C-s') continue;
      if (!input || (!initial && mode === 'lost')) continue;
      const text = input;
      input = '';
      if (initial) {
        initial = false;
        if (kind === 'codex') record({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId() } });
        else await host['hook']('receipt', 'prompt', { prompt: text });
      } else if (kind === 'claude' && mode !== 'silent') {
        if (mode === 'hook') await host['hook']('receipt', 'prompt', { prompt: text });
        else record(claudeQueue('enqueue', mode === 'pasted' ? claudePasted(text) : text));
      } else if (kind === 'codex' && mode === 'taken') record(userMessage(text));
      else if (kind === 'kimi' && key === 'C-s' && mode !== 'silent') {
        if (mode === 'bridge') {
          transit++;
          try { await runHook(process.execPath, ['-r', CLOCK, HOOK, 'queued', JSON.stringify({ prompt: [{ type: 'text', text }] })], { env: { PATH: process.env.PATH, HH_BRIDGE: host['bridge'].agent('receipt').hookUrl } }); }
          finally { transit--; }
          continue;
        }
        await host['hook']('receipt', 'queued', { prompt: [{ type: 'text', text }] });
        record(kimiSteer('prompt.steered', text));
        if (mode === 'taken') record(kimiSteer('turn.steer', text));
      }
    }
  });
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: m => sent.push(m), secrets: () => [], pollMs: 5, enterWaitMs: 30, openMs: 30 });
  listsAtStart(host);
  /* Someone has the agent's terminal open, as one who types there does, so its program stays up between turns. */
  if (watched) host['wanted'].set('watching', { key: 'receipt', size: { cols: 80, rows: 24 } });
  const makeJob = kind === 'codex' ? codexJob : kind === 'kimi' ? kimiJob : job;
  if (mode === 'bridge') await host.start();
  const run = () => {
    initial = true;
    turns++;
    return host.run({ ...makeJob('receipt', 'HANG', { jobId: 'job-receipt', workDir, sessionId: SESSION }), home }).then(result => {
      sent.push(jobDone('job-receipt', result, []));
      return result;
    });
  };
  const running = run();
  const drain = () => host['drain'](host['agents'].get('receipt')!);
  const finish = () => {
    if (kind === 'codex') record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId(), last_agent_message: 'Done.' } });
    else if (kind === 'claude') record({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
    else record({ type: 'turn.ended', reason: 'completed' });
    drain();
  };
  cleanups.push(async () => { alive.mockResolvedValue(false); finish(); await onClock(running, clocked); await onClock(host.stop(), clocked); rmSync(home, { recursive: true, force: true }); });
  await untilOnClock(() => host['agents'].get('receipt')?.took === true, clocked);
  keys.mockClear();
  const expire = () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 15_001);
    drain(); drain();
  };
  const unheard = () => sent.filter(m => m.type === 'agent.unheard');
  return { host, tmux, running, run, sent, keys, alive, home, workDir, record, drain, finish, expire, unheard, turnId, input: () => input,
    until: (check: () => boolean | Promise<boolean>) => untilOnClock(check, clocked),
    on: <T>(promise: Promise<T>) => onClock(promise, clocked),
    pass: (ms: number) => passOnClock(ms, clocked) };
}

export async function atTypedWork(kind: 'claude' | 'codex', mode: Mode) {
  const c = await atWork(kind, mode);
  c.finish(); await c.on(c.running);
  const prompt = kind === 'claude' ? c.host['hook']('receipt', 'prompt', { prompt: 'A typed question.' }) : Promise.resolve();
  if (kind === 'codex') {
    c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'typed' } });
    c.record(userMessage('A typed question.', 'typed'));
    c.drain();
  }
  await c.until(() => c.sent.some(m => m.type === 'turn.open'));
  c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'typed', toolToken: 'token' });
  await c.on(prompt);
  const end = async () => {
    if (kind === 'claude') await c.host['hook']('receipt', 'stop', { last_assistant_message: 'Typed answer.' });
    else {
      c.record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'typed', last_agent_message: 'Typed answer.' } });
      c.drain();
    }
  };
  return { ...c, end };
}
