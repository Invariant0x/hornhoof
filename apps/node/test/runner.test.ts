import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, ServerMessage } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ownFs } from '../src/agent-fs.js';
import { jobDone, ProgramNotStarted, runJob, type ProviderAdapter, type RunInput, type RunResult } from '../src/runner.js';
import type { Worktree } from '../src/tests.js';
import { readSessions } from '../src/state.js';
import { deferred } from '../../../test-support/deferred.mjs';
import { eventually } from '../../../test-support/eventually.mjs';

const SECRET = 'oauth-token-0123456789abcdef';
const me = { uid: process.getuid!(), gid: process.getgid!() };
/* A job's time that never runs out: the longest a timer waits, less the 30 s at most the runner gives past it. */
const NEVER_JOB_MS = 2_147_483_647 - 30_000;
/* A clock that moves only when the test moves it, for the job's timers and the waits that end at a moment, which Node's own
   AbortSignal.timeout would keep on the real clock. */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const timer = new AbortController();
    setTimeout(() => { timer.abort(new DOMException('The operation timed out.', 'TimeoutError')); }, ms);
    return timer.signal;
  });
  onTestFinished(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
}

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
  type: 'job.run', jobId: 'job-1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NEVER_JOB_MS, secret: null, instructions: null, toolToken: null, ...over,
});

const ok = (over: Partial<RunResult> = {}): RunResult => ({ ok: true, sessionId: 'sess-1', result: 'ready', output: '', error: null, limits: null, ...over });

