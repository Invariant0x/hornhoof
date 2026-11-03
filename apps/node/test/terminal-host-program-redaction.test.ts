import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { hasTmux, home, host, sent, setUp, job, until, SECRET } from './terminal-host-helpers.js';

type Report = Extract<NodeMessage, { type: 'job.program' }>;
describe.skipIf(!hasTmux)('untrusted tool names in live program diagnostics', () => {
  afterEach(async () => host?.stop());

  it.each([
    [`mcp__fixture__${SECRET}`, 'fixture.[hidden]'],
    ['x'.repeat(90) + SECRET, 'x'.repeat(90) + '[hidden]'],
  ])('masks %s before sending and clipping it', async (name, hidden) => {
    await setUp({ lookMs: 50, reportMs: 100 });
    const sessionId = '6321ee6d-f4b7-4269-b3b4-4580bb4ea5c0';
    const stop = new AbortController();
    const running = job('private-tool', 'TICK here', { jobId: 'private-tool-job', sessionId, signal: stop.signal });
    mkdirSync(running.input.workDir, { recursive: true });
    const file = join(home, 'projects', realpathSync(running.input.workDir).replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
    const run = host.run(running);
    try {
      await until(() => sent.some(m => m.type === 'job.program' && m.jobId === 'private-tool-job'), 10_000);
      appendFileSync(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'private-tool', name, input: {} }] } }) + '\n');
      await until(() => sent.some(m => m.type === 'job.program' && m.jobId === 'private-tool-job' && m.state === 'tool'));
      const reports = sent.filter((m): m is Report => m.type === 'job.program' && m.jobId === 'private-tool-job');
      expect(reports.find(m => m.state === 'tool')?.tool).toBe(hidden);
      expect(JSON.stringify(reports)).not.toContain(SECRET);
    } finally {
      stop.abort();
      await run;
    }
  });
});
