import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ownFs, type AgentFs } from '../src/agent-fs.js';
import { claudeProgram } from '../src/terminal/programs.js';
import { FAKE, SECRET, hasTmux, host, tmux, home, setUp, job } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  afterEach(async () => host?.stop());

  it('runs a turn in the agent session: pastes the prompt, shows what it does and ends with its answer and limits', async () => {
    await setUp();
    const j = job('a1', 'hello there');
    const res = await host.run(j);
    expect(res).toMatchObject({ ok: true, result: 'echo: hello there', error: null });
    expect(res.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.limits?.windows[0]).toMatchObject({ name: 'five_hour', utilization: 0.4 });
    expect(j.events).toEqual([{ kind: 'text', text: 'echo: hello there' }]);
  });

  it("starts the agent's program as the agents' user on a root node, and writes what it needs through their file helper", async () => {
    const bin = mkdtempSync(join(tmpdir(), 'hh-setpriv-'));
    const seen = join(bin, 'seen');
    writeFileSync(join(bin, 'setpriv'), `#!/bin/sh\necho "$@" > ${seen}\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`, { mode: 0o755 });
    const done: string[] = [];
    const fs: AgentFs = {
      mkdir: path => (done.push(`mkdir ${path}`), ownFs.mkdir(path)),
      read: path => (done.push(`read ${path}`), ownFs.read(path)),
      write: (path, data) => (done.push(`write ${path}`), ownFs.write(path, data)),
      stop() {},
    };
    await setUp({ user: { uid: 4242, gid: 4343 }, fs }, `${bin}:${process.env.PATH ?? ''}`);
    const j = job('as-agent', 'hello there');
    expect(await host.run(j)).toMatchObject({ ok: true, result: 'echo: hello there' });
    expect(readFileSync(seen, 'utf8')).toMatch(new RegExp(`^--reuid=4242 --regid=4343 --init-groups -- ${FAKE}`));
    expect(done).toEqual(expect.arrayContaining([`mkdir ${j.input.workDir}`, `write ${join(j.input.workDir, '.hh-instructions.md')}`, `read ${join(home, '.claude.json')}`, `read ${join(home, 'settings.json')}`]));
    expect(readdirSync(j.input.workDir).filter(name => name.startsWith('.hh-env-') || name.startsWith('.hh-output-'))).toEqual([]);
  });

  it('hands Claude Code the plugins the node has, such as superpowers', async () => {
    await setUp({ plugins: ['/opt/hornhoof/superpowers'] });
    const given: (string[] | undefined)[] = [];
    const j = job('a-plug', 'hello');
    const result = await host.run({ ...j, program: { ...claudeProgram, launch: input => (given.push(input.plugins), claudeProgram.launch(input)) } });
    expect(result.ok).toBe(true);
    expect(given).toEqual([['/opt/hornhoof/superpowers']]);
  });

  it('presses Enter again when the program did not take the prompt, as Claude Code that just started can miss it', async () => {
    await setUp({ enterWaitMs: 300 });
    const res = await host.run(job('a1', 'hello there', { timeoutMs: 4000, env: { FAKE_SECRET: SECRET, FAKE_LOSE_ENTER: '1' } }));
    expect(res).toMatchObject({ ok: true, result: 'echo: hello there' });
  });

  it("keeps a turn's answer with its turn when the program logs it after saying the turn ended", async () => {
    await setUp();
    const first = job('a12', 'LAG one');
    const done = await host.run(first);
    expect(done).toMatchObject({ ok: true, result: 'echo: LAG one' });
    expect(first.events).toEqual([{ kind: 'text', text: 'echo: LAG one' }]);
    const second = job('a12', 'two', { sessionId: done.sessionId });
    await host.run(second);
    expect(second.events).toEqual([{ kind: 'text', text: 'echo: two' }]);
  });

  it('goes on in the same live program for the next turn, and resumes the session once the program ended', async () => {
    await setUp();
    const first = await host.run(job('a2', 'one'));
    const second = await host.run(job('a2', 'two', { sessionId: first.sessionId }));
    expect(second).toMatchObject({ ok: true, result: 'echo: two', sessionId: first.sessionId });
    expect((await host.screen('a2')).match(/fake claude new/g)).toHaveLength(1);

    const ended = await host.run(job('a2', 'EXIT', { sessionId: first.sessionId }));
    expect(ended).toMatchObject({ ok: false, error: 'agent_failed' });
    const third = await host.run(job('a2', 'three', { sessionId: first.sessionId }));
    expect(third).toMatchObject({ ok: true, result: 'echo: three' });
    expect(await host.screen('a2')).toContain(`fake claude resumed ${first.sessionId}`);
  });

  it('takes the next turn at once when the program ended the last one before its Enter came back, as on a busy machine', async () => {
    await setUp();
    const keys = tmux.keys.bind(tmux);
    /* tmux answers late: the program takes the prompt and ends its turn before the key is back. */
    tmux.keys = async (name, ...pressed) => {
      await keys(name, ...pressed);
      if (pressed.includes('Enter')) await new Promise(r => setTimeout(r, 500));
    };
    const first = await host.run(job('a17', 'one'));
    expect(first).toMatchObject({ ok: true, result: 'echo: one' });
    const next = host.run(job('a17', 'two', { sessionId: first.sessionId }));
    const late = new Promise(r => setTimeout(() => r('still waiting'), 5000));
    expect(await Promise.race([next, late])).toMatchObject({ ok: true, result: 'echo: two' });
  });

  it('starts the program again in the same session when the agent was set to think harder', async () => {
    await setUp();
    const first = await host.run(job('a50', 'one', { effort: 'low' }));
    const second = await host.run(job('a50', 'two', { sessionId: first.sessionId, effort: 'max' }));
    expect(second).toMatchObject({ ok: true, result: 'echo: two', sessionId: first.sessionId });
    expect(await host.screen('a50')).toContain(`fake claude resumed ${first.sessionId}`);
  });

  it('starts a new session when Hornhoof asks for one', async () => {
    await setUp();
    const first = await host.run(job('a3', 'one'));
    const fresh = await host.run(job('a3', 'two', { sessionId: null }));
    expect(fresh.ok).toBe(true);
    expect(fresh.sessionId).not.toBe(first.sessionId);
  });

  it('stops a turn Hornhoof calls off', async () => {
    await setUp();
    await host.run(job('a4', 'warm up'));
    const stop = new AbortController();
    const running = host.run(job('a4', 'SLOW', { signal: stop.signal }));
    setTimeout(() => stop.abort(), 300);
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
  });
});
