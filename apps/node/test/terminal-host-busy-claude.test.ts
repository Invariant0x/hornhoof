import { readFileSync, realpathSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeTranscript } from '../src/terminal/programs.js';
import { claudePasted } from './fakes/word-receipts.mjs';
import { hasTmux, home, host, job, sent, setUp, tmux, until } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('live words during a long Claude tool', () => {
  afterEach(async () => { await host?.stop(); vi.restoreAllMocks(); });

  it('queues three messages 14 seconds apart through background results and compaction in the same session', async () => {
    const log = vi.fn();
    await setUp({ log, plugins: [] });
    const launch = vi.spyOn(tmux, 'launch');
    const keys = vi.spyOn(tmux, 'keys');
    const run = job('busy-claude', 'LONG_TOOL', { jobId: 'busy-claude-job', timeoutMs: 55_000, env: { FAKE_LONG_TOOL_MS: '40000' } });
    const running = host.run(run);
    await until(() => sent.some(m => m.type === 'job.program' && m.state === 'tool' && m.tool === 'Bash'));
    const words = ['First paragraph.\n\nSecond paragraph.', 'Task #226 is yours to do.', 'The answer you needed.\nContinue the work.'];
    const results: boolean[] = [];
    for (const text of words) {
      if (results.length) await new Promise(done => setTimeout(done, 14_000));
      results.push(await host.say(run.key, text, 10_000));
    }
    expect(results).toEqual([true, true, true]);
    const result = await running;
    expect(result).toMatchObject({ ok: true, sessionId: expect.any(String) });
    if (!result.sessionId) throw new Error('The program did not report a session.');
    const session = result.sessionId;
    const records = readFileSync(claudeTranscript(home, realpathSync(run.input.workDir), session), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.some(line => line.subtype === 'compact_boundary')).toBe(true);
    expect(records.some(line => line.operation === 'enqueue' && line.content.startsWith('<task-notification>'))).toBe(true);
    expect(records.filter(line => line.operation === 'enqueue' && words.some(text => line.content === claudePasted(text))).map(line => line.content)).toEqual(words.map(claudePasted));
    await host.stop();
    expect(sent.filter(m => m.type === 'agent.unheard')).toEqual([]);
    expect(log.mock.calls.filter(([line]) => line.includes('not delivered'))).toEqual([]);
    expect(launch).toHaveBeenCalledOnce();
    expect(keys.mock.calls.flat()).not.toContain('Escape');
  }, 55_000);
});
