import type { NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobDone } from '../src/runner.js';
import { cleanups, liveTerminal } from './terminal-host-live-helpers.js';
import { SECRET } from './terminal-host-helpers.js';

/* What a node shows of a program never carries a known secret, and only a person who may type types into it. tmux and the
   program never run: the test writes what they would show, and checks what our side makes of it. */
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const pieces = (secret: string) => Array.from({ length: secret.length - 9 }, (_, i) => secret.slice(i, i + 10));
const frames = (sent: NodeMessage[], termId: string) => sent.flatMap(m => (m.type === 'term.data' && m.termId === termId ? [m.data] : [])).join('');
const shows = (text: string, secret = SECRET) => pieces(secret).some(piece => text.includes(piece));

describe('a view of an agent at work', () => {
  it('hides a token learned after the view opened, without another turn', async () => {
    const secrets: string[] = [];
    const t = await liveTerminal('claude', 'queued', { secrets });
    await t.on(t.host.open({ type: 'term.open', termId: 'renewed', agentKey: 'receipt', cols: 100, rows: 30, write: true }));
    const [{ view }] = t.views;
    secrets.push(SECRET);
    view.stdout.write(`renewed ${SECRET} here\n`);
    await t.until(() => frames(t.sent, 'renewed').includes('here'));
    expect(frames(t.sent, 'renewed')).toContain('renewed [hidden] here');
    expect(shows(frames(t.sent, 'renewed'))).toBe(false);
  });

  it('shows people the live screen without a known secret, even one that comes in two pieces', async () => {
    const t = await liveTerminal('claude', 'queued', { secrets: [SECRET] });
    await t.on(t.host.open({ type: 'term.open', termId: 'v1', agentKey: 'receipt', cols: 100, rows: 30, write: true }));
    const [{ view }] = t.views;
    view.stdout.write(`the key is ${SECRET.slice(0, 7)}`);
    view.stdout.write(`${SECRET.slice(7)} and more\r\n`);
    await t.until(() => frames(t.sent, 'v1').includes('and more'));
    expect(shows(frames(t.sent, 'v1'))).toBe(false);
    expect(frames(t.sent, 'v1')).toContain('the key is ');
  });

  it('gives the history first without a known secret', async () => {
    const t = await liveTerminal('claude', 'queued', { secrets: [SECRET] });
    /* tmux's answer to the view's look at the history, the rows it saved and the pane, told apart by the mark it was given. */
    vi.mocked(t.tmux.run).mockImplementation(async args => {
      if (args[0] !== 'capture-pane' || !args.includes('-E')) return '';
      const mark = args[args.indexOf(';') + 3]!;
      return `first ${SECRET} words\nsecond line\n${mark}\n${mark}\n5 50000 80 24 0 3 7\n`;
    });
    await t.on(t.host.open({ type: 'term.open', termId: 'v2', agentKey: 'receipt', cols: 80, rows: 24, write: false }));
    await t.until(() => frames(t.sent, 'v2').includes('second line'));
    expect(frames(t.sent, 'v2')).toContain('first ');
    expect(shows(frames(t.sent, 'v2'))).toBe(false);
  });

  it('gives a watcher who may not type a read-only view, and takes none of its keys', async () => {
    const t = await liveTerminal('claude', 'queued');
    await t.on(t.host.open({ type: 'term.open', termId: 'v3', agentKey: 'receipt', cols: 80, rows: 24, write: false }));
    expect(t.attach).toHaveBeenCalledWith(expect.any(String), expect.any(Number), expect.any(Number), false);
    t.host.input({ type: 'term.input', termId: 'v3', data: 'sneaky\r' });
    await t.pass(100);
    expect(t.views[0]!.view.typed()).toBe('');
    expect(t.paste).not.toHaveBeenCalled();
    expect(t.keys).not.toHaveBeenCalled();
    expect(t.sent.some(m => m.type === 'turn.open')).toBe(false);
  });

  it('passes what a person who may type types to the program', async () => {
    const t = await liveTerminal('claude', 'queued');
    await t.on(t.host.open({ type: 'term.open', termId: 'v4', agentKey: 'receipt', cols: 80, rows: 24, write: true }));
    expect(t.attach).toHaveBeenCalledWith(expect.any(String), expect.any(Number), expect.any(Number), true);
    t.host.input({ type: 'term.input', termId: 'v4', data: 'typed by Alex' });
    await t.until(() => t.views[0]!.view.typed() === 'typed by Alex');
  });
});

