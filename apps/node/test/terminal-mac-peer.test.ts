import { Agent, request } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../src/terminal/bridge.js';
import { macOwner, type Command } from '../src/terminal/mac-peer.js';
import { trackCheckProcess } from '../src/check-processes.js';
import { terminalOwner } from '../src/main.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach(clean => clean());
  vi.useRealTimers();
});

type Rejection = { key: string | null; event: string; reason: string };

function post(url: string, agent: Agent, pid: number | string | null = 55, event = 'stop'): Promise<number> {
  return new Promise((resolve, reject) => {
    const call = request(`${url}/${event}`, { method: 'POST', agent, headers: pid === null ? {} : { 'x-hh-pid': String(pid) } }, res => {
      res.resume().on('end', () => resolve(res.statusCode!));
    });
    call.on('error', reject).end('{}');
  });
}

/* What a Mac's ps says: the hook 55 under the pane 10, a stranger 77 and a second holder 66 under launchd. */
const PARENTS = new Map([[1, 0], [10, 1], [55, 10], [66, 1], [77, 1]]);
const TABLE = [...PARENTS].map(([pid, parent]) => `${String(pid).padStart(5)} ${String(parent).padStart(5)}`).join('\n') + '\n';

/* A command that execFile ended at its time limit, as it rejects then. */
const timedOut = (file: string) => Object.assign(new Error(`Command failed: ${file}`), { killed: true, signal: 'SIGTERM', code: null });

/* Stands in for lsof and ps. The client end of each connection belongs to one process, 55 unless the mode says otherwise,
   and the bridge's own end lists the pair the other way round under the node, 999. lsof asked with -p shows that process
   only, as lsof does; ps answers for one process with -p, or with the whole table. */
async function opened(mode = 'own', roots = [10], beforeCommand?: Command) {
  let url = '';
  let current = mode;
  const commands: { file: string; args: string[]; timeout: number }[] = [];
  const heard: string[] = [];
  const rejected: Rejection[] = [];
  const run: Command = async (file, args, options) => {
    commands.push({ file, args, timeout: options.timeout });
    await beforeCommand?.(file, args, options);
    const only = args.includes('-p') ? Number(args[args.indexOf('-p') + 1]) : null;
    if (file === '/bin/ps') {
      if (current === 'ps-timeout') throw timedOut(file);
      if (current === 'ps-error') throw new Error('spawn /bin/ps EAGAIN');
      if (current === 'ps-empty') return '';
      if (current === 'ps-incomplete') return '   55    66\n   10    1\n    1    0\n';
      if (only === null) return TABLE;
      if (!PARENTS.has(only)) throw Object.assign(new Error('Command failed: /bin/ps'), { code: 1, killed: false });
      return `${PARENTS.get(only)}\n`;
    }
    if (current === 'lsof-timeout') throw timedOut(file);
    if (current === 'lsof-error') throw new Error('spawn /usr/sbin/lsof ENOENT');
    const client = args.find(arg => arg.startsWith('-iTCP:'))!.slice(6);
    const server = new URL(url).port;
    const pair = `n127.0.0.1:${client}->127.0.0.1:${server}`;
    const crafted: Record<string, string> = {
      empty: '', reversed: `p999\nn127.0.0.1:${server}->127.0.0.1:${client}\n`, malformed: `pzero\n${pair}\n`, 'leading-zero': `p01\n${pair}\n`,
      'no-pid': `${pair}\n`, 'huge-pid': `p99999999999999999999999999\n${pair}\n`,
    };
    if (current in crafted) return crafted[current]!;
    const holders = current === 'foreign' ? [77] : current === 'root-one' ? [1] : current === 'ambiguous' ? [55, 66] : [55];
    const files = [{ pid: 999, name: `n127.0.0.1:${server}->127.0.0.1:${client}` }, ...holders.map(pid => ({ pid, name: pair }))];
    return files.filter(file => only === null || file.pid === only).map(file => `p${file.pid}\nf7\n${file.name}\n`).join('');
  };
  const owner = terminalOwner('darwin', run)!(async () => roots);
  const bridge = new Bridge('http://127.0.0.1:9', key => void heard.push(key), owner.owns, { capture: owner.capture, rejected: (key, event, reason) => rejected.push({ key, event, reason }) });
  await bridge.start();
  url = bridge.agent('agent-1').hookUrl;
  const sockets = new Set<Socket>();
  bridge['server']!.on('connection', socket => sockets.add(socket));
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  cleanups.push(() => { agent.destroy();bridge.stop(); });
  return { url, agent, heard, rejected, commands, sockets, mode: (value: string) => { current = value; } };
}

