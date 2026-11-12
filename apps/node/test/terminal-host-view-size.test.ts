import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanups, liveTerminal } from './terminal-host-live-helpers.js';

/* The size of a person's view reaches the tmux client that shows the session to that view. tmux and the program never run:
   the test stands in for the client, and checks what the node tells it. */
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("a view's size", () => {
  it('reaches its tmux client once the client draws, when the size came before the node could find the client', async () => {
    const t = await liveTerminal('claude', 'queued');
    t.finish();
    await t.on(t.running);
    await t.on(t.host.open({ type: 'term.open', termId: 'v1', agentKey: 'receipt', cols: 131, rows: 42, write: true }));
    const [{ view }] = t.views;
    /* The viewer is this test's process, and the client a process it starts, as script starts tmux attach. */
    Object.assign(view, { pid: process.pid });
    const client = spawn('sleep', ['30']);
    try {
      const shown = () => (t.host as unknown as { views: Map<string, { applied: { cols: number; rows: number }; tty: string | null }> }).views.get('v1')!;
      /* The browser's terminal fits its window a moment after it opens, before the client is there, as on a machine short of
         memory: the node cannot find the client then. */
      await t.on(t.host.resize({ type: 'term.resize', termId: 'v1', cols: 120, rows: 42 }));
      expect(shown().applied).toEqual({ cols: 131, rows: 42 });
      /* The client is there and draws the screen; the person changes nothing more. */
      vi.spyOn(t.tmux, 'clients').mockResolvedValue([{ pid: client.pid!, tty: '/dev/hh-test-tty', session: 'hh-receipt', cols: 120, rows: 42 }]);
      view.stdout.write('the screen');
      await t.pass(500);
      expect([shown().tty, shown().applied]).toEqual(['/dev/hh-test-tty', { cols: 120, rows: 42 }]);
    } finally {
      client.kill();
    }
  });
});
