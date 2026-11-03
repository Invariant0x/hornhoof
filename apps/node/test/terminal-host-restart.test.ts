import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESTART_AFTER_MS } from '@hornhoof/protocol/map';
import { hasTmux, host, tmux, sent, setUp, codexJob, until } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('restarting a silent program in the same turn', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });
  it('refuses a missing turn without touching tmux', async () => {
    await setUp(); const launch = vi.spyOn(tmux, 'launch');
    expect(await host.restart('missing', 'job', 'Continue.')).toEqual({ ok: false, reason: 'No turn runs for this agent.' });
    expect(launch).not.toHaveBeenCalled();
  });
  it('resumes Codex with the same job, session and tools, and refuses a second restart', async () => {
    const log = vi.fn(); await setUp({ log, lookMs: 50 });
    const running = host.run(codexJob('restart', 'HANG', { jobId: 'job-restart' }));
    await until(() => sent.some(m => m.type === 'job.program' && m.jobId === 'job-restart'));
    const a = host['agents'].get('restart')!;
    const session = a.sessionId;
    const token = a.turn?.toolToken;
    const launch = vi.spyOn(tmux, 'launch');
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + RESTART_AFTER_MS.codex! + 1000);
    expect(await host.restart('restart', 'job-restart', 'Continue after restart.')).toEqual({ ok: true, reason: null });
    expect(await host.restart('restart', 'job-restart', 'Again.')).toEqual({ ok: false, reason: 'This turn already restarted its program.' });
    clock.mockRestore();
    expect(await running).toMatchObject({ ok: true, sessionId: session, result: 'echo: Continue after restart.' });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![1].command).toContain('resume');
    expect(launch.mock.calls[0]![1].command).toContain(session);
    expect(token).toBe('tok-turn');
    expect(log.mock.calls.some(([text]) => text.includes('restarted'))).toBe(true);
  });
  it('replays only words without a log acknowledgment and ignores the old program ending during replacement', async () => {
    await setUp({ lookMs: 50, enterWaitMs: 100 });
    const running = host.run(codexJob('held', 'HANG', { jobId: 'job-held', env: { FAKE_HOLD_WORDS: '1' } }));
    await until(() => sent.some(m => m.type === 'job.program' && m.jobId === 'job-held'));
    expect(await host.say('held', 'Words held by the program.')).toBe(true);
    const launch = tmux.launch.bind(tmux);
    vi.spyOn(tmux, 'launch').mockImplementationOnce(async (name, spec) => {
      await host['hook']('held', 'end', { reason: 'other' });
      await launch(name, spec);
    });
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + RESTART_AFTER_MS.codex! + 1000);
    expect(await host.restart('held', 'job-held', 'Continue.')).toEqual({ ok: true, reason: null });
    clock.mockRestore();
    expect(await running).toMatchObject({ ok: true, result: 'echo: Continue.\n\nWords held by the program.' });
  });

  it('keeps a second held message when the rollout acknowledged only the first', async () => {
    const { appendFileSync } = await import('node:fs');
    const { findRollout } = await import('../src/terminal/programs.js');
    await setUp({ lookMs: 50, enterWaitMs: 100 });
    const running = host.run(codexJob('two-held', 'HANG', { jobId: 'job-two', env: { FAKE_HOLD_WORDS: '1' } }));
    await until(() => host['agents'].get('two-held')?.took === true);
    expect(await host.say('two-held', 'First message.')).toBe(true);
    expect(await host.say('two-held', 'Second message.')).toBe(true);
    const a = host['agents'].get('two-held')!;
    const log = findRollout(a.home, a.workDir, 0, a.sessionId)!;
    appendFileSync(log.file, JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'First message.' }] } } }) + '\n');
    host['drain'](a);
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + RESTART_AFTER_MS.codex! + 1000);
    expect(await host.restart('two-held', 'job-two', 'Continue.')).toEqual({ ok: true, reason: null });
    clock.mockRestore();
    expect(await running).toMatchObject({ ok: true, result: 'echo: Continue.\n\nSecond message.' });
  });

});