describe('runJob', () => {
  it.each(['vault_save', 'vault_entry'])('hides %s inputs, results and raw completion output before sending them', async name => {
    fakeClock();
    const marker = 'private-vault-marker-1178';
    const events: AgentEvent[] = [];
    const adapter = fakeAdapter(async input => {
      input.onEvent!({ kind: 'tool', name: `hornhoof.${name}`, input: JSON.stringify({ password: marker }) });
      input.onEvent!({ kind: 'tool_result', ok: true, summary: JSON.stringify({ password: marker }) });
      return ok({ result: marker, output: marker, failure: { kind: 'unknown', text: marker, retryable: false } });
    });
    const done = await runJob(adapter, job(), mkdtempSync(join(tmpdir(), 'hh-private-')), { onEvent: event => events.push(event) });
    expect(events).toHaveLength(2);
    expect(JSON.stringify({ events, done })).not.toContain(marker);
    expect(done.tail).toMatch(/hidden/i);
  });

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
    fakeClock();
    let ended = false;
    const running = runJob(adapter, job({ timeoutMs: 100 }), dir).finally(() => { ended = true; });
    await eventually(() => adapter.inputs.length === 1);
    /* Its own 100 ms and a tenth of them for the program to say how it ended. */
    await vi.advanceTimersByTimeAsync(109);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('lets a turn in a live program run past its time, until the program ends it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const ends = deferred(), adapter = fakeAdapter(async () => { await ends.promise; return ok(); });
    fakeClock();
    let ended = false;
    const running = runJob(adapter, job({ timeoutMs: 50 }), dir, { untimed: true }).finally(() => { ended = true; });
    await eventually(() => adapter.inputs.length === 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(ended).toBe(false);
    ends.resolve();
    expect(await running).toMatchObject({ ok: true, result: 'ready' });
  });

  it('keeps the session of a turn that ran out of time as its program ends it, so the next turn goes on in it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    /* The program is stopped at the time and says so a moment later, with its session. */
    const adapter = fakeAdapter(input => new Promise(done => setTimeout(() => done({ ok: false, sessionId: 'sess-1', result: '', output: '', error: 'timeout', limits: null }), input.timeoutMs + 20)));
    fakeClock();
    const running = runJob(adapter, job({ timeoutMs: 1000 }), dir);
    await eventually(() => adapter.inputs.length === 1);
    await vi.advanceTimersByTimeAsync(1020);
    const done = await running;
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
    expect(done.unstarted).toBeUndefined();
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

  it("makes the work folder as the agents' user when the program's owner says how, so a root node follows no link of theirs", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const made: string[] = [];
    const adapter = { ...fakeAdapter(async () => ok()), owner: { user: null, home: dir, prepare: () => {}, mkdir: async (path: string) => void made.push(path) } };
    await runJob(adapter, job({ workspace: { key: 'agent-1', repo: null } }), dir);
    expect(made).toEqual([join(dir, 'work', 'agents', 'agent-1')]);
    expect(existsSync(join(dir, 'work'))).toBe(false);
  });

  it("writes the agent's skills where its program finds them before the program starts, through the agents' own file work", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const skill = { name: 'dev-tdd', description: 'Test first.', body: '# Test first\n\nWrite the test first.' };
    const seen: boolean[] = [];
    const adapter = fakeAdapter(async input => {
      seen.push(existsSync(join(input.workDir, '.agents', 'skills', 'dev-tdd', 'SKILL.md')));
      return ok();
    });
    const written: string[] = [];
    const fs = { ...ownFs, write: async (path: string, data: string) => void (written.push(path), await ownFs.write(path, data)) };
    const owned = { ...adapter, owner: { user: me, home: dir, prepare: () => {}, fs } };
    await runJob(owned, job({ provider: 'kimi', workspace: { key: 'agent-1', repo: null }, skills: [skill] }), dir);
    expect(seen).toEqual([true]);
    expect(written).toContain(join(dir, 'work', 'agents', 'agent-1', '.agents', 'skills', 'dev-tdd', 'SKILL.md'));
    /* Only the agent's own skills, on a machine of any image. */
    expect(readdirSync(join(dir, 'work', 'agents', 'agent-1', '.agents', 'skills'))).toEqual(['dev-tdd']);
    /* Without file work of its own, the owner's user does it through a helper for the job. */
    await runJob({ ...adapter, owner: { user: me, home: dir, prepare: () => {} } }, job({ provider: 'claude', workspace: { key: 'agent-2', repo: null }, skills: [skill] }), dir);
    expect(seen).toEqual([true, false]);
    expect(existsSync(join(dir, 'work', 'agents', 'agent-2', '.claude', 'skills', 'dev-tdd', 'SKILL.md'))).toBe(true);
    /* A job that brings none, such as a test of the subscription, leaves the folder as it is. */
    await runJob(adapter, job({ provider: 'kimi' }), dir);
    expect(existsSync(join(dir, 'work', 'job-1', '.agents'))).toBe(false);
  });

  it('turns a work folder it cannot make into agent_failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    writeFileSync(join(dir, 'work'), 'not a folder');
    const done = await runJob(fakeAdapter(async () => ok()), job(), dir);
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
  });

  it('says a turn ended before its program started when its folders could not be made ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    writeFileSync(join(dir, 'work'), 'not a folder');
    const adapter = fakeAdapter(async () => ok());
    const done = await runJob(adapter, job({ workspace: { key: 'a1', repo: null } }), dir);
    expect(done).toMatchObject({ ok: false, error: 'agent_failed', unstarted: true });
    expect(adapter.inputs).toEqual([]);
  });

  it('says a turn ended before its program started when the program could not even be launched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const done = await runJob(fakeAdapter(async () => { throw new ProgramNotStarted(new Error('EIO: i/o error, write')); }), job(), dir);
    expect(done).toMatchObject({ ok: false, error: 'agent_failed', unstarted: true, tail: 'EIO: i/o error, write' });
  });

  it('says nothing of a start for a turn called off before its program started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    writeFileSync(join(dir, 'work'), 'not a folder');
    const stop = new AbortController();
    stop.abort();
    const done = await runJob(fakeAdapter(async () => ok()), job(), dir, { signal: stop.signal });
    expect(done).toMatchObject({ error: 'cancelled' });
    expect(done.unstarted).toBeUndefined();
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
    /* The event goes out once the runner has read what the program holds then. */
    const told = deferred();
    const adapter = {
      ...fakeAdapter(async input => {
        token = 'middle-token-0123456789';
        input.onEvent?.({ kind: 'text', text: 'working' });
        await told.promise;
        token = 'new-token-0123456789';
        return { ...ok(), result: 'saw middle-token-0123456789', output: 'printed middle-token-0123456789' };
      }),
      secrets: async () => [token],
    };
    const done = await runJob(adapter, job(), dir, { onEvent: () => { told.resolve(); } });
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
    const running = runJob(adapter, job(), dir, { signal: stop.signal });
    await eventually(() => adapter.inputs.length === 1);
    stop.abort();
    const done = await running;
    expect(done).toMatchObject({ ok: false, error: 'cancelled', result: 'Stopped.' });
  });

  it('prepares the repository lockfile browser before the turn and records browser-error without failing the agent turn when Chromium cannot start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const prepared: string[] = [];
    const adapter = fakeAdapter(async () => {
      prepared.push('agent-ran');
      return ok();
    });
    const repo = { url: 'https://github.com/acme/shop.git', branch: 'main', token: '' };
    const git = async () => '';
    const done = await runJob(adapter, job({ workspace: { key: 'dev-1', repo } }), dir, {
      git,
      prepareRepoBrowser: async repoDir => {
        prepared.push(repoDir);
      },
    });
    expect(done.ok).toBe(true);
    expect(prepared).toEqual([join(dir, 'work', 'agents', 'dev-1', 'shop'), 'agent-ran']);

    const broken = await runJob(adapter, job({ jobId: 'job-2', workspace: { key: 'dev-1', repo } }), dir, {
      git,
      prepareRepoBrowser: async () => {
        throw new Error('Playwright browsers could not start: libnss3.so missing');
      },
    });
    expect(broken).toMatchObject({ ok: true, result: 'ready', error: null });
    expect(prepared).toEqual([join(dir, 'work', 'agents', 'dev-1', 'shop'), 'agent-ran', 'agent-ran']);
    expect(readFileSync(join(dir, 'browser-error'), 'utf8').trim()).toBe('libnss3.so missing');
  });
});

