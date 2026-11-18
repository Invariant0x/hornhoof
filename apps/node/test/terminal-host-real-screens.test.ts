import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { atEmptyPrompt, inputOf } from '../src/terminal/input.js';
import type { TermProgram } from '../src/terminal/programs.js';
import { codexProgram } from '../src/providers/codex-terminal.js';
import { kimiProgram } from '../src/providers/kimi-terminal.js';
import { Tmux } from '../src/terminal/tmux.js';
import { real, withoutFooter } from './real-screens.js';
import { onClock, untilOnClock } from './terminal-host-helpers.js';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

/* A node with an assignment for a program that waits at its empty prompt, on the screen that program really shows. The
   paste is what 0.7.0 never got to: its check took the footer for a person's words. The clock moves only as the test moves it.
   An assignment that came without the program operator waits for the program a short time of its own. */
function assignment(program: TermProgram, ready: string, draft?: string, shown = real(draft ?? ready), operated = true) {
  vi.useFakeTimers();
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
  const keys = vi.spyOn(tmux, 'keys').mockResolvedValue();
  const screen = vi.spyOn(tmux, 'screen').mockResolvedValue(shown);
  const paste = vi.spyOn(tmux, 'paste').mockResolvedValue();
  const abort = new AbortController();
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], readyMs: 20, pollMs: 5, lookMs: 10, enterWaitMs: 10, keptWaitMs: 20,
    operator: { dir: join(home, 'operator'), send: frame => { sent.push(frame); return true; }, connected: () => true },
  });
  const running = host.run({ key: agentKey, program, bin: program.kind, home, signedOut: /signed out/i, ...(operated ? { operatorDelivery: { id: deliveryId, ordinal: 1 } } : {}), input: { agentKey, jobId, prompt: 'Check the checkout.', sessionId: null, model: null, workDir, secret: null, timeoutMs: 20000, instructions: null, tools: null, signal: abort.signal } });
  stops.push(async () => { abort.abort(); await onClock(host.stop()); await onClock(running); rmSync(home, { recursive: true, force: true }); });
  let ended = false;
  void running.then(() => { ended = true; });
  return { host, tmux, agentKey, jobId, screen, paste, keys, sent, deliveryId, running, ended: () => ended, styledLooks: () => screen.mock.calls.filter(([, , styled]) => styled).length };
}

it.each([
  ['codex', codexProgram, 'codex-0.166.0-first'],
  ['codex', codexProgram, 'codex-0.166.0-idle'],
  ['codex', codexProgram, 'codex-0.166.0-long-session'],
  ['kimi', kimiProgram, 'kimi-2.5.1-first'],
  ['kimi', kimiProgram, 'kimi-2.2.0-first'],
] as const)('types the assignment into a ready %s at its empty prompt, on the real screen %s', async (_kind, program, name) => {
  const { paste, sent, deliveryId } = assignment(program, name);
  await untilOnClock(() => sent.some(frame => frame.type === 'program.delivery' && frame.phase === 'attempt'));
  expect(sent).toContainEqual(expect.objectContaining({ type: 'program.delivery', deliveryId, phase: 'attempt' }));
  await untilOnClock(() => paste.mock.calls.length > 0);
  expect(paste.mock.calls.map(([, text]) => text)).toEqual(['Check the checkout.']);
});

/* A program the node starts again in its pane has what its last run printed above its screen, in the pane's history: Claude
   Code and Codex stay on the main screen, for a person to scroll back through. Only what it shows now tells whether it is
   signed out. */
const LAST_RUN = '• Ran the check of the plan\n  └ The plan was signed out yesterday.\n';

it.each([
  ['codex', codexProgram, 'codex-0.166.0-first'],
  ['kimi', kimiProgram, 'kimi-2.5.1-first'],
] as const)('does not take %s for signed out by what its last run said above its screen', async (_kind, program, ready) => {
  const c = assignment(program, ready, undefined, undefined, false);
  let drawn = false;
  c.screen.mockImplementation(async (_name, history = 200) => (drawn ? real(ready) : history ? LAST_RUN : ''));
  await untilOnClock(() => c.screen.mock.calls.length > 1);
  drawn = true;
  await untilOnClock(() => c.paste.mock.calls.length > 0 || c.ended());
  expect(c.paste.mock.calls.map(([, text]) => text)).toEqual(['Check the checkout.']);
});

