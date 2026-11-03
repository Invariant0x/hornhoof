import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { Tmux } from '../src/terminal/tmux.js';

let host: TerminalHost;
afterEach(async () => host?.stop());

it('rejects a foreign hook on a node without proc when peer ownership is configured', async () => {
  host = new TerminalHost({
    tmux: new Tmux({ socket: `hh-peer-${process.pid}`, env: { HOME: tmpdir() } }),
    hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], log: () => {},
    owner: () => ({ owns: async () => false }),
  });
  await host.start();
  const url = host['bridge'].agent('agent-1').hookUrl;
  expect((await fetch(url + '/stop', { method: 'POST', body: '{}' })).status).toBe(403);
});
