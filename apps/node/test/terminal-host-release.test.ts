import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RetireIdleWorkspace } from '../src/terminal/program-retire.js';
import { agyProgram } from '../src/terminal/programs.js';
import { codexJob, done, hasTmux, home, host, job, kimiJob, sent, setUp, tmux, typeTurn, until } from './terminal-host-helpers.js';

/* An agent moved to another plan leaves a program on this node. It goes once it is idle: its turn ends with its result first, no
   key stops it, and nothing of anyone's goes with it. Fake programs in real tmux, no live CLI. */
const FAKE_AGY = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));
const agyJob = (key: string, prompt: string, more: Parameters<typeof job>[2] = {}) => ({ ...job(key, prompt, more), program: agyProgram, bin: FAKE_AGY, home: join(home, 'agy', key) });
const PROGRAMS = { claude: job, codex: codexJob, kimi: kimiJob, antigravity: agyJob };
const KINDS = Object.keys(PROGRAMS) as (keyof typeof PROGRAMS)[];
type Left = Extract<NodeMessage, { type: 'agent.input_left' }>;

const start = () => setUp({ cols: 120, rows: 40, readyMs: 5000, lookMs: 100, toolsMs: 5000, enterWaitMs: 300, typingQuietMs: 50, keptWaitMs: 500 });
const nameOf = (key: string) => `a-${key}`;
const gone = (key: string) => until(async () => !(await tmux.has(nameOf(key))));
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const running = (key: string) => until(() => host['agents'].get(key)?.took === true);

/* A finished turn on this agent's program. */
async function finished(key: string, prompt = 'first', more: Parameters<typeof job>[2] = {}, kind: keyof typeof PROGRAMS = 'claude') {
  const jobId = randomUUID();
  const result = await host.run(PROGRAMS[kind](key, prompt, { jobId, ...more }));
  expect(result.ok).toBe(true);
  return { jobId, sessionId: result.sessionId };
}

const binding = (key: string, more: { workspaceId?: string; bindingVersion?: number } = {}) => ({
  workspaceId: randomUUID(), taskId: randomUUID(), agentId: key, nodeId: 'node-1', assignmentEpoch: 0, bindingVersion: 1, repositoryId: randomUUID(), taskBranch: 'task-1', baseSha: 'a'.repeat(40), ...more,
});

/* A finished turn on a program started for a task's workspace, and the request that names exactly it. */
async function boundProgram(key: string): Promise<RetireIdleWorkspace> {
  const jobId = randomUUID();
  const workspaceBinding = binding(key);
  const first = job(key, 'first', { jobId });
  const result = await host.run({ ...first, input: { ...first.input, workspaceBinding } });
  expect(result.ok).toBe(true);
  return { agentKey: key, expectedInstance: host.instanceOf(key)!, expectedJobId: jobId, workspaceId: workspaceBinding.workspaceId, bindingVersion: workspaceBinding.bindingVersion };
}