describe('macOS hook ownership without proc', () => {
  it('checks the hinted process first, confirms a single holder and reads one ps table', async () => {
    const c = await opened();
    expect(await post(c.url, c.agent, 55, 'tool')).toBe(200);
    expect(c.heard).toEqual(['agent-1']);
    expect(c.commands).toEqual([
      { file: '/usr/sbin/lsof', args: ['-nP', '-a', '-p', '55', expect.stringMatching(/^-iTCP:\d+$/), '-sTCP:ESTABLISHED', '-Fpn'], timeout: 2000 },
      { file: '/usr/sbin/lsof', args: ['-nP', '-a', expect.stringMatching(/^-iTCP:\d+$/), '-sTCP:ESTABLISHED', '-Fpn'], timeout: 2000 },
      { file: '/bin/ps', args: ['-A', '-o', 'pid=', '-o', 'ppid='], timeout: 2000 },
    ]);
  });

  it('looks among every process for a caller that names none, and needs exactly one holder', async () => {
    const c = await opened();
    expect(await post(c.url, c.agent, null)).toBe(200);
    expect(c.commands[0]).toEqual({ file: '/usr/sbin/lsof', args: ['-nP', '-a', expect.stringMatching(/^-iTCP:\d+$/), '-sTCP:ESTABLISHED', '-Fpn'], timeout: 2000 });
    c.mode('ambiguous');
    c.agent.destroy();
    expect(await post(c.url, c.agent, null)).toBe(403);
    expect(c.heard).toEqual(['agent-1']);
  });

  it('rejects a foreign socket owner and a caller borrowing the pid of the pane', async () => {
    const c = await opened('foreign');
    expect(await post(c.url, c.agent, 77)).toBe(403);
    expect(await post(c.url, c.agent, 55)).toBe(403);
    expect(await post(c.url, c.agent, 10)).toBe(403);
    expect(c.heard).toEqual([]);
  });

  it('requires independent socket confirmation before checking a hinted caller’s ancestry', async () => {
    const c = await opened('own', [10], async (file, args) => {
      if (file === '/usr/sbin/lsof' && !args.includes('-p')) throw new Error('socket confirmation unavailable');
      return '';
    });
    expect(await post(c.url, c.agent, 55)).toBe(502);
    expect(c.commands.map(command => command.file)).toEqual(['/usr/sbin/lsof', '/usr/sbin/lsof']);
    expect(c.heard).toEqual([]);
  });

  it('refuses a hinted connection when the independent listing has multiple holders', async () => {
    const c = await opened('ambiguous');
    expect(await post(c.url, c.agent, 55)).toBe(403);
    expect(c.rejected).toEqual([{ key: 'agent-1', event: 'stop', reason: 'owner check failed: no single process holds the connection' }]);
    expect(c.heard).toEqual([]);
  });

  it('recognizes only the live check roots of the authenticated agent', async () => {
    const run: Command = async file => file === '/bin/ps' ? TABLE : 'p77\nn127.0.0.1:1->127.0.0.1:2\n';
    const owner = macOwner(run)(async () => []);
    const forget = trackCheckProcess('agent-1', 77); cleanups.push(forget);
    const peer = { port: 1, bridgePort: 2, pid: 77 };
    expect(await owner.owns!('agent-1', peer)).toBe(true);
    expect(await owner.owns!('agent-2', peer)).toBe(false);
    forget();
    expect(await owner.owns!('agent-1', peer)).toBe(false);
  });

  it('accepts a verified process at pid 1', async () => {
    const c = await opened('root-one', [10, 1]);
    expect(await post(c.url, c.agent, 1)).toBe(200);
  });

  it.each(['empty', 'reversed', 'ambiguous', 'malformed', 'leading-zero', 'no-pid', 'huge-pid'])('closes access when lsof answers %s', async mode => {
    const c = await opened(mode);
    expect(await post(c.url, c.agent, 1)).toBe(403);
    expect(c.heard).toEqual([]);
  });

  it.each(['lsof-timeout', 'lsof-error', 'ps-timeout', 'ps-error', 'ps-empty', 'ps-incomplete'])("answers a genuine owner's tool hooks with a retryable 502 when the lookup gives no answer (%s), and keeps none of it", async mode => {
    const c = await opened(mode);
    expect(await post(c.url, c.agent, 55, 'tool')).toBe(502);
    expect(await post(c.url, c.agent, 55, 'tooldone')).toBe(502);
    expect(c.heard).toEqual([]);
    c.mode('own');
    expect(await post(c.url, c.agent, 55, 'tool')).toBe(200);
    expect(await post(c.url, c.agent, 55, 'tooldone')).toBe(200);
    expect(c.heard).toEqual(['agent-1', 'agent-1']);
    expect(c.sockets.size).toBe(1);
  });

  it('checks ownership again after the pane is re-adopted on a kept connection', async () => {
    const roots: number[] = [];
    const c = await opened('own', roots);
    expect(await post(c.url, c.agent, 55, 'tool')).toBe(403);
    roots.push(10);
    expect(await post(c.url, c.agent, 55, 'tool')).toBe(200);
    expect(c.sockets.size).toBe(1);
    expect(c.heard).toEqual(['agent-1']);
  });

  it('answers a slow pair of lookups with 502 before the tool hook deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let readingPs!: () => void;
    const enteredPs = new Promise<void>(resolve => { readingPs = resolve; });
    let slow = true;
    const c = await opened('own', [10], async (file, args) => {
      if (!slow || (file === '/usr/sbin/lsof' && !args.includes('-p'))) return '';
      if (file === '/usr/sbin/lsof') started();
      else readingPs();
      await new Promise<void>(resolve => setTimeout(resolve, 1_750));
      return '';
    });
    const first = post(c.url, c.agent, 55, 'tool');
    void first.catch(() => {});
    await entered;
    await vi.advanceTimersByTimeAsync(1_750);
    await enteredPs;
    await vi.advanceTimersByTimeAsync(749);
    expect(c.rejected).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.rejected).toEqual([{ key: 'agent-1', event: 'tool', reason: 'owner check unavailable: macOS owner lookup timed out' }]);
    expect(await first).toBe(502);
    expect(c.heard).toEqual([]);
    slow = false;
    expect(await post(c.url, c.agent, 55, 'tool')).toBe(200);
    expect(c.sockets.size).toBe(1);
    expect(c.heard).toEqual(['agent-1']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(c.heard).toEqual(['agent-1']);
  });

  it('cancels slow socket confirmation at the aggregate deadline and starts no further lookup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let entered!: () => void;
    const checkingHint = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void;
    const late = new Promise<void>(resolve => { finish = resolve; });
    let cancelled = false;
    let confirming = false;
    let slow = true;
    const c = await opened('own', [10], async (file, args, options) => {
      if (file === '/usr/sbin/lsof' && slow) {
        if (args.includes('-p')) {
          entered();
          await new Promise<void>(resolve => setTimeout(resolve, 1_750));
        }
        else {
          options.signal?.addEventListener('abort', () => { cancelled = true; }, { once: true });
          confirming = true;
          await late;
        }
      }
      return '';
    });
    const first = post(c.url, c.agent, 55, 'tool');
    void first.catch(() => {});
    await checkingHint;
    await vi.advanceTimersByTimeAsync(1_750);
    expect(confirming).toBe(true);
    await vi.advanceTimersByTimeAsync(749);
    expect(cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBe(502);
    expect(cancelled).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.commands.map(command => command.file)).toEqual(['/usr/sbin/lsof', '/usr/sbin/lsof']);
    expect(c.heard).toEqual([]);
    slow = false;
    expect(await post(c.url, c.agent, 55, 'tool')).toBe(200);
    expect(c.sockets.size).toBe(1);
  });

  it('says in the log why it refused a call or asks for it again, and names no secret of the address', async () => {
    const c = await opened('foreign');
    expect(await post(c.url, c.agent, 55)).toBe(403);
    expect(await post(c.url, c.agent, 77)).toBe(403);
    expect(await post(c.url, c.agent, 'zero')).toBe(403);
    for (const mode of ['lsof-timeout', 'lsof-error', 'ps-timeout', 'ps-error', 'ps-empty']) {
      c.mode(mode);
      expect(await post(c.url, c.agent, 55, 'tool')).toBe(502);
    }
    expect(c.rejected).toEqual([
      { key: 'agent-1', event: 'stop', reason: 'owner check failed: the hinted process does not hold the connection' },
      { key: 'agent-1', event: 'stop', reason: "owner check failed: the caller is not under the agent's pane" },
      { key: 'agent-1', event: 'stop', reason: 'owner check failed: malformed pid hint' },
      { key: 'agent-1', event: 'tool', reason: 'owner check unavailable: lsof timed out' },
      { key: 'agent-1', event: 'tool', reason: 'owner check unavailable: lsof failed' },
      { key: 'agent-1', event: 'tool', reason: 'owner check unavailable: ps timed out' },
      { key: 'agent-1', event: 'tool', reason: 'owner check unavailable: ps failed' },
      { key: 'agent-1', event: 'tool', reason: 'owner check unavailable: ps gave no process table' },
    ]);
    expect(JSON.stringify(c.rejected)).not.toContain(c.url.split('/').at(-1)!);
  });

  it('reuses a successful check only for the same connection and pid hint', async () => {
    const c = await opened();
    expect(await post(c.url, c.agent)).toBe(200);
    expect(await post(c.url, c.agent)).toBe(200);
    expect(await post(c.url, c.agent, 77)).toBe(403);
    expect(c.commands.filter(command => command.file === '/usr/sbin/lsof')).toHaveLength(3);
    c.mode('foreign');
    c.agent.destroy();
    expect(await post(c.url, c.agent, 77)).toBe(403);
    expect(c.commands.filter(command => command.file === '/usr/sbin/lsof')).toHaveLength(5);
  });

  it("walks the ps table up to launchd, never to the kernel's 0, and gives no answer for a loop", async () => {
    const table = (text: string): Command => async file => file === '/bin/ps' ? text : 'p55\nn127.0.0.1:1->127.0.0.1:2\n';
    const peer = { port: 1, bridgePort: 2, pid: 55 };
    expect(await macOwner(table(TABLE))(async () => [1]).owns!('agent-1', peer)).toBe(true);
    expect(await macOwner(table(TABLE))(async () => [0]).owns!('agent-1', peer)).toBe(false);
    const loop = '   55    10\n   10    55\n';
    await expect(macOwner(table(loop))(async () => [10]).owns!('agent-1', peer)).rejects.toThrow('ps gave a cyclic process lineage');
  });

  it.each(['55 10 truncated', '55 10\n55 1', '9007199254740993 10', '55 9007199254740993'])('gives no ownership answer for an invalid process table (%s)', async table => {
    const run: Command = async file => file === '/bin/ps' ? `1 0\n10 1\n${table}\n` : 'p55\nn127.0.0.1:1->127.0.0.1:2\n';
    const owner = macOwner(run)(async () => [10]);
    await expect(owner.owns!('agent-1', { port: 1, bridgePort: 2, pid: 55 })).rejects.toThrow('ps gave an invalid process table');
  });

  it("refuses a call that reaches a native macOS node from a container through Docker's proxy", async () => {
    /* As lsof -Fpn shows such a connection on the Mac: Docker's com.docker.backend, a child of launchd, holds the caller's
       end. Its lineage reaches no pane, and a pid from inside the container names no process of the Mac that holds it. */
    const proxy = 4321;
    const run: Command = async (file, args) => {
      if (file === '/bin/ps') return `    1     0\n ${proxy}     1\n   10     1\n`;
      const only = args.includes('-p') ? Number(args[args.indexOf('-p') + 1]) : null;
      return only === null || only === proxy ? `p${proxy}\nf31\nn127.0.0.1:1->127.0.0.1:2\n` : '';
    };
    const reasons: string[] = [];
    const owner = macOwner(run)(async () => [10]);
    expect(await owner.owns!('agent-1', { port: 1, bridgePort: 2 }, reason => void reasons.push(reason))).toBe(false);
    expect(await owner.owns!('agent-1', { port: 1, bridgePort: 2, pid: 57 }, reason => void reasons.push(reason))).toBe(false);
    expect(reasons).toEqual(["the caller is not under the agent's pane", 'the hinted process does not hold the connection']);
  });

  it('captures ancestry before waiting for a slow pane lookup', async () => {
    let atPane!: () => void;
    const entered = new Promise<void>(resolve => { atPane = resolve; });
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let alive = true;
    const run: Command = async file => {
      if (!alive) throw new Error('caller exited');
      return file === '/bin/ps' ? TABLE : 'p55\nn127.0.0.1:1->127.0.0.1:2\n';
    };
    const check = macOwner(run)(async () => { atPane();await wait;return [10]; });
    const result = check.owns!('agent-1', { port: 1, bridgePort: 2, pid: 55 });
    await entered;
    alive = false;
    release();
    expect(await result).toBe(true);
  });
});
