import { readFileSync } from 'node:fs';
import { RESTART_AFTER_MS } from '@hornhoof/protocol/map';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitEnv } from '../src/workspace.js';
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

/* A department may keep several repositories, and each task's turn works in its own, with that repository's token. */
describe('the repository a program that stays up works in', () => {
  it('starts the program again in its session for a turn whose repository has another token', async () => {
    const c = await liveTerminal('claude', 'queued', { host: { machine, env: {} } });
    const thinking = (jobId: string) => c.until(() => c.sent.some(m => m.type === 'job.program' && m.jobId === jobId && m.state === 'thinking'));
    c.finish();
    await c.on(c.running);
    const shop = c.run('Shop work.', 'job-shop', { env: gitEnv({ url: 'https://github.com/acme/shop.git', token: 'ghp_shop2222' }) });
    await thinking('job-shop');
    expect(startedWith(c.launch, c.launch.mock.calls.length - 1)).toMatch(/^HH_GIT_PASSWORD='ghp_shop2222'$/m);
    c.finish();
    await c.on(shop);
    const launched = c.launch.mock.calls.length;
    const platform = c.run('Platform work.', 'job-platform', { env: gitEnv({ url: 'https://github.com/acme/platform.git', token: 'ghp_platform1111' }) });
    await thinking('job-platform');
    expect(c.launch).toHaveBeenCalledTimes(launched + 1);
    expect(startedWith(c.launch, launched)).toMatch(/^HH_GIT_PASSWORD='ghp_platform1111'$/m);
    c.finish();
    expect(await c.on(platform)).toMatchObject({ ok: true });
  });
});
