import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@hornhoof/protocol';
import { SCREEN_SIGNED_OUT } from '../src/providers/kimi.js';
import type { TermJob } from '../src/terminal/host.js';
import { claudeProgram, codexProgram, kimiProgram } from '../src/terminal/programs.js';
import { eventually } from '../../../test-support/eventually.mjs';

/* What the tests of agents in terminals share. tmux is never started: each test stands in for it with what the program would
   show, recorded from the real programs (fixtures/real-screens), and checks only our side of it. */

export const SECRET = 'sk-fake-0123456789abcdef';

/* Kimi Code's input box and footer as it draws them (fixtures/real-screens). */
export const kimiScreen = (input: string) => {
  const rows = input.split('\n').map((row, i) => `│ ${i ? ' ' : '>'} ${row}`.padEnd(70) + ' │');
  return `Welcome to Kimi Code!\n╭${'─'.repeat(70)}╮\n${rows.join('\n')}\n╰${'─'.repeat(70)}╯\ncontext: 0% (0/256k)\n`;
};

export const until = (check: () => boolean | Promise<boolean>, ms = 15_000) => eventually(check, { ms, every: 50, message: 'timed out' });

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
