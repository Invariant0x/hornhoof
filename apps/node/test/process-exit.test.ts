import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { runProgram } from '../src/providers/process.js';

describe('program exit information', () => {
  it('keeps the exit code, signal and observation time from a closed process', async () => {
    /* The time it was seen at comes from the clock, which the test holds still. */
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-09T08:00:00.000Z') });
    onTestFinished(() => { vi.useRealTimers(); });
    const done = await runProgram({ bin: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'], env: {}, timeoutMs: 2_147_483_647 });
    expect(done).toMatchObject({ code: 3, signal: null, timedOut: false });
    expect(done.output).toContain('boom');
    expect(done.at).toBe('2026-11-09T08:00:00.000Z');
  });

  it('keeps KILL as a signal without inventing an exit code', async () => {
    const done = await runProgram({
      bin: process.execPath,
      args: ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'],
      env: {}, timeoutMs: 2_147_483_647,
      onLine: line => process.kill(Number(line), 'SIGKILL'),
    });
    expect(done).toMatchObject({ code: null, signal: 'SIGKILL', timedOut: false });
  });
});
