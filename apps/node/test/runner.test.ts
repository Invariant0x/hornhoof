import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { runJob, type ProviderAdapter, type RunInput, type RunResult } from '../src/runner.js';

const SECRET = 'oauth-token-0123456789abcdef';

function fakeAdapter(run: (input: RunInput) => Promise<RunResult>): ProviderAdapter & { inputs: RunInput[] } {
  const inputs: RunInput[] = [];
  return {
    inputs,
    install: async () => {},
    loggedIn: async () => true,
    login: async () => {},
    secrets: async () => [SECRET],
    run: input => {
      inputs.push(input);
      return run(input);
    },
  };
}

const job = (over: Partial<Extract<ServerMessage, { type: 'job.run' }>> = {}): Extract<ServerMessage, { type: 'job.run' }> => ({
  type: 'job.run', jobId: 'job-1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, ...over,
});

const ok = (over: Partial<RunResult> = {}): RunResult => ({ ok: true, sessionId: 'sess-1', result: 'ready', output: '', error: null, limits: null, ...over });

describe('runJob', () => {
  it('keeps the last 4096 bytes of output and hides secrets in it and in the result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(async () => ok({ result: `token ${SECRET}`, output: 'x'.repeat(10000) + ` leaked ${SECRET} and sk-job-secret-999` }));
    const done = await runJob(adapter, job({ secret: 'sk-job-secret-999' }), dir);
    expect(done).toMatchObject({ type: 'job.done', jobId: 'job-1', ok: true, sessionId: 'sess-1', result: 'token [hidden]', error: null });
    expect(Buffer.byteLength(done.tail)).toBeLessThanOrEqual(4096);
    expect(done.tail).toContain('leaked [hidden] and [hidden]');
    expect(adapter.inputs[0]!.workDir).toBe(join(dir, 'work', 'job-1'));
  });

  it('gives up with a timeout when the agent does not finish in time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(() => new Promise(() => {}));
    const done = await runJob(adapter, job({ timeoutMs: 100 }), dir);
    expect(done).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('runs a resumed session in the folder of the job that started it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(async () => ok());
    await runJob(adapter, job({ jobId: 'first' }), dir);
    await runJob(adapter, job({ jobId: 'second', sessionId: 'sess-1' }), dir);
    expect(adapter.inputs.map(i => i.workDir)).toEqual([join(dir, 'work', 'first'), join(dir, 'work', 'first')]);
    expect(adapter.inputs[1]!.sessionId).toBe('sess-1');
  });

  it('turns a crash of the adapter into agent_failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(async () => {
      throw new Error(`spawn failed with ${SECRET}`);
    });
    const done = await runJob(adapter, job(), dir);
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(done.tail).toContain('[hidden]');
  });
});
