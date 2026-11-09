import { afterEach, describe, expect, it, vi } from 'vitest';
import { until } from './terminal-host-helpers.js';
import { codexPrompt } from './real-screens.js';
import { atWork, cleanups } from './terminal-host-say-helpers.js';

describe('words typed into a running turn', () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
  });

  it('uses the receipt if the input disappears after Enter', async () => {
    const c = await atWork();
    c.screen.mockResolvedValueOnce(`OpenAI Codex\n${codexPrompt('')}`).mockResolvedValue('Input is hidden.');
    expect(await c.host.say('say', 'Use the new schema.')).toBe(true);
    expect(c.logMessage).not.toHaveBeenCalled();
  });

  it('does not send Enter into input that cannot be read', async () => {
    const c = await atWork();
    c.screen.mockResolvedValue('Input is hidden.');
    c.keys.mockImplementationOnce(async () => {
      c.finish();
      await c.running;
    });
    expect(await c.host.say('say', 'Use the new schema.')).toBe(false);
    expect(c.keys).not.toHaveBeenCalled();
  });

  it('checks the turn after reading the input before typing', async () => {
    const c = await atWork();
    c.screen.mockImplementationOnce(async () => {
      c.finish();
      await c.running;
      return `OpenAI Codex\n${codexPrompt('')}`;
    });
    expect(await c.host.say('say', 'Use the new schema.')).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('leaves unconfirmed input untouched when a paste fails', async () => {
    const c = await atWork();
    c.paste.mockImplementationOnce(async (name, text) => {
      await c.tmux.paste(name, text);
      throw new Error('Paste failed.');
    });
    expect(await c.host.say('say', 'Use the new schema.')).toBe(false);
    expect(c.keys.mock.calls.flat()).not.toContain('Enter');
    expect(c.keys.mock.calls.flat()).not.toContain('C-u');
    expect(await c.host.screen('say')).toContain('Use the new schema.');
  });

  it('says yes when the input clears and the same turn still runs, even with the words in its history', async () => {
    const c = await atWork();
    c.history('› Use the new schema.\nAcknowledged.\n');
    expect(await c.host.say('say', 'Use the new schema.')).toBe(true);
  });

  it('uses the program receipt even if the screen still shows the words', async () => {
    const c = await atWork();
    c.screen.mockResolvedValueOnce(`OpenAI Codex\n${codexPrompt('')}`).mockResolvedValueOnce('OpenAI Codex\n› Use the new schema.\n');
    expect(await c.host.say('say', 'Use the new schema.')).toBe(true);
    expect(c.keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(1);
  });

  it('keeps a transcript receipt when the last liveness check fails', async () => {
    const c = await atWork();
    const keys = c.keys.getMockImplementation()!;
    c.keys.mockImplementationOnce(async (name, ...pressed) => {
      await keys(name, ...pressed);
      c.alive.mockRejectedValueOnce(new Error('Connection lost.'));
    });
    expect(await c.host.say('say', 'Use the new schema.')).toBe(true);
    expect(c.logMessage).not.toHaveBeenCalled();
  });

  it('keeps a transcript receipt when sending Enter reports an error after it went in', async () => {
    const c = await atWork();
    const keys = c.keys.getMockImplementation()!;
    c.keys.mockImplementationOnce(async (name, ...pressed) => {
      await keys(name, ...pressed);
      throw new Error('Connection lost.');
    });
    expect(await c.host.say('say', 'Use the new schema.')).toBe(true);
    expect(c.logMessage).not.toHaveBeenCalled();
  });

  it.each([-15_000, 15_000])('starts its budget on a node whose clock differs by %i ms', async offset => {
    const c = await atWork();
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + offset);
    expect(await c.host.say('say', 'Use the new schema.', 1000)).toBe(true);
  });

  it('does not paste words with no time left', async () => {
    const c = await atWork();
    expect(await c.host.say('say', 'Use the new schema.', 0)).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('checks the deadline again after waiting for the program to be alive', async () => {
    const c = await atWork();
    c.alive.mockImplementationOnce(async () => {
      await new Promise(done => setTimeout(done, 100));
      return true;
    });
    expect(await c.host.say('say', 'Use the new schema.', 30)).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it("stops waiting for Hornhoof's prompt when the deadline passes", async () => {
    const c = await atWork(false);
    const saying = c.host.say('say', 'Use the new schema.', 30);
    await new Promise(done => setTimeout(done, 60));
    c.take(true);
    await c.tmux.keys('a-say', 'Enter');
    expect(await saying).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('does not press Enter if the deadline passes during the paste delay', async () => {
    const c = await atWork();
    const afterBudget = Date.now() + 2000;
    c.paste.mockImplementationOnce(async (name, text) => {
      await c.tmux.paste(name, text);
      vi.spyOn(Date, 'now').mockReturnValue(afterBudget);
    });
    expect(await c.host.say('say', 'Use the new schema.', 1000)).toBe(false);
    expect(c.keys.mock.calls.flat()).not.toContain('Enter');
    expect(await c.host.screen('say')).not.toContain('Use the new schema.');
  });

  it('does not begin a paste that cannot finish before its deadline', async () => {
    const c = await atWork();
    expect(await c.host.say('say', 'Use the new schema.', 100)).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('drops words whose deadline passes behind another delivery', async () => {
    const c = await atWork();
    const first = c.host.say('say', 'First words.');
    const second = c.host.say('say', 'Expired words.', 30);
    expect(await first).toBe(true);
    expect(await second).toBe(false);
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
    await until(() => c.alive.mock.calls.length > 0);
    c.finish();
    await c.running;
    c.paste.mockClear();
    const next = c.next();
    release();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    await until(() => c.keys.mock.calls.some(([, key]) => key === 'Enter'));
    expect(c.paste.mock.calls.map(([, text]) => text)).toEqual(['HANG']);
    c.finish();
    await next;
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
    await until(() => c.paste.mock.calls.length > 1);
    c.finish();
    await c.running;
    let clean = false;
    const next = c.next();
    c.paste.mockImplementationOnce(async (name, text) => {
      clean = !(await c.host.screen('say')).includes('Words for the old turn.');
      await c.tmux.paste(name, text);
    });
    release();
    expect(await saying).toBe(false);
    await until(() => c.keys.mock.calls.some(([, key]) => key === 'Enter'));
    expect(clean).toBe(true);
    c.finish();
    await next;
  });
});
