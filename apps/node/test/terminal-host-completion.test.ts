import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { kimiProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';

const screen = readFileSync(new URL('./fixtures/kimi-completion/done.ansi', import.meta.url), 'utf8');
const done = '\x1b]7501;state=done:app=kimi-code\x1b\\';
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  vi.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), 'hh-completion-'));
  const tmux = new Tmux({ env: { HOME: home } });
  vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  const shown = vi.spyOn(tmux, 'screen').mockResolvedValue(screen);
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  const cursor = { file: 'recording-1', offset: 100 };
  const position = vi.spyOn(tmux, 'programCursor').mockResolvedValue(cursor);
  const output = vi.spyOn(tmux, 'programOutput').mockReturnValue(done);
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], operator: { dir: join(home, 'operator'), send: () => true, connected: () => true } });
  stops.push(async () => { await host.stop(); rmSync(home, { recursive: true, force: true }); });
  const a = host['agent']('own');
  a.program = kimiProgram; a.instance = 'instance-1';
  host['beginTurn'](a);
  a.busy = a.took = true;
  return { a, host, shown, output, position, cursor, facts: () => host['programFacts']('own') };
}

it('uses the current Kimi turn recording and keeps the completion proof stable while only tips rotate', async () => {
  const c = fixture();
  const first = await c.facts();
  expect(first).toMatchObject({ working: false, input: 'empty', completion: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(c.output).toHaveBeenCalledWith('a-own', c.cursor);
  c.shown.mockResolvedValue(screen.replace('ctrl+t to manage tasks', 'ctrl+l to clear the screen'));
  expect(await c.facts()).toMatchObject({ completion: first!.completion });
  c.shown.mockResolvedValue(screen.replace('The review is complete', 'The next response is complete'));
  expect((await c.facts())!.completion).not.toBe(first!.completion);
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
  expect(c.output).toHaveBeenLastCalledWith('a-own', next);
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
  while (!complete.mock.calls.length) await Promise.resolve();
  c.a.calls.set('new-tool', { name: 'Bash', at: 0 });
  resume(c.cursor);
  expect(await looking).toMatchObject({ working: true, tool: 'Bash' });
});
