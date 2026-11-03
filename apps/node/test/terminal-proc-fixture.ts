import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { Bridge } from '../src/terminal/bridge.js';
import type { Tmux } from '../src/terminal/tmux.js';

/* A controlled process table for real HTTP connections; it never reads the machine's /proc. */
export function procFixture(key: string, belongs: (req: IncomingMessage) => boolean = () => true) {
  const proc = mkdtempSync(join(tmpdir(), 'hh-proc-'));
  mkdirSync(join(proc, 'net'));
  onTestFinished(() => rmSync(proc, { recursive: true, force: true }));
  const rows = ['sl local_address rem_address st tx_queue rx_queue tr tm uid inode'];
  const inodes = new WeakMap<Socket, number>();
  let next = 100;
  const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, '0');

  const listen = (bridge: Bridge, tmux: Tmux) => {
    const server = bridge['server']!;
    server.prependListener('connection', socket => {
      const inode = next++;
      inodes.set(socket, inode);
      rows.push(`0: 0100007F:${hex(socket.remotePort!)} 0100007F:${hex(socket.localPort!)} 01 0 0 0 0 0 ${inode}`);
      writeFileSync(join(proc, 'net', 'tcp'), rows.join('\n') + '\n');
    });
    server.prependListener('request', req => {
      const root = Number(execFileSync('tmux', [...tmux.base(), 'list-panes', '-s', '-t', `=a-${key}`, '-F', '#{pane_pid}']).toString().trim());
      const pid = Number(req.headers['x-hh-pid'] ?? root);
      processAt(proc, root, 0);
      processAt(proc, pid, belongs(req) && pid !== root ? root : 0);
      symlinkSync(`socket:[${inodes.get(req.socket)}]`, join(proc, String(pid), 'fd', String(next++)));
    });
  };
  return { proc, listen };
}

function processAt(proc: string, pid: number, parent: number): void {
  mkdirSync(join(proc, String(pid), 'fd'), { recursive: true });
  writeFileSync(join(proc, String(pid), 'stat'), `${pid} (fixture) S ${parent} 0\n`);
}
