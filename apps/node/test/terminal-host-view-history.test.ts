import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERM_CHUNK } from '@hornhoof/protocol';
import { FAKE, hasTmux, host, job, sent, SECRET, setUp, tmux, until } from './terminal-host-helpers.js';

const frames = (termId: string) => sent.flatMap(m => (m.type === 'term.data' && m.termId === termId ? [String(m.data)] : []));
const shown = (termId: string) => frames(termId).join('');

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
    const read = tmux.screen.bind(tmux);
    vi.spyOn(tmux, 'screen').mockImplementation(async (target, history, styled) => {
      if (history !== 5000) return read(target, history, styled);
      await tmux.run(['send-keys', '-t', name, '-l', 'WRITTEN-WHILE-READ']);
      await until(async () => (await read(name)).includes('WRITTEN-WHILE-READ'));
      return `OLD-LINE-0\n\x1b[2mDIM\x1b[0m ${SECRET}\n`;
    });
    await host.open({ type: 'term.open', termId: 't1', agentKey: 'h1', cols: 80, rows: 24, write: false });
    await until(() => shown('t1').includes('WRITTEN-WHILE-READ'));
    expect(frames('t1')[0]).toContain('OLD-LINE-0');
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

  it('says nothing more once the view closed while its history was read', async () => {
    await session('h3');
    const read = tmux.screen.bind(tmux);
    let release = () => {};
    const held = new Promise<void>(done => { release = done; });
    vi.spyOn(tmux, 'screen').mockImplementation(async (target, history, styled) => {
      if (history === 5000) { await held; return 'LATE-HISTORY\n'; }
      return read(target, history, styled);
    });
    const opening = host.open({ type: 'term.open', termId: 't3', agentKey: 'h3', cols: 80, rows: 24, write: false });
    await until(() => host['views'].has('t3'));
    host.close({ type: 'term.close', termId: 't3' });
    release();
    await opening;
    expect(shown('t3')).not.toContain('LATE-HISTORY');
  });
});
