import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agyProgram } from '../src/terminal/programs.js';
import { hasTmux, host, tmux, home, setUp, job } from './terminal-host-helpers.js';
const HOOK_TERM = fileURLToPath(new URL('./fakes/fake-hook-term.mjs', import.meta.url));
const AGY = fileURLToPath(new URL('./fakes/agy', import.meta.url));

describe.skipIf(!hasTmux)('turns ended by a delayed hook', () => {
  afterEach(async () => { vi.restoreAllMocks();await host?.stop(); });
  for (const kind of ['claude', 'antigravity'] as const) it(`closes ${kind}'s turn by its hook after a slow owner check, with the program alive`, async () => {
    await setUp({ proc: '/proc' });
    const run = tmux.run.bind(tmux);
    vi.spyOn(tmux, 'run').mockImplementation(async (args, input) => {
      const out = await run(args, input);
      if (args[0] === 'list-panes') await new Promise(resolve => setTimeout(resolve, 3500));
      return out;
    });
    const key = `slow-hook-${kind}`;
    const task = job(key, 'Deliver the answer', { timeoutMs: 25000 });
    task.bin = kind === 'claude' ? HOOK_TERM : AGY;
    if (kind === 'antigravity') { task.program = agyProgram;task.home = join(home, key); }
    const result = await host.run(task);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.result).toMatch(kind === 'claude' ? /^Delivered by hh-hook\.$/ : /^Git rebase/);
    expect(await tmux.alive(`a-${key}`)).toBe(true);
  }, 35000);
});
