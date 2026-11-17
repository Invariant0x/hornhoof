import { createHash, randomUUID } from 'node:crypto';
import { OperatorNodeMessage, type OperatorNodeMessage as ProgramFrame } from '@hornhoof/protocol/program-operator';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { kimiProgram } from '../src/terminal/programs.js';
import { completionText } from '../src/terminal/program-state.js';
import { Tmux } from '../src/terminal/tmux.js';
import { untilOnClock } from './terminal-host-helpers.js';

const screen = readFileSync(new URL('./fixtures/kimi-completion/done.ansi', import.meta.url), 'utf8');
const done = '\x1b]7501;state=done:app=kimi-code\x1b\\';
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture(secrets: string[] = []) {
  vi.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), 'hh-completion-'));
  const tmux = new Tmux({ env: { HOME: home } });
  const alive = vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  vi.spyOn(tmux, 'run').mockResolvedValue('120 40');
  const shown = vi.spyOn(tmux, 'screen').mockResolvedValue(screen);
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  const cursor = { file: 'recording-1', offset: 100 };
  const position = vi.spyOn(tmux, 'programCursor').mockResolvedValue(cursor);
  const output = vi.spyOn(tmux, 'programOutput').mockReturnValue(done);
  const sent: ProgramFrame[] = [];
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => secrets, operator: { dir: join(home, 'operator'), send: frame => { sent.push(frame); return true; }, connected: () => true } });
  stops.push(async () => { await host.stop(); rmSync(home, { recursive: true, force: true }); });
  const key = randomUUID();
  const a = host['agent'](key);
  a.program = kimiProgram; a.instance = randomUUID();
  host['beginTurn'](a);
  a.busy = a.took = true;
  return { a, host, shown, output, position, cursor, key, sent, alive, facts: () => host['programFacts'](key) };
}

it('uses the current Kimi turn recording and keeps the completion proof stable while only tips rotate', async () => {
  const c = fixture();
  const first = await c.facts();
  expect(first).toMatchObject({ working: false, input: 'empty', completion: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(c.output).toHaveBeenCalledWith(`a-${c.key}`, c.cursor);
  c.shown.mockResolvedValue(screen.replace('ctrl+t to manage tasks', 'ctrl+l to clear the screen'));
  expect(await c.facts()).toMatchObject({ completion: first!.completion });
  c.shown.mockResolvedValue(screen.replace('The review is complete', 'The next response is complete'));
  expect((await c.facts())!.completion).not.toBe(first!.completion);
});

it('does not let a completion proof verify guesses of a masked secret or correlate another program', async () => {
  const secret = '31415926';
  const c = fixture([secret]);
  const raw = screen.replace('The review is complete', `The secret is ${secret}`);
  c.shown.mockResolvedValue(raw);
  const request = randomUUID();
  await c.host.operatorMessage({ type: 'program.view_get', agentKey: c.key, request });
  const view = c.sent.find((frame): frame is Extract<ProgramFrame, { type: 'program.view' }> => frame.type === 'program.view' && frame.request === request)!;
  expect(view.cells).not.toContain(secret);
  expect(view.completion).toMatch(/^[a-f0-9]{64}$/);
  const guess = ['31415925', secret, '31415927'].find(value =>
    createHash('sha256').update(completionText('kimi', raw.replace(secret, value), done)!).digest('hex') === view.completion);
  expect(guess).toBeUndefined();

  const other = c.host['agent'](randomUUID());
  other.program = kimiProgram; other.instance = randomUUID();
  c.host['beginTurn'](other);
  other.busy = other.took = true;
  expect((await c.host['programFacts'](other.key))!.completion).not.toBe(view.completion);
  c.a.instance = randomUUID();
  expect((await c.facts())!.completion).not.toBe(view.completion);
});

it('does not reuse an older done when another Kimi turn starts', async () => {
  const c = fixture();
  expect(await c.facts()).toMatchObject({ working: false });
  const next = { file: 'recording-1', offset: 200 };
  c.position.mockResolvedValue(next);
  c.output.mockImplementation((_name, after) => after?.offset === 200 ? '' : done);
  c.host['beginTurn'](c.a);
  c.a.took = true;
  expect(await c.facts()).toMatchObject({ working: true });
  expect(c.output).toHaveBeenLastCalledWith(`a-${c.key}`, next);
});

it.each(['tool', 'question', 'retry', 'typing', 'not-taken', 'no-cursor', 'no-output'] as const)('does not finish Kimi with unsafe evidence: %s', async unsafe => {
  const c = fixture();
  if (unsafe === 'tool') c.a.calls.set('call', { name: 'Bash', at: 0 });
  if (unsafe === 'question') c.a.question = { name: 'AskUserQuestion', at: 0 };
  if (unsafe === 'retry') c.a.retry = { attempt: 1, max: null, nextAt: 1000 };
  if (unsafe === 'typing') c.a.typing = 'words';
  if (unsafe === 'not-taken') c.a.took = false;
  if (unsafe === 'no-cursor') { c.position.mockResolvedValue(null); c.host['beginTurn'](c.a); c.a.took = true; }
  if (unsafe === 'no-output') c.output.mockReturnValue(null);
  const facts = await c.facts();
  expect(facts).toMatchObject({ working: true });
  expect(facts?.completion).toBeUndefined();
});

it('keeps work that begins while the recording position is being read', async () => {
  const c = fixture();
  let resume!: (cursor: { file: string; offset: number }) => void;
  c.position.mockReturnValue(new Promise(resolve => { resume = resolve; }));
  c.host['beginTurn'](c.a);
  const complete = vi.spyOn(c.host as unknown as { screenCompleted(a: unknown, screen: string): Promise<string | null> }, 'screenCompleted');
  const looking = c.facts();
  await untilOnClock(() => complete.mock.calls.length > 0);
  c.a.calls.set('new-tool', { name: 'Bash', at: 0 });
  resume(c.cursor);
  expect(await looking).toMatchObject({ working: true, tool: 'Bash' });
});


it('walks program view RPC through completed, working, tool and gone states on the local host', async () => {
  const c = fixture();
  await c.host.start();
  const view = async () => {
    const request = randomUUID();
    await c.host.operatorMessage({ type: 'program.view_get', agentKey: c.key, request });
    const frame = c.sent.find(frame => frame.type === 'program.view' && frame.request === request)!;
    expect(OperatorNodeMessage.safeParse(frame).success).toBe(true);
    return frame;
  };
  expect(await view()).toMatchObject({ result: 'ok', state: 'idle', input: 'empty', completion: expect.stringMatching(/^[a-f0-9]{64}$/), cells: screen });
  c.output.mockReturnValue('\x1b]7501;state=working:app=kimi-code\x1b\\');
  expect(await view()).toMatchObject({ result: 'ok', state: 'working' });
  c.output.mockReturnValue(done);
  c.a.calls.set('tool', { name: 'Bash', at: 0 });
  expect(await view()).toMatchObject({ result: 'ok', state: 'working', tool: 'Bash' });
  c.alive.mockResolvedValue(false);
  expect(await view()).toMatchObject({ result: 'refused', reason: 'no_program', state: 'gone', snapshot: null });
});
