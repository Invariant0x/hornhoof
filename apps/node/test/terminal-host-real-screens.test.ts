import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { codexProgram, kimiProgram, type TermProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';
import { until } from './terminal-host-helpers.js';

const real = (name: string) => readFileSync(new URL(`./fixtures/real-screens/${name}.ansi`, import.meta.url), 'utf8');
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.restoreAllMocks(); });

/* A node with an assignment for a program that waits at its empty prompt, on the screen that program really shows. The
   paste is what 0.7.0 never got to: its check took the footer for a person's words. */
function assignment(program: TermProgram, ready: string, draft?: string) {
  const home = mkdtempSync(join(tmpdir(), 'hh-real-screen-'));
  const agentKey = randomUUID(), jobId = randomUUID(), deliveryId = randomUUID();
  const workDir = join(home, 'work');
  mkdirSync(workDir, { recursive: true });
  const tmux = new Tmux({ env: { HOME: home } });
  const sent: OperatorNodeMessage[] = [];
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  vi.spyOn(tmux, 'launch').mockResolvedValue();
  vi.spyOn(tmux, 'run').mockResolvedValue('120 40');
  vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  vi.spyOn(tmux, 'keys').mockResolvedValue();
  vi.spyOn(tmux, 'screen').mockResolvedValue(real(draft ?? ready));
  const paste = vi.spyOn(tmux, 'paste').mockResolvedValue();
  const abort = new AbortController();
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], plugins: [], readyMs: 20, pollMs: 5, lookMs: 10, enterWaitMs: 10,
    operator: { dir: join(home, 'operator'), send: frame => { sent.push(frame); return true; }, connected: () => true },
  });
  const running = host.run({ key: agentKey, program, bin: program.kind, home, signedOut: /signed out/i, operatorDelivery: { id: deliveryId, ordinal: 1 }, input: { agentKey, jobId, prompt: 'Check the checkout.', sessionId: null, model: null, workDir, secret: null, timeoutMs: 20000, instructions: null, tools: null, signal: abort.signal } });
  stops.push(async () => { abort.abort(); await host.stop(); await running; rmSync(home, { recursive: true, force: true }); });
  return { paste, sent, deliveryId };
}

it.each([
  ['codex', codexProgram, 'codex-0.166.0-first'],
  ['codex', codexProgram, 'codex-0.166.0-idle'],
  ['kimi', kimiProgram, 'kimi-2.5.1-first'],
  ['kimi', kimiProgram, 'kimi-2.2.0-first'],
] as const)('types the assignment into a ready %s at its empty prompt, on the real screen %s', async (_kind, program, name) => {
  const { paste, sent, deliveryId } = assignment(program, name);
  await until(() => sent.some(frame => frame.type === 'program.delivery' && frame.phase === 'attempt'));
  expect(sent).toContainEqual(expect.objectContaining({ type: 'program.delivery', deliveryId, phase: 'attempt' }));
  await until(() => paste.mock.calls.length > 0);
  expect(paste.mock.calls.map(([, text]) => text)).toEqual(['Check the checkout.']);
});

it.each([
  ['codex', codexProgram, 'codex-0.166.0-first', 'codex-0.166.0-draft'],
  ['kimi', kimiProgram, 'kimi-2.5.1-first', 'kimi-2.5.1-draft'],
] as const)('keeps the assignment out of the words a person left in real %s', async (_kind, program, ready, draft) => {
  const { paste, sent } = assignment(program, ready, draft);
  await until(() => sent.some(frame => frame.type === 'program.delivery' && frame.phase === 'attempt'));
  await new Promise(done => setTimeout(done, 200));
  expect(paste).not.toHaveBeenCalled();
});