it.each([
  ['codex', codexProgram, 'codex-0.166.0-first'],
  ['kimi', kimiProgram, 'kimi-2.5.1-first'],
] as const)('says %s never showed its prompt, not that it is signed out, when only its last run said so above its screen', async (_kind, program, ready) => {
  const c = assignment(program, ready, undefined, undefined, false);
  c.screen.mockImplementation(async (_name, history = 200) => (history ? LAST_RUN : ''));
  expect(await onClock(c.running)).toMatchObject({ ok: false, error: 'agent_failed', failure: { text: expect.stringContaining('did not show its prompt') } });
});

it.each([
  ['codex', codexProgram, 'codex-0.166.0-first', 'codex-0.166.0-draft'],
  ['codex', codexProgram, 'codex-0.166.0-first', 'codex-0.166.0-empty-rows-draft'],
  ['kimi', kimiProgram, 'kimi-2.5.1-first', 'kimi-2.5.1-draft'],
] as const)('keeps the assignment out of the words a person left in real %s', async (_kind, program, ready, draft) => {
  const { paste, styledLooks } = assignment(program, ready, draft);
  /* The node looked at its input and still did not type: looks at the screen before it does say nothing. */
  await untilOnClock(() => styledLooks() > 2);
  expect(paste).not.toHaveBeenCalled();
});

/* What a release of a hold rests on, from the real screen through the node to the frame the server reads. */
const recoveryState = async (c: ReturnType<typeof assignment>, agentKey = c.agentKey) => {
  const request = randomUUID();
  await c.host.operatorMessage({ type: 'program.recovery_state_get', agentKey, jobId: c.jobId, instance: randomUUID(), request, case: randomUUID() });
  return c.sent.find(frame => frame.type === 'program.recovery_state' && frame.request === request);
};

it.each([
  ['codex-0.166.0-long-session', codexProgram, 'empty'],
  ['codex-0.166.0-draft', codexProgram, 'words'],
  ['kimi-2.5.1-first', kimiProgram, 'empty'],
  ['kimi-2.5.1-draft', kimiProgram, 'words'],
] as const)('tells whoever releases a hold what the real screen %s shows', async (name, program, input) => {
  const c = assignment(program, name, name);
  await untilOnClock(() => c.styledLooks() > 0);
  expect(await recoveryState(c)).toMatchObject({ program: 'here', input });
});

it('types nothing, presses nothing and clears nothing while nothing proves real Codex has an empty input', async () => {
  /* What a real Codex draft under empty rows would show without a footer: its words are the only thing that may be one. */
  const c = assignment(codexProgram, 'codex-0.166.0-first', undefined, withoutFooter(real('codex-0.166.0-empty-rows-draft')));
  await untilOnClock(() => c.styledLooks() > 2);
  expect(c.paste).not.toHaveBeenCalled();
  expect(c.keys).not.toHaveBeenCalled();
  expect(await recoveryState(c)).toMatchObject({ program: 'here', input: 'unknown' });
});

it('says a program is gone once its terminal is, whatever its screen last showed', async () => {
  const c = assignment(codexProgram, 'codex-0.166.0-idle');
  await untilOnClock(() => c.styledLooks() > 0);
  vi.spyOn(c.tmux, 'alive').mockResolvedValue(false);
  expect(await recoveryState(c)).toMatchObject({ program: 'gone', input: 'unknown' });
});

it('says a program is gone for an agent it does not run', async () => {
  const c = assignment(codexProgram, 'codex-0.166.0-idle');
  expect(await recoveryState(c, randomUUID())).toMatchObject({ program: 'gone', current: null });
});

it.each([
  ['codex-0.166.0-empty-rows-draft', 'Words under two empty rows'],
  ['codex-0.166.0-paragraphs-draft', 'Words under a blank first row\n\n  A second paragraph'],
])('reads the whole of a draft with empty rows on the real screen %s', (name, draft) => {
  expect(inputOf('codex', real(name))).toBe(draft);
});

it.each(['first', 'idle', 'busy', 'retrying', 'long-session'])('reads no words on the real empty screen %s of Codex', name => {
  expect(atEmptyPrompt('codex', real(`codex-0.166.0-${name}`))).toBe(true);
});

it('does not take the question Codex asks near its limits for an empty prompt: words go nowhere there, and Enter answers it', () => {
  expect(atEmptyPrompt('codex', real('codex-0.167.0-rate-limits-question'))).toBe(false);
});
