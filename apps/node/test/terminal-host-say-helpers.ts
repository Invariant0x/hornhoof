import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { Tmux } from '../src/terminal/tmux.js';
import { codexJob, onClock, untilOnClock } from './terminal-host-helpers.js';
import { codexPrompt } from './real-screens.js';

/* What the tests of words typed into a running turn share: a Codex terminal at work, its log and its screen. */

const SESSION = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a';
export const cleanups: (() => Promise<void>)[] = [];

/* The screen and log move independently, as when a program takes Enter before its log is read. The clock moves only as
   the test moves it. */
export async function atWork(takePrompt = true) {
  vi.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), 'hh-say-'));
  const workDir = join(home, 'work');
  const logs = join(home, 'sessions', '2026', '11', '02');
  const log = join(logs, `rollout-${SESSION}.jsonl`);
  const tmux = new Tmux({ env: { HOME: home } });
  const logMessage = vi.fn();
  let input = '';
  let history = '';
  let take = takePrompt;
  let initial = true;
  const record = (payload: object) => appendFileSync(log, JSON.stringify({ type: 'event_msg', payload }) + '\n');
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  vi.spyOn(tmux, 'launch').mockImplementation(async () => {
    mkdirSync(logs, { recursive: true });
    appendFileSync(log, JSON.stringify({ type: 'session_meta', payload: { id: SESSION, cwd: workDir } }) + '\n');
  });
  const alive = vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  const screen = vi.spyOn(tmux, 'screen').mockImplementation(async () => `${history}OpenAI Codex\n${codexPrompt(input)}`);
  const paste = vi.spyOn(tmux, 'paste').mockImplementation(async (_name, text) => { input += text; });
  const keys = vi.spyOn(tmux, 'keys').mockImplementation(async (_name, ...pressed) => {
    for (const key of pressed) {
      if (key === 'C-u') input = input.slice(0, input.lastIndexOf('\n') + 1);
      if (key === 'BSpace') input = input.slice(0, -1);
      if (key !== 'Enter' || !take || !input) continue;
      const text = input;
      input = '';
      if (initial) { record({ type: 'task_started', turn_id: 'turn' }); initial = false; }
      record({ type: 'item_completed', turn_id: 'turn', item: { type: 'UserMessage', content: [{ type: 'text', text }] } });
    }
  });
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], log: logMessage, pollMs: 10, enterWaitMs: 100 });
  const job = { ...codexJob('say', 'HANG', { workDir, sessionId: SESSION }), home };
  const running = host.run(job);
  const turns = [running];
  const finish = () => record({ type: 'task_complete', last_agent_message: 'Done.' });
  cleanups.push(async () => {
    alive.mockResolvedValue(false);
    finish();
    await onClock(Promise.all(turns));
    await onClock(host.stop());
    rmSync(home, { recursive: true, force: true });
  });
  await untilOnClock(() => keys.mock.calls.some(([, key]) => key === 'Enter'));
  paste.mockClear();
  keys.mockClear();
  screen.mockClear();
  const next = () => {
    initial = true;
    const turn = host.run(job);
    turns.push(turn);
    return turn;
  };
  return { host, tmux, running, finish, next, paste, keys, alive, screen, logMessage, take: (value: boolean) => { take = value; }, history: (value: string) => { history = value; } };
}