describe('a one-shot call', () => {
  /* An adapter whose program runs one call headless, and records what it was given and what its folder held. */
  function callAdapter(result: (input: RunInput) => RunResult = () => ok({ sessionId: null, result: 'three findings' })) {
    const adapter = fakeAdapter(async () => ok());
    const calls: { input: RunInput; files: string[] }[] = [];
    return Object.assign(adapter, {
      calls,
      oneCall: async (input: RunInput) => {
        calls.push({ input, files: readdirSync(input.workDir) });
        writeFileSync(join(input.workDir, 'notes.md'), 'scratch');
        return result(input);
      },
    });
  }

  it('keeps an untimed call running until explicitly cancelled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const started = deferred();
    const stop = new AbortController();
    const adapter = {
      ...fakeAdapter(async () => ok()),
      oneCall: async ({ signal }: RunInput) => new Promise<RunResult>(done => {
        signal!.addEventListener('abort', () => done(ok()), { once: true });
        started.resolve();
      }),
    };
    fakeClock();
    let ended = false;
    const running = runJob(adapter, job({ call: true, timeoutMs: 0 }), dir, { signal: stop.signal }).finally(() => { ended = true; });
    await started.promise;
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(ended).toBe(false);
    stop.abort();
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
    expect(existsSync(join(dir, 'work', 'calls', 'job-1'))).toBe(false);
  });

  it("runs the program's one-call mode in a fresh folder of its own, with no session, and removes the folder after", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = callAdapter();
    const done = await runJob(adapter, job({ jobId: 'call-1', call: true, sessionId: 'sess-1' }), dir);
    expect(done).toMatchObject({ type: 'job.done', jobId: 'call-1', ok: true, result: 'three findings', error: null });
    expect(adapter.inputs).toHaveLength(0);
    expect(adapter.calls[0]!.input).toMatchObject({ workDir: join(dir, 'work', 'calls', 'call-1'), sessionId: null, agentKey: null, tools: null });
    expect(existsSync(join(dir, 'work', 'calls', 'call-1'))).toBe(false);
    expect(readSessions(dir)).toEqual({});
  });

  it('clones the branch it names into its folder before the program starts, and removes both after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = callAdapter();
    const cloned: string[][] = [];
    const git = async (args: string[], { cwd }: { cwd: string }) => {
      cloned.push(args);
      if (args[0] === 'clone') mkdirSync(join(cwd, 'shop'), { recursive: true });
      return args[0] === 'remote' ? 'https://github.com/acme/shop.git' : '';
    };
    const repo = { url: 'https://github.com/acme/shop.git', branch: 'feature-x', token: '' };
    const done = await runJob(adapter, job({ jobId: 'call-2', call: true, workspace: { key: '00000000-0000-4000-8000-000000000002', repo } }), dir, { git, prepareRepoBrowser: async () => {} });
    expect(done.ok).toBe(true);
    expect(cloned[0]).toEqual(['clone', '--quiet', '--branch', 'feature-x', '--', repo.url, join(dir, 'work', 'calls', 'call-2', 'shop')]);
    expect(adapter.calls[0]!.files).toEqual(['shop']);
    expect(adapter.calls[0]!.input.agentKey).toBeNull();
    expect(existsSync(join(dir, 'work', 'calls', 'call-2'))).toBe(false);
  });

  it('answers at once, in plain words, when the program has no mode that runs one call and exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = fakeAdapter(async () => new Promise<RunResult>(() => {}));
    const done = await runJob(adapter, job({ jobId: 'call-3', call: true, provider: 'kimi' }), dir);
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(done.tail).toBe('Kimi Code has no mode that runs one call and exits, so it takes no one-shot calls. Start them on a subscription whose program has one.');
    expect(adapter.inputs).toHaveLength(0);
    expect(existsSync(join(dir, 'work', 'calls', 'call-3'))).toBe(false);
  });

  it('removes its folder even when the program fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const adapter = callAdapter(() => { throw new Error('crashed'); });
    const done = await runJob(adapter, job({ jobId: 'call-4', call: true }), dir);
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(existsSync(join(dir, 'work', 'calls', 'call-4'))).toBe(false);
  });
});

