import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SIGNED_OUT } from '../src/providers/antigravity.js';
import { agyProgram } from '../src/terminal/programs.js';
import { hasTmux, home, host, job, setUp, tmux, until } from './terminal-host-helpers.js';

const FAKE = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));
const log = join(home, 'agy-setup.log');
/* agy as on a machine where nobody passed its first-run setup. */
const agyJob = (key: string) => ({
  ...job(key, 'hello', { env: { FAKE_LOG: log, FAKE_AGY_SETUP: '1' } }), program: agyProgram, bin: FAKE, home: join(home, 'agy', key), signedOut: SIGNED_OUT,
});
const keys = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(r => r.setup);

describe.skipIf(!hasTmux)("Antigravity's first-run setup", () => {
  afterEach(async () => { await host?.stop(); });

  it('takes the default colors itself, presses nothing on the terms, and ends the turn naming the setup at once', async () => {
    await setUp({ readyMs: 10_000, cols: 120, rows: 40, lookMs: 100 });
    const first = agyJob('s1');
    const startedAt = Date.now();
    const res = await host.run(first);
    expect(res).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'setup', retryable: false, text: expect.stringContaining('terms of service') } });
    expect(Date.now() - startedAt).toBeLessThan(8000);
    expect(keys()).toEqual([{ setup: 'colors', key: 'enter' }]);
    expect(await host.screen('s1')).toContain('Terms of Service & Data Use');
    // Nothing more reaches the terms while the turn waits for the owner.
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(keys()).toEqual([{ setup: 'colors', key: 'enter' }]);

    // The owner accepts the terms on agy's own screen, and agy keeps that in the home the node gives it.
    const pid = await tmux.programPid('a-s1');
    for (const key of ['Down', 'Down', 'Enter']) await tmux.keys('a-s1', key);
    const settings = join(first.home, '.gemini', 'antigravity-cli', 'settings.json');
    await until(() => existsSync(settings));
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ consumerOnboardingComplete: true });

    // The next turn starts agy anew, which goes straight to its prompt.
    expect(await host.run(agyJob('s1'))).toMatchObject({ ok: true, result: 'FINISHED', error: null });
    expect(await tmux.programPid('a-s1')).not.toBe(pid);
    expect(keys().filter(k => k.setup === 'terms').map(k => k.key)).toEqual(['down', 'down', 'enter']);
  });
});
