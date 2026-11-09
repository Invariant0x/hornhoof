import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { Tmux } from '../src/terminal/tmux.js';
import { codexJob, onClock, untilOnClock } from './terminal-host-helpers.js';
import { codexPrompt } from './real-screens.js';

const SESSION = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a';
const cleanups: (() => Promise<void>)[] = [];

/* The screen and log move independently, as when a program takes Enter before its log is read. The clock moves only as
   the test moves it. */
async function atWork(takePrompt = true) {
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
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], log: logMessage, pollMs: 10, enterWaitMs: 100, plugins: [] });
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

describe('words typed into a running turn', () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not press Enter if the turn ends after the paste, and clears the words', async () => {
    const c = await atWork();
    c.paste.mockImplementationOnce(async (_name, text) => {
      await c.tmux.paste(_name, text);
      c.finish();
      await c.running;
    });
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(false);
    expect(c.keys.mock.calls.flat()).not.toContain('Enter');
    expect(await c.host.screen('say')).not.toContain('Use the new schema.');
  });

  it('checks the same turn again after waiting for the program to be alive', async () => {
    const c = await atWork();
    c.alive.mockImplementationOnce(async () => {
      c.finish();
      await c.running;
      return true;
    });
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('keeps Codex words held if the turn ends while Enter is sent', async () => {
    const c = await atWork();
    c.keys.mockImplementationOnce(async () => { c.finish(); await c.running; });
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(true);
  });

  it.each(['Use the new schema.', '\nUse the new schema.', 'First line.\nSecond line.'])('keeps silent Codex input held after two keys: %s', async text => {
    const c = await atWork();
    c.take(false);
    expect(await onClock(c.host.say('say', text))).toBe(true);
    expect(c.keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(2);
    expect(await c.host.screen('say')).toContain(text);
  });

  it('refuses each delivery on an unknown screen without typing', async () => {
    const c = await atWork();
    c.screen.mockResolvedValue('Program is loading.');
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(false);
    expect(await onClock(c.host.say('say', 'Then check the result.'))).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
    expect(c.keys).not.toHaveBeenCalled();
    expect(c.logMessage.mock.calls).toEqual(Array(2).fill(['Agent say (codex): live words were not delivered: the input could not be read.']));
  });

  it("leaves a person's unfinished input alone", async () => {
    const c = await atWork();
    await c.tmux.paste('a-say', 'An unfinished draft.');
    c.paste.mockClear();
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
    expect(await c.host.screen('say')).toContain('An unfinished draft.');
    expect(c.logMessage.mock.calls).toEqual([['Agent say (codex): live words were not delivered: the input contains unsent words.']]);
  });

  it.each([
    ['no turn is running', async (c: Awaited<ReturnType<typeof atWork>>) => { c.finish(); await c.running; }, Infinity],
    ['the delivery deadline passed', async () => {}, 0],
    ['there is not enough time to paste the words', async () => {}, 100],
    ['the program is no longer running', async (c: Awaited<ReturnType<typeof atWork>>) => { c.alive.mockResolvedValue(false); }, Infinity],
    ['could not read the input', async (c: Awaited<ReturnType<typeof atWork>>) => { c.screen.mockRejectedValueOnce(new Error('Private words.')); }, Infinity],
    ['could not paste the words', async (c: Awaited<ReturnType<typeof atWork>>) => { c.paste.mockRejectedValueOnce(new Error('Private words.')); }, Infinity],
    ['could not send the submit key', async (c: Awaited<ReturnType<typeof atWork>>) => { c.keys.mockRejectedValueOnce(new Error('Private words.')); }, Infinity],
  ] as const)('logs one refusal without message text when %s', async (reason, prepare, within) => {
    const c = await atWork();
    await onClock(prepare(c));
    expect(await onClock(c.host.say('say', 'Private words.', within))).toBe(false);
    expect(c.logMessage.mock.calls).toEqual([[`Agent say (codex): live words were not delivered: ${reason}.`]]);
  });

  it('refuses hidden input without reading an old empty prompt from history', async () => {
    const c = await atWork();
    c.screen.mockImplementation(async (_name, history = 200) => history === 0 ? 'Input is hidden.' : codexPrompt(''));
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(false);
    expect(c.screen.mock.calls.every(([, history]) => history === 0)).toBe(true);
  });

  it('reads a styled capture so a busy Codex placeholder counts as empty', async () => {
    const c = await atWork();
    const screen = readFileSync(new URL('./fixtures/codex-busy-screen.txt', import.meta.url), 'utf8');
    c.screen.mockImplementation(async (_name, _history, styled) => styled ? screen : screen.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(true);
    expect(c.paste).toHaveBeenCalledWith('a-say', 'Use the new schema.');
  });

  it('leaves typed placeholder words alone', async () => {
    const c = await atWork();
    c.screen.mockResolvedValue(readFileSync(new URL('./fixtures/codex-typed-screen.txt', import.meta.url), 'utf8'));
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('uses the receipt if the input disappears after Enter', async () => {
    const c = await atWork();
    c.screen.mockResolvedValueOnce(`OpenAI Codex\n${codexPrompt('')}`).mockResolvedValue('Input is hidden.');
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(true);
    expect(c.logMessage).not.toHaveBeenCalled();
  });

  it('does not send Enter into input that cannot be read', async () => {
    const c = await atWork();
    c.screen.mockResolvedValue('Input is hidden.');
    c.keys.mockImplementationOnce(async () => {
      c.finish();
      await c.running;
    });
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(false);
    expect(c.keys).not.toHaveBeenCalled();
  });

  it('checks the turn after reading the input before typing', async () => {
    const c = await atWork();
    c.screen.mockImplementationOnce(async () => {
      c.finish();
      await c.running;
      return `OpenAI Codex\n${codexPrompt('')}`;
    });
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('leaves unconfirmed input untouched when a paste fails', async () => {
    const c = await atWork();
    c.paste.mockImplementationOnce(async (name, text) => {
      await c.tmux.paste(name, text);
      throw new Error('Paste failed.');
    });
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(false);
    expect(c.keys.mock.calls.flat()).not.toContain('Enter');
    expect(c.keys.mock.calls.flat()).not.toContain('C-u');
    expect(await c.host.screen('say')).toContain('Use the new schema.');
  });

  it('says yes when the input clears and the same turn still runs, even with the words in its history', async () => {
    const c = await atWork();
    c.history('› Use the new schema.\nAcknowledged.\n');
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(true);
  });

  it('uses the program receipt even if the screen still shows the words', async () => {
    const c = await atWork();
    c.screen.mockResolvedValueOnce(`OpenAI Codex\n${codexPrompt('')}`).mockResolvedValueOnce('OpenAI Codex\n› Use the new schema.\n');
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(true);
    expect(c.keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(1);
  });

  it('keeps a transcript receipt when the last liveness check fails', async () => {
    const c = await atWork();
    const keys = c.keys.getMockImplementation()!;
    c.keys.mockImplementationOnce(async (name, ...pressed) => {
      await keys(name, ...pressed);
      c.alive.mockRejectedValueOnce(new Error('Connection lost.'));
    });
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(true);
    expect(c.logMessage).not.toHaveBeenCalled();
  });

  it('keeps a transcript receipt when sending Enter reports an error after it went in', async () => {
    const c = await atWork();
    const keys = c.keys.getMockImplementation()!;
    c.keys.mockImplementationOnce(async (name, ...pressed) => {
      await keys(name, ...pressed);
      throw new Error('Connection lost.');
    });
    expect(await onClock(c.host.say('say', 'Use the new schema.'))).toBe(true);
    expect(c.logMessage).not.toHaveBeenCalled();
  });

  it.each([-15_000, 15_000])('starts its budget on a node whose clock differs by %i ms', async offset => {
    const c = await atWork();
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + offset);
    expect(await onClock(c.host.say('say', 'Use the new schema.', 1000))).toBe(true);
  });

  it('does not paste words with no time left', async () => {
    const c = await atWork();
    expect(await onClock(c.host.say('say', 'Use the new schema.', 0))).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('checks the deadline again after waiting for the program to be alive', async () => {
    const c = await atWork();
    c.alive.mockImplementationOnce(async () => {
      await new Promise(done => setTimeout(done, 100));
      return true;
    });
    expect(await onClock(c.host.say('say', 'Use the new schema.', 30))).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it("stops waiting for Hornhoof's prompt when the deadline passes", async () => {
    const c = await atWork(false);
    const saying = c.host.say('say', 'Use the new schema.', 30);
    await vi.advanceTimersByTimeAsync(60);
    c.take(true);
    await c.tmux.keys('a-say', 'Enter');
    expect(await onClock(saying)).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('does not press Enter if the deadline passes during the paste delay', async () => {
    const c = await atWork();
    const afterBudget = Date.now() + 2000;
    c.paste.mockImplementationOnce(async (name, text) => {
      await c.tmux.paste(name, text);
      vi.spyOn(Date, 'now').mockReturnValue(afterBudget);
    });
    expect(await onClock(c.host.say('say', 'Use the new schema.', 1000))).toBe(false);
    expect(c.keys.mock.calls.flat()).not.toContain('Enter');
    expect(await c.host.screen('say')).not.toContain('Use the new schema.');
  });

  it('does not begin a paste that cannot finish before its deadline', async () => {
    const c = await atWork();
    expect(await onClock(c.host.say('say', 'Use the new schema.', 100))).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('drops words whose deadline passes behind another delivery', async () => {
    const c = await atWork();
    const first = c.host.say('say', 'First words.');
    const second = c.host.say('say', 'Expired words.', 30);
    expect(await onClock(first)).toBe(true);
    expect(await onClock(second)).toBe(false);
    expect(c.paste.mock.calls.map(([, text]) => text)).toEqual(['First words.']);
  });

  it('does not carry queued words into a later turn', async () => {
    const c = await atWork();
    let release!: () => void;
    const gate = new Promise<void>(done => (release = done));
    c.alive.mockClear();
    c.alive.mockImplementationOnce(async () => { await gate; return true; });
    const first = c.host.say('say', 'First words.');
    const second = c.host.say('say', 'Words for the first turn.');
    await untilOnClock(() => c.alive.mock.calls.length > 0);
    c.finish();
    await onClock(c.running);
    c.paste.mockClear();
    const next = c.next();
    release();
    expect(await onClock(first)).toBe(false);
    expect(await onClock(second)).toBe(false);
    await untilOnClock(() => c.keys.mock.calls.some(([, key]) => key === 'Enter'));
    expect(c.paste.mock.calls.map(([, text]) => text)).toEqual(['HANG']);
    c.finish();
    await onClock(next);
  });

  it('clears a failed delivery before the next turn pastes its prompt', async () => {
    const c = await atWork();
    let release!: () => void;
    const gate = new Promise<void>(done => (release = done));
    c.paste.mockImplementationOnce(async (name, text) => {
      await c.tmux.paste(name, text);
      await gate;
    });
    const saying = c.host.say('say', 'Words for the old turn.');
    await untilOnClock(() => c.paste.mock.calls.length > 1);
    c.finish();
    await onClock(c.running);
    let clean = false;
    const next = c.next();
    c.paste.mockImplementationOnce(async (name, text) => {
      clean = !(await c.host.screen('say')).includes('Words for the old turn.');
      await c.tmux.paste(name, text);
    });
    release();
    expect(await onClock(saying)).toBe(false);
    await untilOnClock(() => c.keys.mock.calls.some(([, key]) => key === 'Enter'));
    expect(clean).toBe(true);
    c.finish();
    await onClock(next);
  });
});
