import { mkdtempSync, writeFileSync } from 'node:fs';
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
  type: 'job.run', jobId: 'job-1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null, ...over,
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

  it('hides what the program held before the run and after it, and the node key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    let reads = 0;
    const adapter = {
      ...fakeAdapter(async () => ok({ output: 'old-token-0123456789 new-token-0123456789 node-key-1234567890' })),
      secrets: async () => [++reads === 1 ? 'old-token-0123456789' : 'new-token-0123456789'],
    };
    const done = await runJob(adapter, job(), dir, { hidden: ['node-key-1234567890'] });
    expect(done.tail).toBe('[hidden] [hidden] [hidden]');
  });

  it('starts a new folder for a session it never saved, even one named like constructor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(async () => ok());
    const done = await runJob(adapter, job({ jobId: 'j-x', sessionId: 'constructor' }), dir);
    expect(done.ok).toBe(true);
    expect(adapter.inputs[0]!.workDir).toBe(join(dir, 'work', 'j-x'));
  });

  it('turns a work folder it cannot make into agent_failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    writeFileSync(join(dir, 'work'), 'not a folder');
    const done = await runJob(fakeAdapter(async () => ok()), job(), dir);
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
  });
});