describe.skipIf(!hasTmux)('the program of a plan its agent left', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await host.stop();
  });

  it.each(KINDS)('closes an idle program and its session: %s', async kind => {
    await start();
    const key = randomUUID();
    const { jobId } = await finished(key, 'first', {}, kind);
    expect(await tmux.alive(nameOf(key))).toBe(true);
    await host.release(key, jobId);
    await gone(key);
    expect(host.instanceOf(key)).toBeNull();
  }, 30_000);

  it.each(['claude', 'codex', 'kimi'] as const)('lets the running turn end with its result first, and presses no key: %s', async kind => {
    await start();
    const key = randomUUID();
    const jobId = randomUUID();
    const keys = vi.spyOn(tmux, 'keys');
    const turn = host.run(PROGRAMS[kind](key, 'SLOW work', { jobId }));
    await running(key);
    await host.release(key, jobId);
    expect(await tmux.alive(nameOf(key))).toBe(true);
    await expect(turn).resolves.toMatchObject({ ok: true, error: null });
    await gone(key);
    expect(keys.mock.calls.flat()).not.toContain('Escape');
    expect(keys.mock.calls.flat()).not.toContain('C-c');
  }, 30_000);

  it('waits for a turn a person typed as well', async () => {
    await start();
    const key = randomUUID();
    const first = await finished(key);
    const typed = randomUUID();
    await typeTurn(key, 'view', 'SLOW typed', typed);
    await host.release(key, first.jobId);
    expect(await tmux.alive(nameOf(key))).toBe(true);
    await until(() => Boolean(done(typed)), 15_000);
    await gone(key);
  }, 30_000);

  it('closes a session whose program already ended', async () => {
    await start();
    const key = randomUUID();
    const jobId = randomUUID();
    await expect(host.run(job(key, 'EXIT', { jobId }))).resolves.toMatchObject({ ok: false, error: 'agent_failed' });
    await until(async () => !(await tmux.alive(nameOf(key))));
    expect(await tmux.has(nameOf(key))).toBe(true);
    await host.release(key, jobId);
    await gone(key);
  }, 30_000);

  it('does nothing for an agent it never ran', async () => {
    await start();
    await expect(host.release(randomUUID(), randomUUID())).resolves.toBeUndefined();
  });

  describe('words someone left', () => {
    const opened = async (key: string, words: string) => {
      await host.open({ type: 'term.open', termId: `view-${key}`, agentKey: key, cols: 120, rows: 40, write: true });
      host.input({ type: 'term.input', termId: `view-${key}`, data: words });
      await until(async () => (await tmux.screen(nameOf(key), 0)).includes(words));
    };
    const lefts = () => sent.filter((m): m is Left => m.type === 'agent.input_left');

    it('go to Hornhoof first, and the program goes once Hornhoof has them', async () => {
      await start();
      const key = randomUUID();
      const { jobId } = await finished(key);
      await opened(key, 'words of a person');
      await sleep(100);
      await host.release(key, jobId);
      await until(() => lefts().length > 0);
      expect(lefts()[0]).toMatchObject({ agentKey: key, text: 'words of a person', typed: true });
      expect(await tmux.alive(nameOf(key))).toBe(true);
      host.inputKept({ type: 'agent.input_kept', agentKey: key, ref: lefts()[0]!.ref });
      await gone(key);
    }, 30_000);

    it('keep the program up while Hornhoof does not have them', async () => {
      await start();
      const key = randomUUID();
      const { jobId } = await finished(key);
      await opened(key, 'words nobody keeps');
      await sleep(100);
      await host.release(key, jobId);
      await until(() => lefts().length > 1);
      expect(await tmux.alive(nameOf(key))).toBe(true);
    }, 30_000);
  });

  describe('A to B and back to A', () => {
    it('keeps the program when the agent is back before its turn ended, and the next turn goes on in it', async () => {
      await start();
      const key = randomUUID();
      const { sessionId } = await finished(key);
      const pid = await tmux.programPid(nameOf(key));
      const instance = host.instanceOf(key);
      const leaving = randomUUID();
      const turn = host.run(job(key, 'SLOW work', { jobId: leaving, sessionId }));
      await until(() => host['agents'].get(key)?.busy === true);
      await host.release(key, leaving);
      const back = randomUUID();
      const next = host.run(job(key, 'second', { jobId: back, sessionId }));
      await expect(turn).resolves.toMatchObject({ ok: true });
      await expect(next).resolves.toMatchObject({ ok: true });
      await sleep(400);
      expect(await tmux.programPid(nameOf(key))).toBe(pid);
      expect(host.instanceOf(key)).toBe(instance);
    }, 30_000);

    it('closes the old program and starts one, which no late or repeated word closes', async () => {
      await start();
      const key = randomUUID();
      const { jobId, sessionId } = await finished(key);
      const old = host.instanceOf(key);
      await host.release(key, jobId);
      await gone(key);
      await finished(key, 'second', { sessionId });
      const pid = await tmux.programPid(nameOf(key));
      expect(host.instanceOf(key)).not.toBe(old);
      await host.release(key, jobId);
      await sleep(400);
      expect(await tmux.programPid(nameOf(key))).toBe(pid);
    }, 30_000);

    it('ignores a late word about a turn before the one this program ran since', async () => {
      await start();
      const key = randomUUID();
      const { jobId, sessionId } = await finished(key);
      const pid = await tmux.programPid(nameOf(key));
      await finished(key, 'second', { sessionId });
      expect(await tmux.programPid(nameOf(key))).toBe(pid);
      await host.release(key, jobId);
      await sleep(400);
      expect(await tmux.programPid(nameOf(key))).toBe(pid);
    }, 30_000);

    it('holds one program at a time however often the agent moves', async () => {
      await start();
      const key = randomUUID();
      let session: string | null = null;
      for (let round = 0; round < 3; round++) {
        const { jobId, sessionId } = await finished(key, `round ${round}`, { sessionId: session });
        session = sessionId;
        await host.release(key, jobId);
        await gone(key);
        expect((await tmux.run(['list-sessions', '-F', '#{session_name}']).catch(() => '')).trim()).toBe('');
      }
    }, 45_000);
  });

  it('keeps a restart of the same plan as it is, and a new model starts in the same session', async () => {
    await start();
    const key = randomUUID();
    const { sessionId } = await finished(key);
    const pid = await tmux.programPid(nameOf(key));
    await finished(key, 'second', { sessionId, model: 'claude-opus-5-5' });
    expect(await tmux.programPid(nameOf(key))).not.toBe(pid);
    expect(await tmux.alive(nameOf(key))).toBe(true);
  }, 30_000);
});

