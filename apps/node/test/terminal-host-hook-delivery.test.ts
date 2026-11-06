import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agyProgram } from '../src/terminal/programs.js';
import { hasTmux, host, tmux, home, setUp, job, pastLostEndWindows, until } from './terminal-host-helpers.js';
import { procFixture } from './terminal-proc-fixture.js';
const HOOK_TERM = fileURLToPath(new URL('./fakes/fake-hook-term.mjs', import.meta.url));
const AGY = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));

describe.skipIf(!hasTmux)('turns ended by a delayed hook', () => {
  afterEach(async () => { vi.restoreAllMocks();await host?.stop(); });
  for (const kind of ['claude', 'antigravity'] as const) it(`closes ${kind}'s turn by its hook after a slow owner check, with the program alive`, async () => {
    const key = `slow-hook-${kind}`;
    const fixture = procFixture(key);
    /* agy lists its tools through the same slow check before it gets the prompt. */
    await setUp({ proc: fixture.proc, toolsMs: 10_000 });
    fixture.listen(host['bridge'], tmux);
    let release!: () => void;
    const busy = new Promise<void>(resolve => release = resolve);
    let stopReceived = false;
    let checking = false;
    host['bridge']['server']!.prependListener('request', req => {
      if (req.url?.endsWith('/stop')) stopReceived = true;
    });
    const run = tmux.run.bind(tmux);
    vi.spyOn(tmux, 'run').mockImplementation(async (args, input) => {
      const out = await run(args, input);
      if (stopReceived && args[0] === 'list-panes') { checking = true; await busy; }
      return out;
    });
    const task = job(key, 'Deliver the answer', { timeoutMs: 25000 });
    task.bin = kind === 'claude' ? HOOK_TERM : AGY;
    if (kind === 'antigravity') { task.program = agyProgram;task.home = join(home, key); }
    let finished = false;
    const turn = host.run(task).then(result => { finished = true; return result; });
    let clock: ReturnType<typeof pastLostEndWindows> | undefined;
    try {
      await until(() => checking);
      clock = pastLostEndWindows();
      expect(finished).toBe(false);
    } finally {
      release();
    }
    const result = await turn.finally(() => clock?.mockRestore());
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.result).toMatch(kind === 'claude' ? /^Delivered by hh-hook\.$/ : /^FINISHED$/);
    expect(await tmux.alive(`a-${key}`)).toBe(true);
  }, 35000);
});
