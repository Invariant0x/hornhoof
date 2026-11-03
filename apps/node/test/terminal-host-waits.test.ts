import { afterEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../src/runner.js';
import { hasTmux, host, setUp, job, codexJob, kimiJob } from './terminal-host-helpers.js';

/* A program that took Hornhoof's prompt and then waits at its own prompt for what to do, without saying its turn ended,
   would hold the turn and its session for good: the host ends it once its screen has stood still that long. */
const IDLE_MS = 1500;
const STILL_WAITING = 'still waiting';

const within = (run: Promise<RunResult>, ms: number) => Promise.race([run, new Promise<typeof STILL_WAITING>(r => setTimeout(() => r(STILL_WAITING), ms))]);

describe.skipIf(!hasTmux)('a program that waits at its prompt in a turn of Hornhoof', () => {
  afterEach(async () => host?.stop());
  const jobs = { claude: job, codex: codexJob, kimi: kimiJob };

  it.each(['claude', 'codex', 'kimi'] as const)('%s is ended, and its turn fails with how it ended and why', async kind => {
    await setUp({ idleMs: IDLE_MS });
    const res = await within(host.run(jobs[kind](`wait-${kind}`, 'HANG here')), 15_000);
    expect(res).not.toBe(STILL_WAITING);
    const ended = res as RunResult;
    expect(ended).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(ended.programOutput).toBeDefined();
    expect(ended.programOutput!.code === null ? ended.programOutput!.signal : ended.programOutput!.code).not.toBeNull();
    expect(ended.programOutput!.text).toContain('waited at its prompt');
    /* The next turn starts the program again, in its session. */
    expect(await host.run(jobs[kind](`wait-${kind}`, 'next', { sessionId: ended.sessionId }))).toMatchObject({ ok: true, result: expect.stringContaining('echo: next') });
  });

  it('leaves a program alone while its screen moves, though its prompt shows empty', async () => {
    await setUp({ idleMs: IDLE_MS });
    expect(await within(host.run(job('wait-tick', 'TICK here')), 15_000)).toMatchObject({ ok: true, result: 'echo: TICK here' });
  });
});
