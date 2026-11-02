import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasTmux, until, host, tmux, sent, setUp } from './terminal-host-helpers.js';

/* A size command that takes long, to see two sizes of one view cross. Only stty is held, and only while a test asks. */
const held = vi.hoisted(() => ({ rows: null as string | null, ms: 0, release: null as (() => void) | null }));
vi.mock('node:child_process', async original => {
  const real = await original<typeof import('node:child_process')>();
  const execFile = ((file: string, args: string[], ...rest: unknown[]) => {
    if (file === 'stty' && held.rows && args.includes(held.rows)) {
      const run = () => (real.execFile as (...a: unknown[]) => unknown)(file, args, ...rest);
      /* Held for so long, or until the test lets it go. */
      if (held.ms) setTimeout(run, held.ms);
      else held.release = run;
      return undefined;
    }
    return (real.execFile as (...a: unknown[]) => unknown)(file, args, ...rest);
  }) as typeof real.execFile;
  return { ...real, execFile };
});


const clients = async () => (await tmux.run(['list-clients', '-F', '#{client_width}x#{client_height}'])).trim().split('\n').filter(Boolean).sort();

describe.skipIf(!hasTmux)("a terminal's size", () => {
  afterEach(async () => {
    held.release?.();
    held.rows = null;
    held.ms = 0;
    held.release = null;
    await host?.stop();
  });

  it('keeps no size of a view that failed to open', async () => {
    /* Two windows open a new agent at once; one of them may fail to start its session. */
    await setUp();
    await Promise.allSettled([
      host.open({ type: 'term.open', termId: 'big', agentKey: 'a70', cols: 120, rows: 40, write: true }),
      host.open({ type: 'term.open', termId: 'small', agentKey: 'a70', cols: 80, rows: 20, write: true }),
    ]);
    host.close({ type: 'term.close', termId: 'big' });
    host.close({ type: 'term.close', termId: 'small' });
    await until(async () => (await clients()).length === 0);
    await host.open({ type: 'term.open', termId: 'next', agentKey: 'a70', cols: 158, rows: 50, write: true });
    await until(async () => (await clients()).join() === '158x50');
  });

  it('ends with the last size when two sizes of one view cross', async () => {
    await setUp();
    await host.open({ type: 'term.open', termId: 't71', agentKey: 'a71', cols: 158, rows: 29, write: true });
    await until(() => sent.some(m => m.type === 'term.data' && m.termId === 't71'));
    held.rows = '13';
    held.ms = 1000;
    const first = host.resize({ type: 'term.resize', termId: 't71', cols: 158, rows: 13 });
    /* The first size is on its way to the terminal by then. */
    await new Promise(r => setTimeout(r, 400));
    await host.resize({ type: 'term.resize', termId: 't71', cols: 158, rows: 20 });
    await first;
    await new Promise(r => setTimeout(r, 1200));
    expect(await clients()).toEqual(['158x20']);
  });

  it('does not keep a newer size waiting for an older one that has not landed yet', async () => {
    await setUp();
    await host.open({ type: 'term.open', termId: 't72', agentKey: 'a72', cols: 158, rows: 29, write: true });
    await until(() => sent.some(m => m.type === 'term.data' && m.termId === 't72'));
    held.rows = '13';
    const first = host.resize({ type: 'term.resize', termId: 't72', cols: 158, rows: 13 });
    await until(() => held.release !== null);
    await host.resize({ type: 'term.resize', termId: 't72', cols: 158, rows: 20 });
    expect(await clients()).toEqual(['158x20']);
    const late = held.release!;
    held.release = null;
    late();
    await first;
    await until(async () => (await clients()).join() === '158x20');
    await new Promise(r => setTimeout(r, 300));
    expect(await clients()).toEqual(['158x20']);
  });
});
