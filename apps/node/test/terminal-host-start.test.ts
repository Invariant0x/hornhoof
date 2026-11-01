import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET, hasTmux, until, host, tmux, sent, home, setUp, job, codexJob, done, ack, typeTurn, withTools } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  afterEach(async () => host?.stop());

  it('keeps the turn that starts a program going until the program has its tools', () =>
    withTools(async auths => {
      /* The program connects to its tools a while after it is ready to take a prompt, as Codex and Claude Code do. */
      expect(await host.run(job('a42', '', { env: { FAKE_SECRET: SECRET, FAKE_MCP_LIST_MS: '700' } }))).toMatchObject({ ok: true });
      await until(async () => (await host.screen('a42')).includes('tools:'));
      expect(await host.screen('a42')).toContain('tools: ok');
      expect(auths).toEqual(['Bearer tok-turn']);
    }));

  it('gives a person who types while their program starts a turn of their own, once the program has its tools', () =>
    withTools(async auths => {
      const starting = host.run(job('a43', '', { env: { FAKE_SECRET: SECRET, FAKE_MCP_LIST_MS: '700' } }));
      await until(async () => (await host.screen('a43')).includes('fake claude new'));
      await host.open({ type: 'term.open', termId: 't43', agentKey: 'a43', cols: 80, rows: 24, write: true });
      host.input({ type: 'term.input', termId: 't43', data: 'hello\r' });
      await until(() => sent.some(m => m.type === 'turn.open' && m.agentKey === 'a43'));
      /* Hornhoof hears of the person's turn only once the start turn's token got the program its tools. */
      expect(auths).toEqual(['Bearer tok-turn']);
      expect(await starting).toMatchObject({ ok: true, sessionId: null });
      ack('a43', 'job-43');
      await until(() => Boolean(done('job-43')));
      expect(done('job-43')).toMatchObject({ ok: true, result: 'echo: hello' });
    }));

  it('gives a person who types into Codex while it starts a turn of their own', async () => {
    await setUp({ toolsMs: 1500 });
    const starting = host.run(codexJob('c43', ''));
    await until(async () => (await host.screen('c43')).includes('›'));
    await host.open({ type: 'term.open', termId: 'v43', agentKey: 'c43', cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId: 'v43', data: 'hello' });
    await new Promise(r => setTimeout(r, 200));
    host.input({ type: 'term.input', termId: 'v43', data: '\r' });
    await until(() => sent.some(m => m.type === 'turn.open' && m.agentKey === 'c43'));
    expect(await starting).toMatchObject({ ok: true });
    ack('c43', 'job-c43');
    await until(() => Boolean(done('job-c43')));
    expect(done('job-c43')).toMatchObject({ ok: true, result: 'echo: hello' });
  });

  it('remembers the session a person started by typing into a program started for them', async () => {
    const remembered: [string, string][] = [];
    await setUp({ remember: (sessionId, workDir) => remembered.push([sessionId, workDir]) });
    await host.run(job('a40', ''));
    await typeTurn('a40', 't40', 'hello', 'job-40');
    await until(() => Boolean(done('job-40')));
    const { sessionId } = done('job-40') as { sessionId: string };
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(remembered).toContainEqual([sessionId, join(home, 'work', 'a40')]);
  });

  it('gives a program started fresh the conversation from before, without counting it as new instructions', async () => {
    await setUp();
    await host.run(job('a41', '', { context: 'Earlier: Ivan said we sell software.' }));
    const file = readFileSync(join(home, 'work', 'a41', '.hh-instructions.md'), 'utf8');
    expect(file).toContain('Be brief.');
    expect(file).toContain('we sell software');
    expect(await host.run(job('a41', 'hello', { sessionId: null }))).toMatchObject({ ok: true, result: 'echo: hello' });
    expect((await host.screen('a41')).match(/fake claude new/g)).toHaveLength(1);
  });

  it('gives a Claude session it resumes the conversation from before that the session was started with', async () => {
    await setUp();
    await host.run(job('a44', '', { context: 'Earlier: Ivan said we sell software.', guidance: 'Your repository is ./shop.' }));
    expect(readFileSync(join(home, 'work', 'a44', '.hh-instructions.md'), 'utf8')).toContain('./shop');
    await typeTurn('a44', 't44', 'hello', 'job-44');
    await until(() => Boolean(done('job-44')));
    const { sessionId } = done('job-44') as { sessionId: string };
    await host.run(job('a44', 'EXIT', { sessionId }));
    /* Hornhoof goes on with the session and sends nothing from before: Claude Code's log has only what was said in it.
       Where the repository is comes fresh with each start, as it can change. */
    expect(await host.run(job('a44', '', { sessionId, guidance: 'Your repository is ./platform.' }))).toMatchObject({ ok: true });
    expect(await host.screen('a44')).toContain(`fake claude resumed ${sessionId}`);
    const told = readFileSync(join(home, 'work', 'a44', '.hh-instructions.md'), 'utf8');
    expect(told).toContain('we sell software');
    expect(told).toContain('./platform');
    expect(told).not.toContain('./shop');
  });

  it('tells Hornhoof of turns typed while the program starts one by one, in order, each after the last one ended', async () => {
    await setUp({ toolsMs: 1500 });
    const starting = host.run(codexJob('c46', ''));
    await until(async () => (await host.screen('c46')).includes('›'));
    await host.open({ type: 'term.open', termId: 'v46', agentKey: 'c46', cols: 80, rows: 24, write: true });
    for (const line of ['first', 'second']) {
      host.input({ type: 'term.input', termId: 'v46', data: line });
      await new Promise(r => setTimeout(r, 200));
      host.input({ type: 'term.input', termId: 'v46', data: '\r' });
      await until(async () => (await host.screen('c46')).includes(`echo: ${line}`));
    }
    await starting;
    const opens = () => sent.flatMap(m => (m.type === 'turn.open' ? [m.text] : []));
    await until(() => opens().length === 1);
    await new Promise(r => setTimeout(r, 300));
    /* Hornhoof takes a typed turn only when none runs: the second waits until the first is answered and over. */
    expect(opens()).toEqual(['first']);
    ack('c46', 'job-46a', 0);
    await until(() => opens().length === 2);
    expect(opens()).toEqual(['first', 'second']);
    const at = (found: (m: NodeMessage) => boolean) => sent.findIndex(found);
    expect(at(m => m.type === 'job.done' && m.jobId === 'job-46a')).toBeLessThan(at(m => m.type === 'turn.open' && m.text === 'second'));
    ack('c46', 'job-46b', 1);
    await until(() => Boolean(done('job-46b')));
    expect(done('job-46b')).toMatchObject({ ok: true, result: 'echo: second' });
  });

  it('starts the program in place of the waiting screen shown after its session was gone', async () => {
    await setUp();
    const first = await host.run(job('a45', 'hello'));
    await tmux.kill('a-a45');
    await host.open({ type: 'term.open', termId: 't45', agentKey: 'a45', cols: 80, rows: 24, write: true });
    expect(sent).toContainEqual({ type: 'agent.start', agentKey: 'a45' });
    expect(await host.run(job('a45', '', { sessionId: first.sessionId }))).toMatchObject({ ok: true, sessionId: first.sessionId });
    expect(await host.screen('a45')).toContain(`fake claude resumed ${first.sessionId}`);
  });

  it('resumes the session for a turn with nothing to type', async () => {
    await setUp();
    const first = await host.run(job('a34', 'one'));
    await host.run(job('a34', 'EXIT', { sessionId: first.sessionId }));
    const start = await host.run(job('a34', '', { sessionId: first.sessionId }));
    expect(start).toMatchObject({ ok: true, sessionId: first.sessionId });
    expect(await host.screen('a34')).toContain(`fake claude resumed ${first.sessionId}`);
  });
});
