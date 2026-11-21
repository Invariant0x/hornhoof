import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type FakeSocket = { port: number; bridgePort: number; inode: number };

const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, '0');
const folders: string[] = [];
export const removeProcs = () => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true }));

/* The kernel's table of TCP connections with the bridge listening and, unless the caller closed its end, both ends of
   the caller's connection. */
export function writeTcp(proc: string, socket: FakeSocket, open = true): void {
  const listening = `   0: 0100007F:${hex(socket.bridgePort)} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 500 1 0 100 0 0 10 0`;
  const ends = [
    `   1: 0100007F:${hex(socket.port)} 0100007F:${hex(socket.bridgePort)} 01 00000000:00000000 00:00000000 00000000  1000        0 ${socket.inode} 1 0 20 4 30 10 -1`,
    `   2: 0100007F:${hex(socket.bridgePort)} 0100007F:${hex(socket.port)} 01 00000000:00000000 00:00000000 00000000     0        0 ${socket.inode + 1} 1 0 20 4 30 10 -1`,
  ];
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  writeFileSync(join(proc, 'net', 'tcp'), [header, listening, ...(open ? ends : [])].join('\n') + '\n');
}

export function writeProcess(proc: string, pid: number, ppid: number, comm: string): void {
  mkdirSync(join(proc, String(pid), 'fd'), { recursive: true });
  writeFileSync(join(proc, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 100 0 0 0\n`);
  symlinkSync('/dev/null', join(proc, String(pid), 'fd', '0'));
}

/* A /proc with two agents' panes, 10 and 20, and the processes under them. */
export function fakeProc(socket: FakeSocket, holder: number): string {
  const proc = mkdtempSync(join(tmpdir(), 'hh-proc-'));
  folders.push(proc);
  mkdirSync(join(proc, 'net'));
  writeTcp(proc, socket);
  const processes: [number, number, string][] = [
    [1, 0, 'node'],
    [10, 1, 'sh'],
    [11, 10, 'claude (main) x'],
    [12, 11, 'hh-hook'],
    [20, 1, 'sh'],
    [21, 20, 'codex'],
  ];
  for (const [pid, ppid, comm] of processes) writeProcess(proc, pid, ppid, comm);
  symlinkSync(`socket:[${socket.inode}]`, join(proc, String(holder), 'fd', '7'));
  return proc;
}

/* The caller exits: its process goes, and with it its end of the connection. */
export function callerLeaves(proc: string, socket: FakeSocket, pid: number): void {
  rmSync(join(proc, String(pid)), { recursive: true, force: true });
  writeTcp(proc, socket, false);
}
