import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import type { Limits, NodeMessage } from '@hornhoof/protocol';
import type { OperatorDelivery } from '@hornhoof/protocol/program-operator';
import { TerminalHost, type TermJob } from '../src/terminal/host.js';
import type { OperatorOptions } from '../src/terminal/operator-runtime.js';
import { withProgramExit } from '../src/program-exit.js';
import { jobDone } from '../src/runner.js';
import { claudeTranscript } from '../src/providers/claude-terminal.js';
import { Tmux } from '../src/terminal/tmux.js';
import { claudePasted, claudeQueue, userMessage } from './fakes/word-receipts.mjs';
import { codexJob, job, kimiJob, kimiScreen, listsAtStart, onClock, passOnClock, untilOnClock } from './terminal-host-helpers.js';
import { codexPrompt } from './real-screens.js';

export const SESSION = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a';
export const TEXT = 'From Hornhoof:\n\nKeep these exact words.';
export const cleanups: (() => Promise<void>)[] = [];
type Kind = 'claude' | 'codex' | 'kimi';
type Mode = 'queued' | 'silent' | 'lost' | 'hook' | 'taken';
/* A person's view of the session: what tmux's client would print, written by the test, and what the person types. */
export type FakeView = ChildProcessWithoutNullStreams & { stdout: PassThrough; stdin: PassThrough; typed: () => string };
function fakeView(): FakeView {
  const view = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(), killed: false, pid: 0 });
  const typed: Buffer[] = [];
  view.stdin.on('data', (chunk: Buffer) => typed.push(chunk));
  return Object.assign(view, {
    kill() { if (!view.killed) { view.killed = true; view.emit('exit', 0, null); } return true; },
    typed: () => Buffer.concat(typed).toString(),
  }) as unknown as FakeView;
}

