import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@hornhoof/protocol';
import { vi } from 'vitest';
import { SCREEN_SIGNED_OUT } from '../src/providers/kimi.js';
import type { TerminalHost, TermJob } from '../src/terminal/host.js';
import { claudeProgram } from '../src/providers/claude-terminal.js';
import { codexProgram } from '../src/providers/codex-terminal.js';
import { kimiProgram } from '../src/providers/kimi-terminal.js';
import { eventually } from '../../../test-support/eventually.mjs';

/* What the tests of agents in terminals share. tmux is never started: each test stands in for it with what the program would
   show, recorded from the real programs (fixtures/real-screens), and checks only our side of it. */

export const SECRET = 'sk-fake-0123456789abcdef';

/* Kimi Code's input box and footer as it draws them (fixtures/real-screens). */
export const kimiScreen = (input: string) => {
  const rows = input.split('\n').map((row, i) => `│ ${i ? ' ' : '>'} ${row}`.padEnd(70) + ' │');
  return `Welcome to Kimi Code!\n╭${'─'.repeat(70)}╮\n${rows.join('\n')}\n╰${'─'.repeat(70)}╯\ncontext: 0% (0/256k)\n`;
};

export const until = (check: () => boolean | Promise<boolean>) => eventually(check);

/* A host on the fake clock (vi.useFakeTimers()) runs only as far as the test moves the clock. These move it on a few
   milliseconds at a time until a state holds, a promise settles or a time has passed: the program's time is virtual, and a
   state that never comes ends at the runner's limit for the test. While held() says real sockets still carry something
   for the host, the clock stands still and they wait for that, with no timer. */
type Clocked = { stepMs?: number; held?: () => boolean };
async function step({ stepMs = 5, held }: Clocked, ms = stepMs): Promise<number> {
  if (held?.()) {
    await eventually(() => !held());
    return 0;
  }
  await vi.advanceTimersByTimeAsync(ms);
  return ms;
}
export async function untilOnClock(check: () => boolean | Promise<boolean>, clocked: Clocked = {}): Promise<void> {
  while (!(await check())) await step(clocked);
}
export async function onClock<T>(promise: Promise<T>, clocked: Clocked = {}): Promise<T> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await untilOnClock(() => done, clocked);
  return promise;
}
export async function passOnClock(ms: number, clocked: Clocked = {}): Promise<void> {
  const stepMs = clocked.stepMs ?? 5;
  for (let left = ms; left > 0;) left -= await step(clocked, Math.min(stepMs, left));
}

/* The stand-in programs list their tools as they start, as each real one does with a session. The node counts what a
   program does from the end of its launch, when it starts to watch it, so their listing comes then. */
export function listsAtStart(host: TerminalHost): void {
  const watch = host['watch'].bind(host);
  vi.spyOn(host as unknown as { watch(a: { key: string; startedAt: number }): void }, 'watch').mockImplementation(a => {
    host['bridge']['heardList'](a.key, a.startedAt);
    watch(a as Parameters<typeof watch>[0]);
  });
}

export const home = mkdtempSync(join(tmpdir(), 'hh-home-'));

export const job = (key: string, prompt: string, more: Partial<TermJob['input']> = {}): TermJob & { events: AgentEvent[] } => {
  const events: AgentEvent[] = [];
  return {
    key,
    program: claudeProgram,
    bin: 'claude',
    home,
    signedOut: /not logged in/i,
    events,
    input: { prompt, sessionId: null, model: null, workDir: join(home, 'work', key), secret: null, timeoutMs: 20_000, instructions: 'Be brief.', tools: { url: 'http://x/mcp', token: 'tok-turn' }, onEvent: e => events.push(e), env: { FAKE_SECRET: SECRET }, ...more },
  };
};
export const codexJob = (key: string, prompt: string, more: Partial<TermJob['input']> = {}) => ({ ...job(key, prompt, more), program: codexProgram, bin: 'codex' });
/* Kimi keeps its settings in its home, which these tests give each agent of their own. */
export const kimiJob = (key: string, prompt: string, more: Partial<TermJob['input']> = {}) => ({
  ...job(key, prompt, more),
  program: { ...kimiProgram, limits: async () => ({ status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.3, resetsAt: null }] }) },
  bin: 'kimi',
  home: join(home, 'kimi', key),
  signedOut: SCREEN_SIGNED_OUT,
});
