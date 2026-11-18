import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fromAgent, OwnerUnknown } from '../src/terminal/peer.js';

const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, '0');
const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })));

/* A /proc with two agents' panes, 10 and 20, and the processes under them. */
function fakeProc(socket: { port: number; bridgePort: number; inode: number }, holder: number) {
  const proc = mkdtempSync(join(tmpdir(), 'hh-proc-'));
  folders.push(proc);
  mkdirSync(join(proc, 'net'));
  writeFileSync(
    join(proc, 'net', 'tcp'),
    [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      `   0: 0100007F:${hex(socket.bridgePort)} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 500 1 0 100 0 0 10 0`,
      `   1: 0100007F:${hex(socket.port)} 0100007F:${hex(socket.bridgePort)} 01 00000000:00000000 00:00000000 00000000  1000        0 ${socket.inode} 1 0 20 4 30 10 -1`,
      `   2: 0100007F:${hex(socket.bridgePort)} 0100007F:${hex(socket.port)} 01 00000000:00000000 00:00000000 00000000     0        0 ${socket.inode + 1} 1 0 20 4 30 10 -1`,
    ].join('\n') + '\n',
  );
  const processes: [number, number, string][] = [
    [1, 0, 'node'],
    [10, 1, 'sh'],
    [11, 10, 'claude (main) x'],
    [12, 11, 'hh-hook'],
    [20, 1, 'sh'],
    [21, 20, 'codex'],
  ];
  for (const [pid, ppid, comm] of processes) {
    mkdirSync(join(proc, String(pid), 'fd'), { recursive: true });
    writeFileSync(join(proc, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 100 0 0 0\n`);
    symlinkSync('/dev/null', join(proc, String(pid), 'fd', '0'));
  }
  symlinkSync(`socket:[${socket.inode}]`, join(proc, String(holder), 'fd', '7'));
  return proc;
}

describe('which agent a connection to the bridge comes from', () => {
  const socket = { port: 41234, bridgePort: 35001, inode: 9001 };
  const panes = async (key: string) => (key === 'agent-1' ? [10] : key === 'agent-2' ? [20] : []);

  it("knows a connection made anywhere under an agent's pane as that agent's, and as no other agent's", async () => {
    const owns = fromAgent(panes, fakeProc(socket, 12));
    expect(await owns('agent-1', socket)).toBe(true);
    expect(await owns('agent-2', socket)).toBe(false);
    expect(await owns('agent-3', socket)).toBe(false);
  });

  it('requires the hinted pid to hold this connection, even when the actual caller belongs to the agent', async () => {
    const owns = fromAgent(panes, fakeProc(socket, 12));
    expect(await owns('agent-1', { ...socket, pid: 21 })).toBe(false);
    expect(await owns('agent-1', { ...socket, pid: 0 })).toBe(false);
  });

  it('accepts a verified pane root at pid 1', async () => {
    expect(await fromAgent(async () => [1], fakeProc(socket, 1))('agent-1', { ...socket, pid: 1 })).toBe(true);
    expect(await fromAgent(async () => [1], fakeProc(socket, 12))('agent-1', { ...socket, pid: 12 })).toBe(true);
  });

  it('refuses another agent borrowing the pid of the target agent', async () => {
    const owns = fromAgent(panes, fakeProc(socket, 21));
    expect(await owns('agent-1', { ...socket, pid: 12 })).toBe(false);
    expect(await owns('agent-2', { ...socket, pid: 12 })).toBe(false);
  });

  it('verifies the socket inode captured at accept even after the TCP table changes', async () => {
    const proc = fakeProc(socket, 12);
    writeFileSync(join(proc, 'net', 'tcp'), '');
    const owns = fromAgent(panes, proc);
    expect(await owns('agent-1', { ...socket, pid: 12, acceptedInode: String(socket.inode) })).toBe(true);
  });

  it("refuses a connection from another agent's processes, one it cannot find and one held outside every pane", async () => {
    expect(await fromAgent(panes, fakeProc(socket, 21))('agent-1', socket)).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 12))('agent-1', { ...socket, port: 41235 })).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 1))('agent-1', socket)).toBe(false);
  });

  it('says why it refuses a connection, and a pane lookup that fails gives no answer instead of a refusal', async () => {
    const reasons: string[] = [];
    const why = (reason: string) => void reasons.push(reason);
    expect(await fromAgent(panes, fakeProc(socket, 12))('agent-1', { ...socket, pid: 0 }, why)).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 12))('agent-1', { ...socket, pid: 21 }, why)).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 21))('agent-1', { ...socket, pid: 21 }, why)).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 12))('agent-1', { ...socket, port: 41235 }, why)).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 21))('agent-1', socket, why)).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 12))('agent-3', socket, why)).toBe(false);
    expect(reasons).toEqual([
      'malformed pid hint',
      'the hinted process does not hold the connection',
      "the caller is not under the agent's pane",
      'the connection is not in the socket table',
      "no process under the agent's pane holds the connection",
      'the agent has no pane',
    ]);
    const lost = fromAgent(async () => { throw new Error('no server running on /tmp/tmux-0/hh'); }, fakeProc(socket, 12));
    await expect(lost('agent-1', { ...socket, pid: 12 })).rejects.toBeInstanceOf(OwnerUnknown);
    await expect(lost('agent-1', socket)).rejects.toThrow('tmux pane lookup failed');
  });
});
