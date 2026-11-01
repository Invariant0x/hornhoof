import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, ServerMessage } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { runJob, type ProviderAdapter, type RunInput, type RunResult } from '../src/runner.js';
import { readSessions } from '../src/state.js';

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

  it('passes on how hard the agent thinks, and nothing when Hornhoof leaves it to the program', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(async () => ok());
    await runJob(adapter, job({ effort: 'max' }), dir);
    await runJob(adapter, job({ jobId: 'job-2' }), dir);
    expect(adapter.inputs.map(i => i.effort)).toEqual(['max', null]);
  });

  it('passes on when Claude Code compacts the conversation, and nothing when Hornhoof leaves it to the program', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(async () => ok());
    await runJob(adapter, job({ compactWindow: 500_000 }), dir);
    await runJob(adapter, job({ jobId: 'job-2' }), dir);
    expect(adapter.inputs.map(i => i.compactWindow)).toEqual([500_000, null]);
  });

  it('gives up with a timeout when the agent does not finish in time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(() => new Promise(() => {}));
    const done = await runJob(adapter, job({ timeoutMs: 100 }), dir);
    expect(done).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('lets a turn in a live program run past its time, until the program ends it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(() => new Promise(done => setTimeout(() => done(ok()), 300)));
    const done = await runJob(adapter, job({ timeoutMs: 50 }), dir, { untimed: true });
    expect(done).toMatchObject({ ok: true, result: 'ready' });
  });

  it('keeps the session of a turn that ran out of time as its program ends it, so the next turn goes on in it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    /* The program is stopped at the time and says so a moment later, with its session. */
    const adapter = fakeAdapter(input => new Promise(done => setTimeout(() => done({ ok: false, sessionId: 'sess-1', result: '', output: '', error: 'timeout', limits: null }), input.timeoutMs + 20)));
    const done = await runJob(adapter, job({ timeoutMs: 1000 }), dir);
    expect(done).toMatchObject({ ok: false, error: 'timeout', sessionId: 'sess-1' });
    expect(readSessions(dir)).toEqual({ 'sess-1': join(dir, 'work', 'job-1') });
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

  it('starts a new session in a new folder for a session it never saved, even one named like constructor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(async () => ok());
    const done = await runJob(adapter, job({ jobId: 'j-x', sessionId: 'constructor' }), dir);
    expect(done.ok).toBe(true);
    expect(adapter.inputs[0]!.workDir).toBe(join(dir, 'work', 'j-x'));
    expect(adapter.inputs[0]!.sessionId).toBe(null);
  });

  it("starts a new session in an agent's folder when this machine never saved the one the server names", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(async () => ok());
    await runJob(adapter, job({ jobId: 'j-y', sessionId: 'sess-elsewhere', workspace: { key: 'agent-1', repo: null } }), dir);
    expect(adapter.inputs[0]!.workDir).toBe(join(dir, 'work', 'agents', 'agent-1'));
    expect(adapter.inputs[0]!.sessionId).toBe(null);
  });

  it('turns a work folder it cannot make into agent_failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    writeFileSync(join(dir, 'work'), 'not a folder');
    const done = await runJob(fakeAdapter(async () => ok()), job(), dir);
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
  });

  it('passes the Hornhoof tools only when the job has a token and the node knows the address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(async () => ok());
    await runJob(adapter, job({ toolToken: 'tool-token-0123456789', instructions: 'Be the orchestrator.' }), dir, { toolsUrl: 'http://hub.test/mcp' });
    await runJob(adapter, job({ jobId: 'job-2' }), dir, { toolsUrl: 'http://hub.test/mcp' });
    await runJob(adapter, job({ jobId: 'job-3', toolToken: 'tool-token-0123456789' }), dir);
    expect(adapter.inputs.map(i => i.tools)).toEqual([{ url: 'http://hub.test/mcp', token: 'tool-token-0123456789' }, null, null]);
    expect(adapter.inputs[0]!.instructions).toBe('Be the orchestrator.');
  });

  it('lets the agent send pictures for the turn: the address and the token in its environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(async () => ok());
    await runJob(adapter, job({ toolToken: 'tool-token-0123456789' }), dir, { toolsUrl: 'http://hub.test/mcp' });
    await runJob(adapter, job({ jobId: 'job-2' }), dir, { toolsUrl: 'http://hub.test/mcp' });
    expect(adapter.inputs[0]!.env).toEqual({ HH_ATTACH_URL: 'http://hub.test/api/attachments', HH_ATTACH_PASS: 'tool-token-0123456789' });
    expect(adapter.inputs[1]!.env).toBeUndefined();
  });

  it('hides a token the program refreshed during the run in its live events too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const events: AgentEvent[] = [];
    let token = 'old-token-0123456789';
    const adapter = {
      ...fakeAdapter(async input => {
        token = 'new-token-0123456789';
        input.onEvent?.({ kind: 'text', text: 'got new-token-0123456789' });
        return ok();
      }),
      secrets: async () => [token],
    };
    await runJob(adapter, job(), dir, { onEvent: e => events.push(e) });
    expect(events).toEqual([{ kind: 'text', text: 'got [hidden]' }]);
  });

  it('hides a token the program held only in the middle of the run in its result and output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    let token = 'old-token-0123456789';
    const adapter = {
      ...fakeAdapter(async input => {
        token = 'middle-token-0123456789';
        input.onEvent?.({ kind: 'text', text: 'working' });
        await new Promise(r => setTimeout(r, 10));
        token = 'new-token-0123456789';
        return { ...ok(), result: 'saw middle-token-0123456789', output: 'printed middle-token-0123456789' };
      }),
      secrets: async () => [token],
    };
    const done = await runJob(adapter, job(), dir, { onEvent: () => {} });
    expect(done.result).toBe('saw [hidden]');
    expect(done.tail).not.toContain('middle-token');
  });

  it('hides secrets in live events and cuts them to size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const events: AgentEvent[] = [];
    const adapter = fakeAdapter(async input => {
      input.onEvent?.({ kind: 'tool', name: 'Bash', input: `curl -H "Authorization: Bearer tool-token-0123456789" ${SECRET}` });
      input.onEvent?.({ kind: 'tool', name: 'Bash', input: 'x'.repeat(1000) });
      input.onEvent?.({ kind: 'text', text: `key sk-job-secret-999 ${'y'.repeat(9000)}` });
      return ok();
    });
    await runJob(adapter, job({ secret: 'sk-job-secret-999', toolToken: 'tool-token-0123456789' }), dir, { onEvent: e => events.push(e) });
    expect(events[0]).toEqual({ kind: 'tool', name: 'Bash', input: 'curl -H "Authorization: Bearer [hidden]" [hidden]' });
    expect(events[1]).toEqual({ kind: 'tool', name: 'Bash', input: 'x'.repeat(299) + '…' });
    expect(events[2]).toMatchObject({ kind: 'text', text: expect.stringMatching(/^key \[hidden\] y+…$/) });
    expect((events[2] as { text: string }).text).toHaveLength(8000);
  });

  it('ends a job that was called off as cancelled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const stop = new AbortController();
    const adapter = fakeAdapter(input => new Promise(done => input.signal?.addEventListener('abort', () => done(ok({ ok: false, error: 'agent_failed', output: 'killed' })))));
    setTimeout(() => stop.abort(), 50);
    const done = await runJob(adapter, job(), dir, { signal: stop.signal });
    expect(done).toMatchObject({ ok: false, error: 'cancelled', result: 'Stopped.' });
  });
});