describe('jobDone', () => {
  const ended = (programOutput?: RunResult['programOutput']): RunResult => ({ ok: false, sessionId: 's1', result: '', output: 'gone', error: 'agent_failed', limits: null, ...(programOutput ? { programOutput } : {}) });

  it('says how the program ended, a signal by its name', () => {
    expect(jobDone('j1', ended({ text: 'gone', code: null, signal: 15, at: '2026-11-03T04:00:00.000Z', complete: true }), []).exit).toEqual({ code: null, signal: 'SIGTERM' });
    expect(jobDone('j1', ended({ text: 'gone', code: 2, signal: null, at: '2026-11-03T04:00:00.000Z', complete: true }), []).exit).toEqual({ code: 2, signal: null });
    expect(jobDone('j1', ended({ text: 'gone', code: null, signal: 'SIGKILL', at: '2026-11-03T04:00:00.000Z', complete: true }), []).exit).toEqual({ code: null, signal: 'SIGKILL' });
  });

  it('says nothing of an end the node did not see', () => {
    expect(jobDone('j1', ended(), [])).not.toHaveProperty('exit');
  });
});

const HEAD = 'c'.repeat(40);
const SHOP = { url: 'https://github.com/acme/shop.git', branch: 'main', token: 'ghp_shop0123' };
const SCOPE = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'a'.repeat(64) };
/* git in the agent's clone: it names the commit there and does nothing else. */
const headAt = (sha: string | Error) => async (args: string[]) => {
  if (args[0] !== 'rev-parse') return '';
  if (sha instanceof Error) throw sha;
  return sha;
};

