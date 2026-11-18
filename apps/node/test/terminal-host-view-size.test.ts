import type * as ChildProcess from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanups, liveTerminal } from './terminal-host-live-helpers.js';

/* The size of a person's view reaches the tmux client that shows the session to that view. tmux, the program, stty and ps
   never run: the test stands in for the client and for what stty and ps answer, and checks what the node tells them. A real
   stty ended when its machine let it, after the half second of the test's clock had passed on a busy one. */
const machine = vi.hoisted(() => ({ stty: [] as string[][], parents: new Map<number, number>() }));
vi.mock('node:child_process', async original => {
  const real = await original<typeof ChildProcess>();
  type Done = (error: Error | null, stdout: string, stderr: string) => void;
  const execFile = (file: string, args: readonly string[], ...rest: unknown[]) => {
    const done = rest.at(-1) as Done;
    if (file === 'stty') {
      machine.stty.push([...args]);
      process.nextTick(() => done(null, '', ''));
      return;
    }
    if (file === 'ps') {
      const parent = machine.parents.get(Number(args.at(-1)));
      process.nextTick(() => (parent === undefined ? done(new Error('no such process'), '', '') : done(null, `${parent}\n`, '')));
      return;
    }
    return (real.execFile as (...all: unknown[]) => unknown)(file, args, ...rest);
  };
  return { ...real, execFile };
});

/* Above the largest process id Linux or macOS gives, so no process of the machine answers for the client in /proc. */
const CLIENT = 4_194_305;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  machine.stty.length = 0;
  machine.parents.clear();
});

describe("a view's size", () => {
  it('reaches its tmux client once the client draws, when the size came before the node could find the client', async () => {
    const t = await liveTerminal('claude', 'queued');
    t.finish();
    await t.on(t.running);
    await t.on(t.host.open({ type: 'term.open', termId: 'v1', agentKey: 'receipt', cols: 131, rows: 42, write: true }));
    const [{ view }] = t.views;
    /* The viewer is this test's process, and the client a process it started, as script starts tmux attach. */
    Object.assign(view, { pid: process.pid });
    machine.parents.set(CLIENT, process.pid);
    const shown = () => (t.host as unknown as { viewSessions: { views: Map<string, { applied: { cols: number; rows: number }; tty: string | null }> } }).viewSessions.views.get('v1')!;
    /* The browser's terminal fits its window a moment after it opens, before the client is there, as on a machine short of
       memory: the node cannot find the client then. */
    await t.on(t.host.resize({ type: 'term.resize', termId: 'v1', cols: 120, rows: 42 }));
    expect(shown().applied).toEqual({ cols: 131, rows: 42 });
    expect(machine.stty).toEqual([]);
    /* The client is there and draws the screen; the person changes nothing more. */
    vi.spyOn(t.tmux, 'clients').mockResolvedValue([{ pid: CLIENT, tty: '/dev/hh-test-tty', session: 'hh-receipt', cols: 120, rows: 42 }]);
    view.stdout.write('the screen');
    await t.pass(500);
    expect([shown().tty, shown().applied]).toEqual(['/dev/hh-test-tty', { cols: 120, rows: 42 }]);
    expect(machine.stty.map(args => args.slice(1))).toEqual([['/dev/hh-test-tty', 'cols', '120', 'rows', '42']]);
  });
});