describe('what a turn tells Hornhoof', () => {
  it.each([false, true])('keeps the retained terminal tail private in a later typed turn, completed: %s', async completed => {
    const marker = 'retained-tail-marker-1178';
    const t = await liveTerminal('claude', 'queued');
    t.record({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'secret-call', name: 'mcp__hornhoof__vault_save', input: { password: marker } }] } });
    await t.until(() => t.host['agents'].get('receipt')?.turn?.privacy?.sensitive === true);
    t.finish('Ready.');
    await t.on(t.running);
    const prompted = t.hook('prompt', { prompt: 'Next request.' });
    await t.until(() => t.sent.some(m => m.type === 'turn.open'));
    const opened = t.sent.find((m): m is Extract<NodeMessage, { type: 'turn.open' }> => m.type === 'turn.open')!;
    t.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'typed-after-secret', toolToken: 'typed-token', ref: opened.ref });
    await t.on(prompted);
    if (completed) t.finish('Follow-up delivered.');
    else t.ends(`retained pane ${marker}`, 3);
    await t.until(() => t.sent.some(m => m.type === 'job.done' && m.jobId === 'typed-after-secret'));
    const done = t.sent.find((m): m is Extract<NodeMessage, { type: 'job.done' }> => m.type === 'job.done' && m.jobId === 'typed-after-secret')!;
    expect(done.tail).not.toContain(marker);
    expect(done.tail).toMatch(/hidden/i);
    if (completed) expect(done.result).toBe('Follow-up delivered.');
  });

  it('shows a clean screen after the sensitive program and its tmux session were removed', async () => {
    const t = await liveTerminal('claude', 'queued');
    t.record({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'secret-call', name: 'mcp__hornhoof__vault_save', input: { password: 'private-screen-marker' } }] } });
    await t.until(() => t.host['agents'].get('receipt')?.turn?.privacy?.sensitive === true);
    t.finish('Ready.');
    await t.on(t.running);
    vi.mocked(t.tmux.has).mockResolvedValue(false);
    await t.on(t.host['closeProgram'](t.host['agents'].get('receipt')!));
    vi.mocked(t.tmux.has).mockResolvedValue(true);
    await t.on(t.host.open({ type: 'term.open', termId: 'clean-view', agentKey: 'receipt', cols: 100, rows: 30, write: true }));
    t.views[0]!.view.stdout.write('Clean restarted screen.\n');
    await t.until(() => frames(t.sent, 'clean-view').includes('Clean restarted screen.'));
  });

  it('hides a sensitive tool transcript and its raw terminal completion', async () => {
    const marker = 'private-terminal-marker-1178';
    const t = await liveTerminal('claude', 'queued');
    t.record({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'vault-call', name: 'mcp__hornhoof__vault_save', input: { password: marker } }] } });
    t.record({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'vault-call', content: marker }] } });
    await t.until(() => t.host['agents'].get('receipt')?.turn?.privacy?.sensitive === true);
    t.ends(`raw transcript ${marker}`, 3);
    const result = await t.on(t.running);
    expect(result.sensitive).toBe(true);
    const done = jobDone('job-receipt', result, []);
    expect(JSON.stringify(t.sent)).not.toContain(marker);
    expect(JSON.stringify(done)).not.toContain(marker);
    expect(done.tail).toMatch(/hidden/i);
  });

  it('hides a multiline secret before clipping a typed turn that ended before its acknowledgement', async () => {
    const secret = 'multiline-private-token\nprivate-suffix-0123456789';
    const t = await liveTerminal('claude', 'queued', { prompt: '', openMs: 15_000, secrets: [secret] });
    const prompted = t.hook('prompt', { prompt: 'typed request' });
    await t.until(() => t.sent.some(m => m.type === 'turn.open'));
    const opened = t.sent.find((m): m is Extract<NodeMessage, { type: 'turn.open' }> => m.type === 'turn.open')!;
    const lines = Array.from({ length: 49 }, (_, i) => `ordinary-${i}`);
    t.ends(`${secret}\n${lines.join('\n')}\n`, 3);
    await t.until(() => t.host['agents'].get('receipt')?.turn === null);
    expect(t.sent.some(m => m.type === 'job.done' && m.jobId === 'typed-result')).toBe(false);
    t.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'typed-result', toolToken: 'typed-token', ref: opened.ref });
    await t.on(prompted);
    await t.until(() => t.sent.some(m => m.type === 'job.done' && m.jobId === 'typed-result'));
    const done = t.sent.find((m): m is Extract<NodeMessage, { type: 'job.done' }> => m.type === 'job.done' && m.jobId === 'typed-result')!;
    expect(done).toMatchObject({ ok: false, error: 'agent_failed', exit: { code: 3, signal: null } });
    expect(done.tail).not.toContain(secret.split('\n')[1]);
    expect(done.tail).toContain('[hidden]');
    expect(done.tail.split('\n').filter(line => line.startsWith('ordinary-'))).toHaveLength(49);
    expect(Buffer.byteLength(done.tail)).toBeLessThanOrEqual(4096);
    expect(done.tail.split('\n').at(-1)).toMatch(/^Program ended: code 3, signal none, at /);
  });

  it('hides a known secret in what a program said as it ended during a turn', async () => {
    const t = await liveTerminal('claude', 'queued', { secrets: [SECRET] });
    t.ends(`boom ${SECRET}\n`, 3);
    const result = await t.on(t.running);
    expect(result).toMatchObject({ ok: false, error: 'agent_failed' });
    /* The node tells Hornhoof the turn's end with the secrets of its job, as it does for every job. */
    const done = jobDone('job-receipt', result, [SECRET]);
    expect(shows(JSON.stringify(done))).toBe(false);
    expect(done.tail).toContain('boom [hidden]');
    expect(done.tail.split('\n').at(-1)).toMatch(/^Program ended: code 3, signal none, at /);
  });

  it.each([
    [`mcp__fixture__${SECRET}`, 'fixture.[hidden]'],
    ['x'.repeat(90) + SECRET, 'x'.repeat(90) + '[hidden]'],
  ])('hides a known secret in the name of a tool the program calls, %s, before it clips it', async (name, hidden) => {
    const t = await liveTerminal('claude', 'queued', { secrets: [SECRET], host: { lookMs: 20, reportMs: 40 } });
    t.record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'private-tool', name, input: {} }] } });
    const reports = () => t.sent.filter((m): m is Extract<NodeMessage, { type: 'job.program' }> => m.type === 'job.program');
    await t.until(() => reports().some(m => m.state === 'tool'));
    expect(reports().find(m => m.state === 'tool')?.tool).toBe(hidden);
    expect(shows(JSON.stringify(reports()))).toBe(false);
  });

  it('never lets a known secret into the words of a person it keeps for them', async () => {
    const t = await liveTerminal('claude', 'queued', { secrets: [SECRET], host: { typingQuietMs: 50 } });
    t.finish();
    await t.on(t.running);
    await t.on(t.host.open({ type: 'term.open', termId: 'v5', agentKey: 'receipt', cols: 120, rows: 40, write: true }));
    t.host.input({ type: 'term.input', termId: 'v5', data: `token ${SECRET} here` });
    t.draft(`token ${SECRET} here`);
    const next = t.run('Next assignment.', 'job-next');
    const lefts = () => t.sent.filter((m): m is Extract<NodeMessage, { type: 'agent.input_left' }> => m.type === 'agent.input_left');
    await t.until(() => lefts().length > 0);
    expect(lefts()[0]!.text).toContain('here');
    expect(shows(lefts()[0]!.text)).toBe(false);
    t.host.inputKept({ type: 'agent.input_kept', agentKey: 'receipt', ref: lefts()[0]!.ref });
    await t.until(() => t.submitted.includes('Next assignment.'));
    t.finish();
    expect(await t.on(next)).toMatchObject({ ok: true });
  });
});
