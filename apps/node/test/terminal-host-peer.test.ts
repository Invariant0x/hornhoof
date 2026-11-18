import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { NodeMessage } from '@hornhoof/protocol';
import { TerminalHost } from '../src/terminal/host.js';
import { Tmux } from '../src/terminal/tmux.js';

let host: TerminalHost;
afterEach(async () => host?.stop());

it('rejects a foreign hook on a node without proc when peer ownership is configured', async () => {
  const logs: string[] = [];
  const sent: NodeMessage[] = [];
  host = new TerminalHost({
    tmux: new Tmux({ socket: `hh-peer-${process.pid}`, env: { HOME: tmpdir() } }),
    hornhoof: 'http://127.0.0.1:9', send: message => void sent.push(message), secrets: () => [], log: line => void logs.push(line),
    owner: () => ({ owns: async () => false }),
  });
  await host.start();
  const url = host['bridge'].agent('agent-1').hookUrl;
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await fetch(url + '/stop', { method: 'POST', body: '{}' })).status).toBe(403);
  }
  expect(logs).toEqual(Array<string>(2).fill('Hook stop rejected: owner check failed (agent agent-1)'));
  expect(sent.filter(message => message.type === 'agent.hook_rejected')).toHaveLength(1);
  expect(logs.join('\n')).not.toContain(url.split('/').at(-1)!);
});

it('passes cancellation to the pane lookup and does not retry an expired command', async () => {
  const tmux = new Tmux({ socket: `hh-peer-${process.pid}`, env: { HOME: tmpdir() } });
  const controller = new AbortController();
  const run = vi.spyOn(tmux, 'run').mockImplementation(async (_args, _input, signal) => {
    expect(signal).toBe(controller.signal);
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  });
  host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], log: () => {} });
  const checking = host['panes']('agent-1', controller.signal);
  controller.abort(new Error('pane lookup expired'));
  await expect(checking).rejects.toThrow('pane lookup expired');
  expect(run).toHaveBeenCalledTimes(1);
  run.mockRestore();
});