describe.skipIf(!hasTmux)('retiring the idle program of a workspace', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await host.stop();
  });

  it('names a new instance for each program start, and none before one', async () => {
    await start();
    const key = randomUUID();
    expect(host.instanceOf(key)).toBeNull();
    const { sessionId } = await finished(key);
    const first = host.instanceOf(key);
    expect(first).toEqual(expect.any(String));
    await finished(key, 'second', { sessionId });
    expect(host.instanceOf(key)).toBe(first);
    await finished(key, 'third', { sessionId, model: 'claude-opus-5-5' });
    expect(host.instanceOf(key)).not.toBe(first);
  }, 30_000);

  it('retires exactly that program, and proves it gone', async () => {
    await start();
    const key = randomUUID();
    const request = await boundProgram(key);
    await expect(host.retireIdleWorkspace(request)).resolves.toEqual({ status: 'retired', instanceGone: true });
    expect(await tmux.has(nameOf(key))).toBe(false);
    expect(host.instanceOf(key)).toBeNull();
  }, 30_000);

  it('answers a repeat of the same request as before, and leaves a new program alone', async () => {
    await start();
    const key = randomUUID();
    const request = await boundProgram(key);
    await host.retireIdleWorkspace(request);
    const again = await boundProgram(key);
    const pid = await tmux.programPid(nameOf(key));
    await expect(host.retireIdleWorkspace(request)).resolves.toEqual({ status: 'retired', instanceGone: true });
    expect(await tmux.programPid(nameOf(key))).toBe(pid);
    expect(host.instanceOf(key)).toBe(again.expectedInstance);
  }, 30_000);

  it.each(['expectedInstance', 'expectedJobId', 'workspaceId', 'bindingVersion'] as const)('calls a request stale when %s differs', async field => {
    await start();
    const key = randomUUID();
    const request = await boundProgram(key);
    const wrong = { ...request, [field]: field === 'bindingVersion' ? 2 : randomUUID() };
    const pid = await tmux.programPid(nameOf(key));
    await expect(host.retireIdleWorkspace(wrong)).resolves.toMatchObject({ status: 'stale', instanceGone: false });
    expect(await tmux.programPid(nameOf(key))).toBe(pid);
    await host.retireIdleWorkspace(request);
    await expect(host.retireIdleWorkspace(wrong)).resolves.toMatchObject({ status: 'stale', instanceGone: false });
  }, 30_000);

  it('calls a request stale for an unknown agent, and for a program with no workspace', async () => {
    await start();
    const key = randomUUID();
    const { jobId } = await finished(key);
    const instance = host.instanceOf(key)!;
    const request = { agentKey: key, expectedInstance: instance, expectedJobId: jobId, workspaceId: randomUUID(), bindingVersion: 1 };
    await expect(host.retireIdleWorkspace(request)).resolves.toMatchObject({ status: 'stale', instanceGone: false });
    await expect(host.retireIdleWorkspace({ ...request, agentKey: randomUUID() })).resolves.toMatchObject({ status: 'stale', instanceGone: false });
    expect(await tmux.alive(nameOf(key))).toBe(true);
  }, 30_000);

  it('answers busy at once while a turn runs or waits, and the turn goes on', async () => {
    await start();
    const key = randomUUID();
    const request = await boundProgram(key);
    const keys = vi.spyOn(tmux, 'keys');
    const started = Date.now();
    const jobId = randomUUID();
    const turn = host.run(job(key, 'SLOW work', { jobId, sessionId: host['agents'].get(key)!.sessionId }));
    await expect(host.retireIdleWorkspace(request)).resolves.toMatchObject({ status: 'busy', instanceGone: false });
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(turn).resolves.toMatchObject({ ok: true });
    expect(keys.mock.calls.flat()).not.toContain('Escape');
    await expect(host.retireIdleWorkspace(request)).resolves.toMatchObject({ status: 'stale', instanceGone: false });
    expect(await tmux.alive(nameOf(key))).toBe(true);
  }, 30_000);

  it('answers busy for words Hornhoof does not have, and retires once it has them', async () => {
    await start();
    const key = randomUUID();
    const request = await boundProgram(key);
    await host.open({ type: 'term.open', termId: 'view', agentKey: key, cols: 120, rows: 40, write: true });
    host.input({ type: 'term.input', termId: 'view', data: 'unkept words' });
    await until(async () => (await tmux.screen(nameOf(key), 0)).includes('unkept words'));
    await sleep(100);
    await expect(host.retireIdleWorkspace(request)).resolves.toMatchObject({ status: 'busy', instanceGone: false });
    expect(await tmux.alive(nameOf(key))).toBe(true);
    const left = sent.find((m): m is Left => m.type === 'agent.input_left')!;
    host.inputKept({ type: 'agent.input_kept', agentKey: key, ref: left.ref });
    await expect(host.retireIdleWorkspace(request)).resolves.toEqual({ status: 'retired', instanceGone: true });
  }, 30_000);

  it('answers busy when the session could not be proved gone', async () => {
    await start();
    const key = randomUUID();
    const request = await boundProgram(key);
    vi.spyOn(tmux, 'kill').mockResolvedValue(undefined);
    await expect(host.retireIdleWorkspace(request)).resolves.toMatchObject({ status: 'busy', instanceGone: false });
    expect(host.instanceOf(key)).toBe(request.expectedInstance);
  }, 30_000);

  it('never throws: a tmux that fails is busy', async () => {
    await start();
    const key = randomUUID();
    const request = await boundProgram(key);
    vi.spyOn(tmux, 'kill').mockRejectedValue(new Error('no tmux'));
    await expect(host.retireIdleWorkspace(request)).resolves.toMatchObject({ status: 'busy', instanceGone: false });
  }, 30_000);

  it('answers busy for a turn sent while it waits for the words to be kept, and the turn goes on in that program', async () => {
    await start();
    const key = randomUUID();
    const request = await boundProgram(key);
    const { sessionId } = host['agents'].get(key)!;
    await host.open({ type: 'term.open', termId: 'view', agentKey: key, cols: 120, rows: 40, write: true });
    host.input({ type: 'term.input', termId: 'view', data: 'some words' });
    await until(async () => (await tmux.screen(nameOf(key), 0)).includes('some words'));
    await sleep(100);
    const retiring = host.retireIdleWorkspace(request);
    await until(() => sent.some(m => m.type === 'agent.input_left'));
    const turn = host.run(job(key, 'next', { jobId: randomUUID(), sessionId }));
    const left = () => sent.filter((m): m is Left => m.type === 'agent.input_left');
    const toRetire = left()[0]!.ref;
    host.inputKept({ type: 'agent.input_kept', agentKey: key, ref: toRetire });
    await expect(retiring).resolves.toMatchObject({ status: 'busy', instanceGone: false });
    /* The turn keeps these words under its own name before it takes them from the input. */
    await until(() => left().some(m => m.ref !== toRetire));
    host.inputKept({ type: 'agent.input_kept', agentKey: key, ref: left().at(-1)!.ref });
    await expect(turn).resolves.toMatchObject({ ok: true });
    expect(host.instanceOf(key)).toBe(request.expectedInstance);
  }, 30_000);

  it('lets a turn sent while the session closes start its own program after it', async () => {
    await start();
    const key = randomUUID();
    const request = await boundProgram(key);
    const kill = tmux.kill.bind(tmux);
    let closing!: () => void;
    const reached = new Promise<void>(done => (closing = done));
    vi.spyOn(tmux, 'kill').mockImplementation(async name => {
      closing();
      await sleep(200);
      await kill(name);
    });
    const retiring = host.retireIdleWorkspace(request);
    await reached;
    const turn = host.run(job(key, 'next', { jobId: randomUUID() }));
    await expect(retiring).resolves.toEqual({ status: 'retired', instanceGone: true });
    await expect(turn).resolves.toMatchObject({ ok: true });
    expect(host.instanceOf(key)).not.toBe(request.expectedInstance);
    expect(await tmux.alive(nameOf(key))).toBe(true);
  }, 30_000);

  it('goes A to B to A with the real retirement: the first program gone, one program on A after, the same request no threat to it', async () => {
    await start();
    const key = randomUUID();
    const onA = await boundProgram(key);
    const pidOnA = await tmux.programPid(nameOf(key));
    await expect(host.retireIdleWorkspace(onA)).resolves.toEqual({ status: 'retired', instanceGone: true });
    expect(await tmux.has(nameOf(key))).toBe(false);
    const backOnA = await boundProgram(key);
    const pidBack = await tmux.programPid(nameOf(key));
    expect(pidBack).not.toBe(pidOnA);
    expect(backOnA.expectedInstance).not.toBe(onA.expectedInstance);
    await expect(host.retireIdleWorkspace(onA)).resolves.toEqual({ status: 'retired', instanceGone: true });
    expect(await tmux.programPid(nameOf(key))).toBe(pidBack);
    await expect(host.retireIdleWorkspace(backOnA)).resolves.toEqual({ status: 'retired', instanceGone: true });
    expect(await tmux.has(nameOf(key))).toBe(false);
  }, 45_000);
});
