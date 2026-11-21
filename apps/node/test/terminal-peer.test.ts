import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fromAgent, OwnerUnknown, socketOf } from '../src/terminal/peer.js';
import { fakeProc, removeProcs } from './terminal-peer-fixture.js';

afterEach(removeProcs);

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

  it('says why it refuses a connection, a closed one as a caller that left, and a pane lookup that fails gives no answer instead of a refusal', async () => {
    const reasons: string[] = [];
    const why = (reason: string) => void reasons.push(reason);
    expect(await fromAgent(panes, fakeProc(socket, 12))('agent-1', { ...socket, pid: 0 }, why)).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 12))('agent-1', { ...socket, pid: 21 }, why)).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 12))('agent-1', { ...socket, pid: 99 }, why)).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 21))('agent-1', { ...socket, pid: 21 }, why)).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 12))('agent-1', { ...socket, port: 41235 }, why)).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 21))('agent-1', socket, why)).toBe(false);
    expect(await fromAgent(panes, fakeProc(socket, 12))('agent-3', socket, why)).toBe(false);
    expect(reasons).toEqual([
      'malformed pid hint',
      'the hinted process does not hold the connection',
      'the hinted process is not running',
      "the caller is not under the agent's pane",
      'the caller left before its owner check',
      "no process under the agent's pane holds the connection",
      'the agent has no pane',
    ]);
    const lost = fromAgent(async () => { throw new Error('no server running on /tmp/tmux-0/hh'); }, fakeProc(socket, 12));
    await expect(lost('agent-1', { ...socket, pid: 12 })).rejects.toBeInstanceOf(OwnerUnknown);
    await expect(lost('agent-1', socket)).rejects.toThrow('tmux pane lookup failed');
  });

  it('gives no answer when the socket table cannot be read, rather than taking it for an empty one', async () => {
    const proc = fakeProc(socket, 12);
    rmSync(join(proc, 'net', 'tcp'));
    await expect(socketOf(proc, socket)).rejects.toThrow(new OwnerUnknown('Linux TCP table read failed'));
    await expect(fromAgent(panes, proc)('agent-1', { ...socket, pid: 12 })).rejects.toBeInstanceOf(OwnerUnknown);
  });

  it('distinguishes an unavailable Linux process lookup from a process that disappeared', async () => {
    const proc = fakeProc(socket, 12);
    const owns = fromAgent(panes, proc);
    await expect(owns('agent-1', { ...socket, pid: 12 })).resolves.toBe(true);

    const stat = join(proc, '12', 'stat');
    rmSync(stat);
    mkdirSync(stat);
    await expect(owns('agent-1', { ...socket, pid: 12 })).rejects.toThrow(new OwnerUnknown('Linux process ancestry lookup failed'));
    await expect(owns('agent-1', socket)).rejects.toThrow(new OwnerUnknown('Linux process tree lookup failed'));

    rmSync(join(proc, '12'), { recursive: true });
    await expect(owns('agent-1', { ...socket, pid: 12 })).resolves.toBe(false);
    symlinkSync('12', join(proc, '12'));
    await expect(owns('agent-1', { ...socket, pid: 12 })).rejects.toThrow(new OwnerUnknown('Linux hinted process lookup failed'));
  });
});
