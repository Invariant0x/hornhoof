import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agyProgram } from '../src/terminal/programs.js';
import { codexJob, hasTmux, home, host, job, kimiJob, setUp, tmux } from './terminal-host-helpers.js';

/* The level goes with the start of a turn: the new one comes with the next wake, which starts the program again in the same
   session, and nothing else starts it. */
const FAKE_AGY = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));
const agyJob = (key: string, prompt: string, more: Parameters<typeof job>[2] = {}) => ({ ...job(key, prompt, more), program: agyProgram, bin: FAKE_AGY, home: join(home, '.agy') });
const PROGRAMS = { claude: job, codex: codexJob, kimi: kimiJob, antigravity: agyJob };
const KINDS = Object.keys(PROGRAMS) as (keyof typeof PROGRAMS)[];
type Kind = (typeof KINDS)[number];

async function atWork(kind: Kind) {
  await setUp({ cols: 120, rows: 40, readyMs: 5000, lookMs: 100, toolsMs: 5000, enterWaitMs: 300, typingQuietMs: 50, keptWaitMs: 1000 });
  const key = randomUUID();
  const run = (prompt: string, effort: string, sessionId: string | null = null) => {
    const jobId = randomUUID();
    return { jobId, running: host.run(PROGRAMS[kind](key, prompt, { jobId, sessionId, effort, timeoutMs: 20_000 })) };
  };
  return { run };
}

describe.skipIf(!hasTmux)('a new level between turns', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  it.each(KINDS)('%s: starts the program again only for the next wake, in the same session', async kind => {
    const c = await atWork(kind);
    const first = await c.run('First assignment.', 'high').running;
    expect(first).toMatchObject({ ok: true });
    const launch = vi.spyOn(tmux, 'launch');
    expect(await c.run('Same level.', 'high', first.sessionId ?? null).running).toMatchObject({ ok: true, sessionId: first.sessionId });
    expect(launch).not.toHaveBeenCalled();
    expect(await c.run('New level.', 'medium', first.sessionId ?? null).running).toMatchObject({ ok: true, sessionId: first.sessionId });
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
