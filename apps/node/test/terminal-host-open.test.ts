import { afterEach, describe, expect, it } from 'vitest';
import { hasTmux, until, host, tmux, sent, setUp, job } from './terminal-host-helpers.js';

const sizes = async () => (await tmux.clients()).map(c => `${c.cols}x${c.rows}`).sort();
const windowSize = async (key: string) => (await tmux.run(['list-windows', '-t', `=a-${key}`, '-F', '#{window_width}x#{window_height}'])).trim();

describe.skipIf(!hasTmux)('opening an agent terminal', () => {
  afterEach(async () => host?.stop());

  it.each([false, true])('opens two windows on one new session and fits both windows (write=%s)', async write => {
    await setUp();
    expect(await tmux.has('a-new')).toBe(false);
    const results = await Promise.allSettled([
      host.open({ type: 'term.open', termId: 'big', agentKey: 'new', cols: 120, rows: 40, write }),
      host.open({ type: 'term.open', termId: 'small', agentKey: 'new', cols: 80, rows: 20, write }),
    ]);
    expect(results).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
    await until(async () => (await sizes()).join() === '80x20,80x20');
    await until(() => ['big', 'small'].every(id => sent.some(m => m.type === 'term.data' && m.termId === id)));
    expect((await tmux.clients()).map(c => c.session).sort()).toEqual(['a-new', 'a-new']);
    expect((await tmux.run(['list-sessions', '-F', '#{session_name}'])).trim()).toBe('a-new');
    expect(await windowSize('new')).toBe('80x20');
    expect(sent.filter(m => m.type === 'term.exit')).toEqual([]);

    host.close({ type: 'term.close', termId: 'small' });
    await until(async () => (await sizes()).join() === '120x40');
    expect(await windowSize('new')).toBe('120x40');
  });

  it('attaches concurrent windows to an existing program without starting it again', async () => {
    await setUp();
    await host.run(job('running', 'hello'));
    const pid = await tmux.programPid('a-running');
    expect(pid).not.toBeNull();
    await Promise.all([
      host.open({ type: 'term.open', termId: 'one', agentKey: 'running', cols: 120, rows: 40, write: false }),
      host.open({ type: 'term.open', termId: 'two', agentKey: 'running', cols: 80, rows: 20, write: false }),
    ]);
    await until(async () => (await sizes()).join() === '80x20,80x20');
    const screen = (id: string) => sent.flatMap(m => m.type === 'term.data' && m.termId === id ? [m.data] : []).join('');
    await until(() => ['one', 'two'].every(id => screen(id).includes('echo: hello')));
    expect(await tmux.programPid('a-running')).toBe(pid);
  });

  it('keeps an early resize of the second window while both wait for a new session', async () => {
    await setUp();
    const opening = Promise.all([
      host.open({ type: 'term.open', termId: 'big', agentKey: 'early', cols: 120, rows: 40, write: false }),
      host.open({ type: 'term.open', termId: 'small', agentKey: 'early', cols: 80, rows: 20, write: false }),
    ]);
    await host.resize({ type: 'term.resize', termId: 'small', cols: 70, rows: 13 });
    await opening;
    await until(async () => (await sizes()).join() === '70x13,70x13');
    expect(await windowSize('early')).toBe('70x13');
  });

  it('leaves only the first window when the second closes before their session is created', async () => {
    await setUp();
    const opening = Promise.all([
      host.open({ type: 'term.open', termId: 'stay', agentKey: 'closed', cols: 120, rows: 40, write: false }),
      host.open({ type: 'term.open', termId: 'gone', agentKey: 'closed', cols: 80, rows: 20, write: false }),
    ]);
    host.close({ type: 'term.close', termId: 'gone' });
    await opening;
    await until(async () => (await sizes()).join() === '120x40');
    expect(await windowSize('closed')).toBe('120x40');
    expect(sent.some(m => m.type === 'term.data' && m.termId === 'gone')).toBe(false);
  });

  it('creates a separate session for each agent when their windows open together', async () => {
    await setUp();
    await Promise.all([
      host.open({ type: 'term.open', termId: 'one', agentKey: 'one', cols: 120, rows: 40, write: false }),
      host.open({ type: 'term.open', termId: 'two', agentKey: 'two', cols: 80, rows: 20, write: false }),
    ]);
    await until(async () => (await tmux.clients()).length === 2);
    expect((await tmux.clients()).map(c => c.session).sort()).toEqual(['a-one', 'a-two']);
    expect(await windowSize('one')).toBe('120x40');
    expect(await windowSize('two')).toBe('80x20');
  });
});
