import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERM_CHUNK } from '@hornhoof/protocol';
import { hasTmux, host, job, sent, SECRET, setUp, tmux, until } from './terminal-host-helpers.js';

const frames = (termId: string) => sent.flatMap(m => (m.type === 'term.data' && m.termId === termId ? [String(m.data)] : []));
const shown = (termId: string) => frames(termId).join('');
/* What a view gave its terminal's history, and the rest of what it sent, in which only tmux draws the screen. */
const INTO_HISTORY = /\x1b\[1;2r\x1b\[1;1H\x1b\[2K\x1b\[2;1H\x1b\[2K\x1b\[1;1H([\s\S]*?)\n\x1b\[r/g;
const pushed = (termId: string) => [...shown(termId).matchAll(INTO_HISTORY)]
  .flatMap(block => block[1]!.split('\r\n').slice(0, -1))
  .map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
const numbered = (termId: string) => pushed(termId).filter(line => line.startsWith('line-'));
const fromOne = (last: number) => Array.from({ length: last }, (_, at) => `line-${at + 1}-end`);
const LINES = (from: number, to: number) => `seq ${from} ${to} | sed 's/.*/line-&-end/'`;

describe.skipIf(!hasTmux)('what a view of a session shows when it opens', () => {
  beforeEach(() => setUp());
  afterEach(async () => {
    vi.restoreAllMocks();
    await host.stop();
  });

  const session = async (key: string) => {
    await host.run(job(key, 'hello', { jobId: `job-${key}` }));
    return host['agents'].get(key)!.name;
  };

  it('gives the history first, styled and masked, and what the program wrote while it was read after it', async () => {
    const name = await session('h1');
    await tmux.run(['respawn-pane', '-k', '-t', name, 'sh', '-c', `${LINES(1, 40)}; sleep 30`]);
    await until(async () => (await tmux.screen(name)).includes('line-40-end'));
    const run = tmux.run.bind(tmux);
    vi.spyOn(tmux, 'run').mockImplementation(async (args, input) => {
      if (!args.includes('-5000')) return run(args, input);
      await run(['send-keys', '-t', name, '-l', 'WRITTEN-WHILE-READ']);
      await until(async () => (await tmux.screen(name)).includes('WRITTEN-WHILE-READ'));
      return `OLD-LINE-0\n\x1b[2mDIM\x1b[0m ${SECRET}\n${await run(args, input)}`;
    });
    await host.open({ type: 'term.open', termId: 't1', agentKey: 'h1', cols: 80, rows: 24, write: false });
    await until(() => shown('t1').includes('WRITTEN-WHILE-READ'));
    expect(frames('t1')[0]).toContain('OLD-LINE-0');
    expect(pushed('t1')[0]).toBe('OLD-LINE-0');
    expect(shown('t1').indexOf('OLD-LINE-0')).toBeLessThan(shown('t1').indexOf('WRITTEN-WHILE-READ'));
    expect(shown('t1')).toContain('\x1b[2mDIM');
    expect(shown('t1')).not.toContain(SECRET);
  });

  it('sends what the program writes at once, in pieces the transport takes', async () => {
    await session('h2');
    await host.open({ type: 'term.open', termId: 't2', agentKey: 'h2', cols: 80, rows: 24, write: false });
    await until(() => frames('t2').length > 0);
    const before = sent.length;
    const view = host['views'].get('t2')!;
    const long = 'x'.repeat(5 * TERM_CHUNK);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      view.out(long);
      const after = sent.slice(before).flatMap(m => (m.type === 'term.data' && m.termId === 't2' ? [String(m.data)] : []));
      expect(after.join('')).toBe(long);
      expect(Math.max(...after.map(piece => piece.length))).toBeLessThanOrEqual(2 * TERM_CHUNK);
    } finally {
      vi.useRealTimers();
    }
  });

  /* tmux's client draws only what it has time for, and scrolls a terminal in ways that keep nothing. A view's terminal gets
     its history from the node, each line once, and from tmux only its screen. */
  it.each([true, false])('a view opened before the program writes gets every line of a burst into its history once, in order, write: %s', async write => {
    const key = `h4-${write}`;
    const name = await session(key);
    await host.open({ type: 'term.open', termId: key, agentKey: key, cols: 80, rows: 24, write });
    await until(() => frames(key).length > 0);
    await tmux.run(['respawn-pane', '-k', '-t', name, 'sh', '-c', `${LINES(1, 3000)}; sleep 30`]);
    await until(() => numbered(key).length >= 2977, 15_000);
    expect(numbered(key)).toEqual(fromOne(numbered(key).length));
    const screenOnly = shown(key).replace(INTO_HISTORY, '');
    expect(screenOnly).not.toMatch(/\x1b\[\d*S|\x1b\[\?1049h|\x1b\[\d+;\d+r/);
    expect(screenOnly).toContain('line-3000-end');
  });

  it('gets the lines of two bursts apart into the history once, in order', async () => {
    const name = await session('h10');
    await host.open({ type: 'term.open', termId: 't10', agentKey: 'h10', cols: 80, rows: 24, write: false });
    await until(() => frames('t10').length > 0);
    await tmux.run(['respawn-pane', '-k', '-t', name, 'sh', '-c', `${LINES(1, 200)}; sleep 1; ${LINES(201, 244)}; sleep 30`]);
    await until(() => numbered('t10').length >= 221, 10_000);
    expect(numbered('t10')).toEqual(fromOne(numbered('t10').length));
  });

  it('gets a program\'s normal screen into the history when it goes to its alternate screen, once however it comes back', async () => {
    const name = await session('h8');
    await host.open({ type: 'term.open', termId: 't8', agentKey: 'h8', cols: 80, rows: 24, write: false });
    await until(() => frames('t8').length > 0);
    await tmux.run(['respawn-pane', '-k', '-t', name, 'sh', '-c',
      `${LINES(1, 40)}; sleep 0.7; printf '\\033[?1049h\\033[HALT-SCREEN'; sleep 0.7; printf '\\033[?1049l'; ${LINES(41, 100)}; sleep 30`]);
    await until(() => pushed('t8').includes('line-40-end'), 10_000);
    await until(() => shown('t8').includes('line-100-end'), 10_000);
    await until(() => numbered('t8').length >= 77, 5000);
    expect(numbered('t8')).toEqual(fromOne(numbered('t8').length));
    expect(pushed('t8')).not.toContain('ALT-SCREEN');
    expect(shown('t8')).toContain('ALT-SCREEN');
  });

  it('adds nothing to the history and draws nothing again for a program that only repaints its screen', async () => {
    const name = await session('h11');
    await tmux.run(['respawn-pane', '-k', '-t', name, 'sh', '-c', `${LINES(1, 40)}; i=0; while :; do printf '\\rTICK-%s' $i; i=$((i+1)); sleep 0.25; done`]);
    await until(async () => (await tmux.screen(name)).includes('TICK-'));
    await host.open({ type: 'term.open', termId: 't11', agentKey: 'h11', cols: 80, rows: 24, write: false });
    await until(() => frames('t11').length > 0);
    const given = pushed('t11').length;
    const run = vi.spyOn(tmux, 'run');
    await until(() => (shown('t11').match(/TICK-/g) ?? []).length >= 4, 5000);
    expect(pushed('t11')).toHaveLength(given);
    expect(run.mock.calls.filter(([args]) => args.includes('refresh-client'))).toEqual([]);
  });

  it('adds no line twice when the view gets narrower and its lines take other rows', async () => {
    const name = await session('h12');
    await host.open({ type: 'term.open', termId: 't12', agentKey: 'h12', cols: 80, rows: 24, write: false });
    await until(() => frames('t12').length > 0);
    const long = `sed 's/$/-${'x'.repeat(50)}/'`;
    await tmux.run(['respawn-pane', '-k', '-t', name, 'sh', '-c', `${LINES(1, 100)} | ${long}; sleep 1.5; ${LINES(101, 200)} | ${long}; sleep 30`]);
    await until(() => numbered('t12').some(line => line.startsWith('line-77-')), 10_000);
    await host.resize({ type: 'term.resize', termId: 't12', cols: 40, rows: 24 });
    await until(() => numbered('t12').some(line => line.startsWith('line-180-')), 15_000);
    const seen = numbered('t12').map(line => Number(/^line-(\d+)-/.exec(line)![1]));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('gives the history what a program left on its normal screen, and leaves its alternate screen to the client', async () => {
    const name = await session('h6');
    await tmux.run(['respawn-pane', '-k', '-t', name, 'sh', '-c', `i=1; while [ $i -le 40 ]; do echo "OLD-$i-end"; i=$((i+1)); done; printf '\\033[?1049h\\033[HALT-SCREEN'; sleep 30`]);
    await until(async () => (await tmux.screen(name)).includes('ALT-SCREEN'));
    await host.open({ type: 'term.open', termId: 't6', agentKey: 'h6', cols: 80, rows: 24, write: false });
    await until(() => shown('t6').includes('ALT-SCREEN'));
    expect(pushed('t6').filter(line => /^OLD-/.test(line))).toEqual(Array.from({ length: 40 }, (_, at) => `OLD-${at + 1}-end`));
    expect(pushed('t6')).not.toContain('ALT-SCREEN');
  });

  it('gives the history only what has left the screen, which the client draws', async () => {
    const name = await session('h7');
    await tmux.run(['respawn-pane', '-k', '-t', name, 'sh', '-c', 'i=1; while [ $i -le 40 ]; do echo "OLD-$i-end"; i=$((i+1)); done; sleep 30']);
    await until(async () => (await tmux.screen(name)).includes('OLD-40-end'));
    await host.open({ type: 'term.open', termId: 't7', agentKey: 'h7', cols: 80, rows: 24, write: false });
    await until(() => shown('t7').includes('OLD-40-end'));
    expect(pushed('t7')).toEqual(Array.from({ length: 17 }, (_, at) => `OLD-${at + 1}-end`));
  });

  it('hides a known secret in the lines it gives the history', async () => {
    const name = await session('h9');
    await host.open({ type: 'term.open', termId: 't9', agentKey: 'h9', cols: 80, rows: 24, write: false });
    await until(() => frames('t9').length > 0);
    await tmux.run(['respawn-pane', '-k', '-t', name, 'sh', '-c', `echo "first ${SECRET} words"; ${LINES(1, 40)}; sleep 30`]);
    await until(() => pushed('t9').some(line => line.startsWith('first ')), 10_000);
    expect(shown('t9')).not.toContain(SECRET);
  });

  it('keeps the other settings of terminals on the server when a view asks for its screen', async () => {
    await session('h5');
    await tmux.run(['set-option', '-sa', 'terminal-overrides', 'other-term:Tc']);
    await host.open({ type: 'term.open', termId: 't5', agentKey: 'h5', cols: 80, rows: 24, write: false });
    await until(() => frames('t5').length > 0);
    await host.open({ type: 'term.open', termId: 't6', agentKey: 'h5', cols: 80, rows: 24, write: false });
    await until(() => frames('t6').length > 0);
    const overrides = await tmux.run(['show-options', '-s', 'terminal-overrides']);
    expect(overrides).toContain('other-term:Tc');
    expect(overrides.match(/smcup@/g)).toHaveLength(1);
  });

  it('says nothing more once the view closed while its history was read', async () => {
    await session('h3');
    const run = tmux.run.bind(tmux);
    let release = () => {};
    const held = new Promise<void>(done => { release = done; });
    vi.spyOn(tmux, 'run').mockImplementation(async (args, input) => {
      if (args.includes('-5000')) { await held; return 'LATE-HISTORY\n'; }
      return run(args, input);
    });
    const opening = host.open({ type: 'term.open', termId: 't3', agentKey: 'h3', cols: 80, rows: 24, write: false });
    await until(() => host['views'].has('t3'));
    host.close({ type: 'term.close', termId: 't3' });
    release();
    await opening;
    expect(shown('t3')).not.toContain('LATE-HISTORY');
  });
});
