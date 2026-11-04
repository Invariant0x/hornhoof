import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { COLORS_NOT_TAKEN, COLORS_WAIT_MS, colorsNotTaken, pastColors, SIGNED_OUT } from '../src/providers/antigravity.js';
import { agyProgram } from '../src/terminal/programs.js';
import { hasTmux, home, host, job, setUp, tmux, until } from './terminal-host-helpers.js';

const FAKE = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));
const logOf = (key: string) => join(home, `agy-setup-${key}.log`);
const passedOf = (key: string) => join(home, `agy-setup-${key}.passed`);
/* agy as on a machine where nobody passed its first-run setup, which it shows until a person passed it. */
const agyJob = (key: string, env: Record<string, string> = {}) => ({
  ...job(key, 'hello', { env: { FAKE_LOG: logOf(key), FAKE_AGY_SETUP: passedOf(key), ...env } }), program: agyProgram, bin: FAKE, home: join(home, 'agy', key), signedOut: SIGNED_OUT,
});
const keys = (key: string) => readFileSync(logOf(key), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(r => r.setup);

/* An Enter that reached agy's terms would tick or untick the box there, so the node presses on the colors once per agy. */
it('presses Enter on the colors once per agy, however long agy then takes to show its terms', async () => {
  const colors = 'Welcome to Antigravity CLI!\n Choose your color scheme:\n > terminal\n   light\n   dark\n [Next]';
  const terms = 'Terms of Service & Data Use\n > [x] Yes, I agree\n [Previous]      [Done]';
  let enters = 0;
  const enter = async () => { enters += 1; };
  const pressed = { at: -Infinity };
  expect(await pastColors(colors, enter, pressed, 1000)).toBe('colors');
  expect(colorsNotTaken('colors', pressed, 1000 + COLORS_WAIT_MS - 1)).toBe(false);
  expect(await pastColors(colors, enter, pressed, 1000 + 10 * COLORS_WAIT_MS)).toBe('colors');
  expect(enters).toBe(1);
  /* An agy that still shows the colors then did not take the Enter. */
  expect(colorsNotTaken('colors', pressed, 1000 + COLORS_WAIT_MS)).toBe(true);
  expect(await pastColors(terms, enter, pressed, 1000 + 11 * COLORS_WAIT_MS)).toBe('terms');
  expect(colorsNotTaken('terms', pressed, 1000 + 11 * COLORS_WAIT_MS)).toBe(false);
  expect(enters).toBe(1);
});

describe.skipIf(!hasTmux)("Antigravity's first-run setup", () => {
  afterEach(async () => { await host?.stop(); });

  it('takes the default colors itself, presses nothing on the terms, and ends the turn naming the setup at once', async () => {
    await setUp({ readyMs: 10_000, cols: 120, rows: 40, lookMs: 100 });
    const first = agyJob('s1');
    const startedAt = Date.now();
    const res = await host.run(first);
    expect(res).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'setup', retryable: false, text: expect.stringContaining('terms of service') } });
    expect(Date.now() - startedAt).toBeLessThan(8000);
    expect(keys('s1')).toEqual([{ setup: 'colors', key: 'enter' }]);
    expect(await host.screen('s1')).toContain('Terms of Service & Data Use');
    // Nothing more reaches the terms while the turn waits for the owner.
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(keys('s1')).toEqual([{ setup: 'colors', key: 'enter' }]);

    // The owner accepts the terms on agy's own screen. As agy 1.4.12 did, its settings then hold {} and say nothing of it.
    const pid = await tmux.programPid('a-s1');
    for (const key of ['Down', 'Down', 'Enter']) await tmux.keys('a-s1', key);
    await until(() => existsSync(passedOf('s1')));
    expect(readFileSync(join(first.home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')).toBe('{}\n');

    // The next turn starts agy anew, which goes straight to its prompt.
    expect(await host.run(agyJob('s1'))).toMatchObject({ ok: true, result: 'FINISHED', error: null });
    expect(await tmux.programPid('a-s1')).not.toBe(pid);
    expect(keys('s1').filter(k => k.setup === 'terms').map(k => k.key)).toEqual(['down', 'down', 'enter']);
  });

  it('starts agy anew for the next turn when it did not take the colors, pressing on each agy once', async () => {
    await setUp({ readyMs: 30_000, cols: 120, rows: 40, lookMs: 100 });
    /* The first agy is not listening yet when the node presses. */
    const deaf = { FAKE_AGY_DEAF_ONCE: join(home, 'agy-deaf-once') };
    const startedAt = Date.now();
    expect(await host.run(agyJob('s2', deaf))).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'unknown', retryable: true, text: COLORS_NOT_TAKEN } });
    expect(Date.now() - startedAt).toBeLessThan(COLORS_WAIT_MS + 5000);
    expect(keys('s2')).toEqual([{ setup: 'colors', key: 'enter' }]);
    const pid = await tmux.programPid('a-s2');

    expect(await host.run(agyJob('s2', deaf))).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'setup', retryable: false } });
    expect(await tmux.programPid('a-s2')).not.toBe(pid);
    expect(keys('s2')).toEqual([{ setup: 'colors', key: 'enter' }, { setup: 'colors', key: 'enter' }]);
  });
});
