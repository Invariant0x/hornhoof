import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { claudeTranscript } from '../src/providers/claude-terminal.js';
import { Tmux } from '../src/terminal/tmux.js';
import { job, listsAtStart, onClock, untilOnClock } from './terminal-host-helpers.js';

/* An assistant's program sends its whole conversation along with its new words. The node types the conversation in their
   place into a session that starts anew: one its turn starts, or one a person's clear began that no turn of Hornhoof typed
   the conversation into yet. A session that goes on gets the new words. */

const WORDS = 'Max: and the second thing?';
const WHOLE = 'Max: hi\n\nMiu: hello\n\nMax: and the second thing?';
const OLD = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a';
const NEW = 'b3b66b04-872b-4fbe-a3a4-058a026ef20a';
const KEY = randomUUID();
const cleanups: (() => Promise<void>)[] = [];

/* A Claude Code that starts in the session its command names, takes each prompt typed with Enter and ends its turn when
   told. The host is on the fake clock. */
function assistant({ operator = false } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hh-fresh-prompt-')));
  const workDir = join(home, 'work');
  const record = (session: string, line: object) => {
    const file = claudeTranscript(home, workDir, session);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(line) + '\n');
  };
  const tmux = new Tmux({ env: { HOME: home } });
  let input = '';
  let up = false;
  const typed: string[] = [];
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  vi.spyOn(tmux, 'livePrograms').mockResolvedValue([]);
  const launch = vi.spyOn(tmux, 'launch').mockImplementation(async (_name, { command }) => {
    const session = command[command.findIndex(word => word === '--resume' || word === '--session-id') + 1]!;
    up = true;
    record(session, { type: 'metadata' });
    await host['hook'](KEY, 'start', { session_id: session, source: 'startup' });
  });
  vi.spyOn(tmux, 'alive').mockImplementation(async () => up);
  vi.spyOn(tmux, 'stop').mockImplementation(async () => { up = false; });
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  vi.spyOn(tmux, 'screen').mockImplementation(async () => `❯ ${input}\n`);
  vi.spyOn(tmux, 'paste').mockImplementation(async (_name, text) => { input += text; });
  vi.spyOn(tmux, 'keys').mockImplementation(async (_name, ...pressed) => {
    if (!pressed.includes('Enter') || !input) return;
    const text = input;
    input = '';
    typed.push(text);
    await host['hook'](KEY, 'prompt', { prompt: text });
  });
  const host = new TerminalHost({
    tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], pollMs: 5, enterWaitMs: 30, openMs: 30,
    ...(operator ? { operator: { dir: join(home, 'operator'), send: () => true, connected: () => true } } : {}),
  });
  listsAtStart(host);
  /* Its owner has its window open, so the program stays up between turns. */
  host['viewSessions']['wanted'].set('watching', { key: KEY, size: { cols: 80, rows: 24 } });
  cleanups.push(async () => {
    clearInterval(host['operatorTimer'] ?? undefined);
    up = false;
    await onClock(host.stop());
    rmSync(home, { recursive: true, force: true });
  });
  /* One turn of Hornhoof, from its prompt typed to the program's end of it: what went in, and how it ended. */
  const turn = async (sessionId: string | null, freshPrompt?: string) => {
    const before = typed.length;
    const running = host.run({ ...job(KEY, WORDS, { agentKey: KEY, jobId: randomUUID(), workDir, sessionId }), home, ...(freshPrompt ? { freshPrompt } : {}) });
    await untilOnClock(() => typed.length > before);
    await onClock(host['hook'](KEY, 'stop', { last_assistant_message: 'Done.' }));
    const result = await onClock(running);
    return { typed: typed.slice(before), sessionId: result.sessionId, ok: result.ok };
  };
  /* A person clears the conversation in the window: Claude Code goes on in a new session. */
  const clear = async (session: string) => {
    await onClock(host['hook'](KEY, 'end', { reason: 'clear' }));
    record(session, { type: 'metadata' });
    await onClock(host['hook'](KEY, 'start', { session_id: session, source: 'clear' }));
  };
  return { host, launch, turn, clear };
}

describe("an assistant's whole conversation for a new session", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('types the whole conversation into a program its turn starts in a new session', async () => {
    const c = assistant();
    const first = await c.turn(null, WHOLE);
    expect(first).toMatchObject({ ok: true, typed: [WHOLE] });
    expect(c.launch.mock.calls[0]![1].command).toContain('--session-id');
  });

  it('types the new words into a session that goes on, running or started again', async () => {
    const c = assistant();
    expect(await c.turn(OLD, WHOLE)).toMatchObject({ ok: true, typed: [WORDS], sessionId: OLD });
    expect(c.launch.mock.calls[0]![1].command).toContain('--resume');
    expect(await c.turn(OLD, WHOLE)).toMatchObject({ ok: true, typed: [WORDS], sessionId: OLD });
    expect(c.launch).toHaveBeenCalledTimes(1);
  });

  it('types the whole conversation once into the session a person cleared to, whatever session the turn asks for', async () => {
    const c = assistant();
    await c.turn(OLD);
    await c.clear(NEW);
    expect(await c.turn(OLD, WHOLE)).toMatchObject({ ok: true, typed: [WHOLE], sessionId: NEW });
    expect(await c.turn(NEW, WHOLE)).toMatchObject({ ok: true, typed: [WORDS], sessionId: NEW });
    expect(c.launch).toHaveBeenCalledTimes(1);
  });

  it('keeps the cleared session waiting for the conversation through a turn that has none', async () => {
    const c = assistant();
    await c.turn(OLD);
    await c.clear(NEW);
    expect(await c.turn(NEW)).toMatchObject({ ok: true, typed: [WORDS], sessionId: NEW });
    expect(await c.turn(NEW, WHOLE)).toMatchObject({ ok: true, typed: [WHOLE], sessionId: NEW });
  });

  it('types the new words with no conversation sent, as a node did before', async () => {
    const c = assistant();
    await c.turn(OLD);
    await c.clear(NEW);
    expect(await c.turn(OLD)).toMatchObject({ ok: true, typed: [WORDS], sessionId: NEW });
  });

  it("keeps Hornhoof's own words as the turn's delivery when it types the conversation", async () => {
    const c = assistant({ operator: true });
    const begin = vi.spyOn(c.host['operator']!, 'begin');
    expect(await c.turn(null, WHOLE)).toMatchObject({ ok: true, typed: [WHOLE] });
    expect(begin).toHaveBeenCalledWith(KEY, expect.any(String), undefined, WORDS, false, undefined);
  });
});
