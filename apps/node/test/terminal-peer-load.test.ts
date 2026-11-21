import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromAgent, procOwner, type Peer } from '../src/terminal/peer.js';
import { callerLeaves, fakeProc, removeProcs } from './terminal-peer-fixture.js';

/* A node on a machine so loaded that each look it awaits comes back only after a turn of its starved event loop, here
   one virtual second, and sees the machine as it is by then. What it reads at once costs it no turn. */
vi.mock('node:fs/promises', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const later = <T>(look: () => T) => new Promise<T>((resolve, reject) => setTimeout(() => { try { resolve(look()); } catch (error) { reject(error); } }, 1000));
  return {
    ...actual,
    readFile: (path: string, encoding: BufferEncoding) => later(() => fs.readFileSync(path, encoding)),
    readdir: (path: string) => later(() => fs.readdirSync(path)),
    readlink: (path: string) => later(() => fs.readlinkSync(path)),
    stat: (path: string) => later(() => fs.statSync(path)),
  };
});

const socket = { port: 41234, bridgePort: 35001, inode: 9001 };
/* tmux, on the same machine, names an agent's pane after five virtual seconds. */
const panes = (key: string) => new Promise<number[]>(resolve => setTimeout(() => resolve(key === 'agent-1' ? [10] : key === 'agent-2' ? [20] : []), 5000));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); removeProcs(); });

/* What the check answers by a virtual time, and why it refused, or 'pending' while it has not answered. */
async function answerBy(ms: number, check: (why: (reason: string) => void) => Promise<boolean>) {
  const why: string[] = [];
  const late = new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), ms + 1));
  const answer = Promise.race([check(reason => void why.push(reason)), late]);
  await vi.advanceTimersByTimeAsync(ms + 1);
  return { answer: await answer, why };
}

/* As the bridge does: the connection is looked up as the node accepts it, the caller as its call arrives. */
function call(proc: string, key: string, hint: Partial<Peer>, beforeCall = () => {}) {
  const { owns, capture } = procOwner(proc)(panes);
  return (why: (reason: string) => void) => capture!(socket).then(captured => { beforeCall(); return owns!(key, { ...socket, ...hint, ...captured }, why); });
}

describe('the owner check on a machine that starves the node', () => {
  it("accepts the agent's own hook that gives up while the node checks it: the proof is taken as the call arrives", async () => {
    const proc = fakeProc(socket, 12);
    setTimeout(() => callerLeaves(proc, socket, 12), 2500);
    expect(await answerBy(10_000, call(proc, 'agent-1', { pid: 12 }))).toEqual({ answer: true, why: [] });
  });

  /* However long the node takes: as before the fix, which answers this only after many turns. */
  it("refuses another agent's process just the same, with its pid, with the pid it borrowed or with none", async () => {
    const own = fakeProc(socket, 21);
    expect(await answerBy(60_000, call(own, 'agent-1', { pid: 21 }))).toEqual({ answer: false, why: ["the caller is not under the agent's pane"] });
    expect(await answerBy(60_000, call(own, 'agent-1', { pid: 12 }))).toEqual({ answer: false, why: ['the hinted process does not hold the connection'] });
    expect(await answerBy(60_000, call(own, 'agent-1', {}))).toEqual({ answer: false, why: ["no process under the agent's pane holds the connection"] });
  });

  it('refuses a caller that left before its check under its own reason, apart from one that names a process not running', async () => {
    const beforeAccept = fakeProc(socket, 12);
    callerLeaves(beforeAccept, socket, 12);
    expect(await answerBy(10_000, call(beforeAccept, 'agent-1', { pid: 12 }))).toEqual({ answer: false, why: ['the caller left before its owner check'] });

    const beforeCall = fakeProc(socket, 12);
    expect(await answerBy(10_000, call(beforeCall, 'agent-1', { pid: 12 }, () => callerLeaves(beforeCall, socket, 12)))).toEqual({ answer: false, why: ['the caller left before its owner check'] });

    expect(await answerBy(10_000, call(fakeProc(socket, 12), 'agent-1', { pid: 99 }))).toEqual({ answer: false, why: ['the hinted process is not running'] });
  });

  it('answers a call that sends no pid as soon as tmux has named the pane, however slow each look it awaits is', async () => {
    expect(await answerBy(5000, call(fakeProc(socket, 12), 'agent-1', {}))).toEqual({ answer: true, why: [] });
  });

  it('refuses a call that sends no pid under its own reason when the machine runs more processes than one look may read', async () => {
    const proc = fakeProc(socket, 12);
    for (let pid = 1000; pid < 1000 + 4096; pid++) {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), 'stat'), `${pid} (sleep) S 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0\n`);
    }
    expect(await answerBy(10_000, call(proc, 'agent-1', {}))).toEqual({ answer: false, why: ['the machine runs more processes than one owner check may read'] });
  });

  it.each([{}, { pid: 12 }])('refuses under its own reason a look that would hold the node over half a second, with hint %j', async hint => {
    /* Each look at the machine takes the node a quarter of a second. */
    let at = 0;
    const owns = fromAgent(panes, fakeProc(socket, 12), { now: () => (at += 250) });
    expect(await answerBy(10_000, why => owns('agent-1', { ...socket, ...hint }, why))).toEqual({ answer: false, why: ['the owner check ran out of its time on this machine'] });
  });
});