export async function liveTerminal(kind: Kind = 'claude', mode: Mode = 'queued', options: { key?: string; jobId?: string; operatorDelivery?: OperatorDelivery; prompt?: string; openMs?: number; connects?: boolean; sessionId?: string | null; limits?: () => Promise<Limits | null>; operator?: OperatorOptions; secrets?: string[]; host?: Partial<ConstructorParameters<typeof TerminalHost>[0]>; live?: string[]; watched?: boolean; timeoutMs?: number } = {}) {
  /* The host runs on the fake clock, which moves only as the test moves it: c.until, c.on and c.pass. Turns of the event
     loop stay real, for the sockets of the bridge. */
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hh-public-words-')));
  const workDir = join(home, 'work');
  const file = kind === 'claude' ? claudeTranscript(home, workDir, SESSION)
    : kind === 'codex' ? join(home, 'sessions/2026/11/03', `rollout-${SESSION}.jsonl`)
    : join(home, 'sessions/work', SESSION, 'agents/main/wire.jsonl');
  const record = (line: object) => appendFileSync(file, JSON.stringify(line) + '\n');
  const sent: NodeMessage[] = [];
  const log = vi.fn();
  const tmux = new Tmux({ env: { HOME: home } });
  let input = '';
  let initial = true;
  let turn = 0;
  let hookUrl = '';
  /* Hooks and the program's calls to its tools reach the bridge on real sockets: while one is on its way there or back, the
     clock stands still. A call the bridge holds for a turn to open waits on the clock instead. */
  let transit = 0;
  let calls = 0;
  const holding = () => [...host['bridge']['waiting'].values()].reduce((n, waiters) => n + waiters.size, 0);
  const clocked = { held: () => transit > 0 || calls > holding() };
  const hook = async (event: string, body: object = {}) => {
    if (event === 'prompt') initial = false;
    transit++;
    try {
      /* A fresh connection each call: a kept-alive one reaches the bridge only once the server drops it, about 6 s on macOS, while the clock stands still. */
      const res = await fetch(`${hookUrl}/${event}`, { method: 'POST', body: JSON.stringify(body), headers: { connection: 'close' } });
      if (!res.ok) throw new Error(`Hook ${event}: ${res.status}`);
      return await res.text();
    } finally { transit--; }
  };
  const display = () => kind === 'kimi' ? kimiScreen(input)
    : kind === 'claude' ? `────────────\n❯ ${input}\n────────────\n  ? for shortcuts\n` : `OpenAI Codex\n${codexPrompt(input)}`;
  /* tmux itself never runs: a command no stand-in below answers gets an empty answer. */
  vi.spyOn(tmux, 'run').mockImplementation(async args => (args.includes('#{pane_width} #{pane_height}') ? '100 30' : ''));
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  vi.spyOn(tmux, 'has').mockResolvedValue(true);
  vi.spyOn(tmux, 'clients').mockResolvedValue([]);
  /* The agents whose programs run in the node's tmux before this one starts. */
  if (options.live) vi.spyOn(tmux, 'livePrograms').mockResolvedValue(options.live);
  const views: { view: FakeView; name: string; cols: number; rows: number; write: boolean }[] = [];
  const attach = vi.spyOn(tmux, 'attach').mockImplementation((name, cols, rows, write) => {
    const view = fakeView();
    views.push({ view, name, cols, rows, write });
    return view;
  });
  /* A program that sleeps ends, and the next launch starts it again. */
  let asleep = false;
  const launch = vi.spyOn(tmux, 'launch').mockImplementation(async (_name, spec) => {
    if (asleep) alive.mockResolvedValue(true);
    asleep = false;
    hookUrl = /^HH_BRIDGE='([^']+)'$/m.exec(readFileSync(spec.envFile!, 'utf8'))![1]!;
    mkdirSync(dirname(file), { recursive: true });
    record(kind === 'codex' ? { type: 'session_meta', payload: { id: SESSION, cwd: workDir } } : { type: 'metadata' });
    if (kind !== 'codex') await hook('start', { session_id: SESSION });
  });
  const alive = vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  const stop = vi.spyOn(tmux, 'stop').mockImplementation(async () => {
    asleep = true;
    alive.mockResolvedValue(false);
  });
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  const exitSnapshot = vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  const screen = vi.spyOn(tmux, 'screen').mockImplementation(async () => display());
  const paste = vi.spyOn(tmux, 'paste').mockImplementation(async (_name, text) => { input += text; });
  const submitted: string[] = [];
  const keys = vi.spyOn(tmux, 'keys').mockImplementation(async (_name, ...pressed) => {
    for (const key of pressed) {
      if (key === 'C-u') input = input.slice(0, input.lastIndexOf('\n') + 1);
      if (key === 'BSpace') input = input.slice(0, -1);
      if (!['Enter', 'C-s'].includes(key) || !input || (!initial && mode === 'lost')) continue;
      const text = input;
      input = '';
      submitted.push(text);
      if (initial) {
        initial = false;
        if (kind === 'codex') record({ type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${turn}` } });
        else await hook('prompt', { prompt: text });
      } else if (kind === 'claude' && mode === 'queued') record(claudeQueue('enqueue', claudePasted(text)));
      else if (mode === 'hook') await hook('prompt', { prompt: text });
      else if (kind === 'codex' && mode === 'taken') record(userMessage(text, `turn-${turn}`));
      else if (kind === 'kimi' && mode === 'queued') await hook('queued', { prompt: text });
    }
  });
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: m => sent.push(m), secrets: () => options.secrets ?? [], log, pollMs: 10, enterWaitMs: 50, openMs: options.openMs ?? 50, ...(options.operator ? { operator: options.operator } : {}), ...options.host });
  /* From the bridge handing a hook to the host to the host's answer, the clock runs. */
  const handle = host['hook'].bind(host);
  vi.spyOn(host as unknown as { hook: typeof handle }, 'hook').mockImplementation(async (...args) => {
    transit--;
    try { return await handle(...args); } finally { transit++; }
  });
  /* The program lists its tools as it starts, unless the test makes its calls to them. */
  if (!options.connects) listsAtStart(host);
  await host.start();
  const results: Promise<unknown>[] = [];
  /* more: what else this turn's input differs in, like the environment of the repository it works in. */
  const run = (prompt = 'HANG', jobId = options.jobId ?? 'job-receipt', more: Partial<TermJob['input']> = {}) => {
    initial = true;
    turn++;
    const makeJob = kind === 'codex' ? codexJob : kind === 'kimi' ? kimiJob : job;
    const base = makeJob(options.key ?? 'receipt', prompt, { jobId, workDir, sessionId: options.sessionId === undefined ? SESSION : options.sessionId, ...(prompt ? {} : { tools: undefined }), ...more });
    const program = options.limits ? { ...base.program, limits: options.limits } : base.program;
    const running = host.run({ ...base, program, home, operatorDelivery: options.operatorDelivery }).then(result => {
      sent.push(jobDone(jobId, result, []));
      return result;
    });
    results.push(running);
    return running;
  };
  const finish = (answer = 'Done.') => {
    if (kind === 'codex') record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn-${turn}`, last_agent_message: answer } });
    else if (kind === 'kimi') record({ type: 'turn.ended', reason: 'completed' });
    else { record({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }); record({ type: 'system', subtype: 'turn_duration', durationMs: 1 }); }
  };
  cleanups.push(async () => {
    alive.mockResolvedValue(false); finish();
    await onClock(Promise.all(results), clocked); await onClock(host.stop(), clocked);
    vi.useRealTimers(); rmSync(home, { recursive: true, force: true });
  });
  /* Someone has the agent's terminal open before its first turn, and keeps it open: its program stays up between turns. */
  if (options.watched) await onClock(host.open({ type: 'term.open', termId: 'watching', agentKey: options.key ?? 'receipt', cols: 100, rows: 30, write: false }), clocked);
  /* timeoutMs: how long Hornhoof gives the first turn, which the test's 20 seconds would cut short. */
  const running = run(options.prompt ?? 'HANG', undefined, options.timeoutMs ? { timeoutMs: options.timeoutMs } : {});
  if (options.prompt === '') await onClock(running, clocked);
  else await untilOnClock(() => sent.some(m => m.type === 'job.program' && m.state === 'thinking'), clocked);
  paste.mockClear(); keys.mockClear();
  return { host, tmux, running, run, sent, log, hook, record, finish, screen, paste, keys, alive, launch, stop, submitted, attach, views,
    until: (check: () => boolean | Promise<boolean>) => untilOnClock(check, clocked),
    on: <T>(promise: Promise<T>) => onClock(promise, clocked),
    pass: (ms: number) => passOnClock(ms, clocked),
    /* A call the program makes to its tools through the bridge, which the test makes for it. */
    carry: async <T>(go: () => Promise<T>): Promise<T> => {
      calls++;
      try { return await go(); } finally { calls--; }
    },
    input: () => input, draft: (text: string) => { input = text; },
    /* The program ends with what it printed last, as tmux's recording of it would say. */
    ends: (output: string, code: number) => {
      alive.mockResolvedValue(false);
      exitSnapshot.mockResolvedValue({ ...withProgramExit(output, { code, signal: null, at: new Date().toISOString() }), complete: true });
    }, unheard: () => sent.filter(m => m.type === 'agent.unheard') };
}
