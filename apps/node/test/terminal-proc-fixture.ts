import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { Bridge } from '../src/terminal/bridge.js';
import type { Capture } from '../src/terminal/peer.js';
import type { Tmux } from '../src/terminal/tmux.js';

/* A controlled process table for real HTTP connections; it never reads the machine's /proc. */
export function procFixture(key: string, belongs: (req: IncomingMessage) => boolean = () => true) {
  const proc = mkdtempSync(join(tmpdir(), 'hh-proc-'));
  mkdirSync(join(proc, 'net'));
  onTestFinished(() => rmSync(proc, { recursive: true, force: true }));
  const rows = new Map<Socket, string>();
  const inodes = new WeakMap<Socket, number>();
  const peers = new Map<string, string>();
  const links = new WeakMap<Socket, string[]>();
  let next = 100;
  const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, '0');
  const table = () => {
    if (existsSync(proc)) writeFileSync(join(proc, 'net', 'tcp'),
      ['sl local_address rem_address st tx_queue rx_queue tr tm uid inode', ...rows.values()].join('\n') + '\n');
  };

  const listen = (bridge: Bridge, pane: Tmux | (() => number), caller?: () => number) => {
    const server = bridge['server']!;
    server.prependListener('connection', socket => {
      const inode = next++;
      inodes.set(socket, inode);
      const peer = `${socket.remotePort}:${socket.localPort}`;
      peers.set(peer, String(inode));
      rows.set(socket, `0: 0100007F:${hex(socket.remotePort!)} 0100007F:${hex(socket.localPort!)} 01 0 0 0 0 0 ${inode}`);
      table();
      socket.once('close', () => {
        peers.delete(peer);
        for (const link of links.get(socket) ?? []) rmSync(link, { force: true });
        rows.delete(socket);
        table();
      });
    });
    server.prependListener('request', req => {
      const root = panePid(pane, key);
      /* The direct bridge tests supply the actual caller, independently of its untrusted pid hint. */
      const pid = caller ? caller() : Number(req.headers['x-hh-pid'] ?? root);
      processAt(proc, root, 0);
      processAt(proc, pid, belongs(req) && pid !== root ? root : 0);
      const link = join(proc, String(pid), 'fd', String(next++));
      symlinkSync(`socket:[${inodes.get(req.socket)}]`, link);
      links.set(req.socket, [...(links.get(req.socket) ?? []), link]);
    });
  };
  /* Capture the accepted connection before a later table refresh or close can change its filesystem view. */
  const capture: Capture = async peer => ({ acceptedInode: peers.get(`${peer.port}:${peer.bridgePort}`) ?? null });
  return { proc, listen, capture };
}

function panePid(pane: Tmux | (() => number), key: string): number {
  return typeof pane === 'function' ? pane() : Number(execFileSync('tmux', [...pane.base(), 'list-panes', '-s', '-t', `=a-${key}`, '-F', '#{pane_pid}']).toString().trim());
}

function processAt(proc: string, pid: number, parent: number): void {
  mkdirSync(join(proc, String(pid), 'fd'), { recursive: true });
  writeFileSync(join(proc, String(pid), 'stat'), `${pid} (fixture) S ${parent} 0\n`);
}
