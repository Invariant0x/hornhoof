import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexPrompt } from './real-screens.js';
import { atWork, cleanups } from './terminal-host-say-helpers.js';

describe('words typed into a running turn', () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
  });

  it('does not press Enter if the turn ends after the paste, and clears the words', async () => {
    const c = await atWork();
    c.paste.mockImplementationOnce(async (_name, text) => {
      await c.tmux.paste(_name, text);
      c.finish();
      await c.running;
    });
    expect(await c.host.say('say', 'Use the new schema.')).toBe(false);
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
    expect(await c.host.say('say', 'Use the new schema.')).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('keeps Codex words held if the turn ends while Enter is sent', async () => {
    const c = await atWork();
    c.keys.mockImplementationOnce(async () => { c.finish(); await c.running; });
    expect(await c.host.say('say', 'Use the new schema.')).toBe(true);
  });

  it.each(['Use the new schema.', '\nUse the new schema.', 'First line.\nSecond line.'])('keeps silent Codex input held after two keys: %s', async text => {
    const c = await atWork();
    c.take(false);
    expect(await c.host.say('say', text)).toBe(true);
    expect(c.keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(2);
    expect(await c.host.screen('say')).toContain(text);
  });

  it('refuses each delivery on an unknown screen without typing', async () => {
    const c = await atWork();
    c.screen.mockResolvedValue('Program is loading.');
    expect(await c.host.say('say', 'Use the new schema.')).toBe(false);
    expect(await c.host.say('say', 'Then check the result.')).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
    expect(c.keys).not.toHaveBeenCalled();
    expect(c.logMessage.mock.calls).toEqual(Array(2).fill(['Agent say (codex): live words were not delivered: the input could not be read.']));
  });

  it("leaves a person's unfinished input alone", async () => {
    const c = await atWork();
    await c.tmux.paste('a-say', 'An unfinished draft.');
    c.paste.mockClear();
    expect(await c.host.say('say', 'Use the new schema.')).toBe(false);
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
    await prepare(c);
    expect(await c.host.say('say', 'Private words.', within)).toBe(false);
    expect(c.logMessage.mock.calls).toEqual([[`Agent say (codex): live words were not delivered: ${reason}.`]]);
  });

  it('refuses hidden input without reading an old empty prompt from history', async () => {
    const c = await atWork();
    c.screen.mockImplementation(async (_name, history = 200) => history === 0 ? 'Input is hidden.' : codexPrompt(''));
    expect(await c.host.say('say', 'Use the new schema.')).toBe(false);
    expect(c.screen.mock.calls.every(([, history]) => history === 0)).toBe(true);
  });

  it('reads a styled capture so a busy Codex placeholder counts as empty', async () => {
    const c = await atWork();
    const screen = readFileSync(new URL('./fixtures/codex-busy-screen.txt', import.meta.url), 'utf8');
    c.screen.mockImplementation(async (_name, _history, styled) => styled ? screen : screen.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(await c.host.say('say', 'Use the new schema.')).toBe(true);
    expect(c.paste).toHaveBeenCalledWith('a-say', 'Use the new schema.');
  });

  it('leaves typed placeholder words alone', async () => {
    const c = await atWork();
    c.screen.mockResolvedValue(readFileSync(new URL('./fixtures/codex-typed-screen.txt', import.meta.url), 'utf8'));
    expect(await c.host.say('say', 'Use the new schema.')).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });
});
