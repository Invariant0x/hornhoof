import { readFileSync } from 'node:fs';
import { RESTART_AFTER_MS } from '@hornhoof/protocol/map';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanups, liveTerminal } from './terminal-host-live-helpers.js';

const GIB = 1024 ** 3;
/* A machine of twelve processors and plenty of memory, so the processors decide each program's share. */
const machine = () => ({ cpus: 12, memTotal: 64 * GIB });
const startedWith = (launch: Awaited<ReturnType<typeof liveTerminal>>['launch'], call = 0) => readFileSync(launch.mock.calls[call]![1].envFile!, 'utf8');

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

describe("an agent program's share of its machine for tests", () => {
  it('starts with the Vitest workers of its share of the processors among the programs that run on the node', async () => {
    const { launch } = await liveTerminal('claude', 'queued', { live: ['other-1', 'other-2'], host: { machine, env: {} } });
    expect(startedWith(launch)).toMatch(/^VITEST_MAX_WORKERS='4'$/m);
  });

  it('counts once a program that starts again in place of its own', async () => {
    const { launch } = await liveTerminal('claude', 'queued', { live: ['receipt', 'other-1'], host: { machine, env: {} } });
    expect(startedWith(launch)).toMatch(/^VITEST_MAX_WORKERS='6'$/m);
  });

  it('starts again with its share when Hornhoof restarts a silent program', async () => {
    const c = await liveTerminal('claude', 'queued', { live: ['receipt', 'other-1', 'other-2'], host: { machine, env: {} } });
    /* The program gave no sign for longer than a restart waits. */
    vi.setSystemTime(Date.now() + RESTART_AFTER_MS.claude! + 1000);
    expect(await c.on(c.host.restart('receipt', 'job-receipt', 'Continue.'))).toEqual({ ok: true, reason: null });
    expect(c.launch).toHaveBeenCalledTimes(2);
    expect(startedWith(c.launch, 1)).toMatch(/^VITEST_MAX_WORKERS='4'$/m);
  });

  it("keeps the number of workers the machine's own settings give", async () => {
    const { launch } = await liveTerminal('claude', 'queued', { live: ['other-1'], host: { machine, env: { VITEST_MAX_WORKERS: '3' } } });
    expect(startedWith(launch)).not.toContain('VITEST_MAX_WORKERS');
  });
});