describe("the dependencies of an agent's worktree", () => {
  const owned = (dir: string, run: (input: RunInput) => Promise<RunResult> = async () => ok(), user: { uid: number; gid: number } | null = me) => ({ ...fakeAdapter(run), owner: { user, home: dir, prepare: () => {}, fs: ownFs } });
  const shopJob = (over: Partial<Extract<ServerMessage, { type: 'job.run' }>> = {}) => job({ workspace: { key: 'dev-1', repo: SHOP, repositoryScope: SCOPE }, ...over });

  it('go in place for its commit before its program starts, as its user\'s files, and one line says how it went', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const happened: string[] = [];
    const asked: Worktree[] = [];
    const events: AgentEvent[] = [];
    const adapter = owned(dir, async () => (happened.push('program'), ok()));
    const done = await runJob(adapter, shopJob(), dir, {
      git: headAt(HEAD), prepareRepoBrowser: async () => {}, onEvent: event => events.push(event),
      dependencies: async tree => {
        happened.push('dependencies');
        asked.push(tree);
        return 'Dependencies in place from the shared harness after 12 s.';
      },
    });
    expect(done.ok).toBe(true);
    expect(happened).toEqual(['dependencies', 'program']);
    expect(asked).toEqual([{ id: 'job-1', checkout: join(dir, 'work', 'agents', 'dev-1', 'shop'), commitSha: HEAD, repo: { url: SHOP.url, token: SHOP.token }, repositoryScope: SCOPE, owner: me, fs: ownFs }]);
    expect(events).toEqual([{ kind: 'text', text: 'Dependencies in place from the shared harness after 12 s.' }]);
  });

  it('say nothing when there was nothing to put in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const events: AgentEvent[] = [];
    const adapter = owned(dir);
    await runJob(adapter, shopJob(), dir, { git: headAt(HEAD), prepareRepoBrowser: async () => {}, onEvent: event => events.push(event), dependencies: async () => null });
    expect(adapter.inputs).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("are not asked for without the repository's place in the registry, without its repository, or for a program with no user of its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const asked: string[] = [];
    const dependencies = async (tree: Worktree) => (asked.push(tree.checkout), null);
    const options = { git: headAt(HEAD), prepareRepoBrowser: async () => {}, dependencies };
    await runJob(owned(dir), job({ workspace: { key: 'dev-1', repo: SHOP } }), dir, options);
    await runJob(owned(dir), job({ workspace: { key: 'dev-1', repo: null, repositoryScope: SCOPE } }), dir, options);
    await runJob(owned(dir, async () => ok(), null), shopJob(), dir, options);
    expect(asked).toEqual([]);
  });

  it('leave the program to install them itself when they cannot be placed, and say so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const events: AgentEvent[] = [];
    const adapter = owned(dir);
    await runJob(adapter, shopJob(), dir, { git: headAt(HEAD), prepareRepoBrowser: async () => {}, onEvent: event => events.push(event), dependencies: async () => { throw new Error('Hornhoof answered 502.'); } });
    expect(adapter.inputs).toHaveLength(1);
    expect(events).toEqual([{ kind: 'text', text: expect.stringMatching(/^The program starts without the shared dependencies.*Hornhoof answered 502\.$/) }]);
    const asked: string[] = [];
    await runJob(adapter, shopJob({ jobId: 'job-2' }), dir, { git: headAt(new Error('fatal: not a git repository')), prepareRepoBrowser: async () => {}, onEvent: event => events.push(event), dependencies: async tree => (asked.push(tree.checkout), null) });
    expect(asked).toEqual([]);
    expect(adapter.inputs).toHaveLength(2);
    expect(events[1]).toEqual({ kind: 'text', text: expect.stringMatching(/^The program starts without the shared dependencies.*commit/) });
    /* What another machine's failed build said stays one short line here. */
    const failed = `The harness unit dependencies failed to build: npm ERR! code E404\n${'npm ERR! 404 Not Found\n'.repeat(200)}`;
    await runJob(adapter, shopJob({ jobId: 'job-3' }), dir, { git: headAt(HEAD), prepareRepoBrowser: async () => {}, onEvent: event => events.push(event), dependencies: async () => { throw new Error(failed); } });
    expect(events[2]).toEqual({ kind: 'text', text: expect.stringMatching(/failed to build: npm ERR! code E404$/) });
  });

  it('give up on them at their deadline whatever holds them there, and the program starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const events: AgentEvent[] = [];
    const adapter = owned(dir);
    let told: AbortSignal | undefined;
    fakeClock();
    let ended = false;
    const running = runJob(adapter, shopJob(), dir, {
      git: headAt(HEAD), prepareRepoBrowser: async () => {}, onEvent: event => events.push(event), dependenciesMs: 50,
      dependencies: (_tree, signal) => { told = signal; return new Promise<null>(() => {}); },
    }).finally(() => { ended = true; });
    await eventually(() => told !== undefined);
    await vi.advanceTimersByTimeAsync(49);
    expect(ended).toBe(false); expect(adapter.inputs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const done = await running;
    expect(done.ok).toBe(true);
    expect(adapter.inputs).toHaveLength(1);
    expect(events).toEqual([{ kind: 'text', text: expect.stringMatching(/^The program starts without the shared dependencies.*did not come within 1 s\.$/) }]);
    /* The work that holds them is told to stop, and tidies up by itself. */
    expect(told?.aborted).toBe(true);
  });

  it('end a turn stopped while something holds them, before its program starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const stop = new AbortController();
    const adapter = owned(dir), asked = deferred();
    const running = runJob(adapter, shopJob(), dir, { signal: stop.signal, git: headAt(HEAD), prepareRepoBrowser: async () => {}, dependencies: () => { asked.resolve(); return new Promise<null>(() => {}); } });
    await asked.promise;
    stop.abort();
    const done = await running;
    expect(done).toMatchObject({ ok: false, error: 'cancelled' });
    expect(adapter.inputs).toEqual([]);
  });

  it('end a turn stopped while they were being placed, before its program starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-node-'));
    const stop = new AbortController();
    const adapter = owned(dir);
    const done = await runJob(adapter, shopJob(), dir, {
      signal: stop.signal, git: headAt(HEAD), prepareRepoBrowser: async () => {},
      dependencies: async () => { stop.abort(); throw new DOMException('Stopped.', 'AbortError'); },
    });
    expect(done).toMatchObject({ ok: false, error: 'cancelled' });
    expect(adapter.inputs).toEqual([]);
  });
});
