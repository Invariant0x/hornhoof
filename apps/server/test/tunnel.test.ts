import { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { holdThroughOneEmptyRead, TunnelKeeper, type TunnelSettings } from '../src/modules/link/tunnel.js';
import { until } from './helpers.js';

/* A stand-in for the tunnel client: it writes the token it was started with, its process id and whether it can see the
   keeper's secret, then runs until it is stopped, or ends at once when its token says so. */
const FAKE_CLIENT = `
const [out, token] = process.argv.slice(1);
require('node:fs').appendFileSync(out, [token, process.pid, 'HORNHOOF_SECRET' in process.env].join(' ') + '\\n');
if (token === 'ends') process.exit(3);
setInterval(() => {}, 1000);
`;

type Answer = TunnelSettings | null | undefined;

function tunnel({ program = process.execPath, first = null as Answer } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-tunnel-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'started.txt');
  const lines: string[] = [];
  let answer = first;
  let reads = 0;
  const keeper = new TunnelKeeper({
    read: async () => {
      reads++;
      return answer;
    },
    everyMs: 20,
    restartMs: 30,
    clientFor: (s: TunnelSettings) => {
      if (s.tunnel.token === 'unusable') throw new Error('The tunnel settings name no server.');
      return { program, args: ['-e', FAKE_CLIENT, out, String(s.tunnel.token)] };
    },
    log: line => lines.push(line),
  });
  onTestFinished(() => keeper.stop());
  const answers = (next: Answer) => {
    answer = next;
  };
  const write = (token: string) => answers(settingsWith(token));
  const started = () => completeLines(out).map(l => l.split(' '));
  const alive = (pid: string) => pidAlive(pid);
  const readsFrom = async (count: number) => {
    const from = reads;
    await until(() => reads >= from + count);
  };
  return { keeper, dir, out, answers, write, started, alive, lines, readsFrom };
}

const settingsWith = (token: string): TunnelSettings => ({ url: 'https://acme.hornhoof.test', name: 'acme', key: 'k', tunnel: { token }, mode: 'http' });
const completeLines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(0, -1) : []);
const pidAlive = (pid: string): boolean => {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Not a process id: ${JSON.stringify(pid)}`);
  try {
    process.kill(id, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

describe('the tunnel keeper', () => {
  it('waits while there are no settings, then starts the client with them', async () => {
    const { keeper, write, started, readsFrom } = tunnel();
    keeper.start();
    await readsFrom(3);
    expect(started()).toEqual([]);
    write('first');
    await until(() => started().length === 1);
    expect(started()[0]![0]).toBe('first');
  });

  it('starts the client again with new settings', async () => {
    const { keeper, write, started, alive } = tunnel();
    write('first');
    keeper.start();
    await until(() => started().length === 1);
    const firstPid = started()[0]![1]!;
    write('second');
    await until(() => started().length === 2);
    expect(started()[1]![0]).toBe('second');
    await until(() => !alive(firstPid));
  });

  it('stops it when read answers null', async () => {
    const { keeper, answers, write, started, alive, readsFrom } = tunnel();
    write('first');
    keeper.start();
    await until(() => started().length === 1);
    answers(null);
    await until(() => !alive(started()[0]![1]!));
    await readsFrom(3);
    expect(started()).toHaveLength(1);
  });

  it('tells a running client to stop at the first null read, and says why first', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const kill = vi.spyOn(ChildProcess.prototype, 'kill');
    let wanted = true;
    let started = 0;
    const lines: string[] = [];
    const keeper = new TunnelKeeper({
      read: async () => (wanted ? settingsWith('first') : null),
      everyMs: 20,
      restartMs: 30,
      clientFor: () => (started++, { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      why: () => 'Stopping the public link while this keeper holds no lease or waits after a lease ended.',
      log: line => lines.push(line),
    });
    onTestFinished(async () => {
      await keeper.stop();
      vi.restoreAllMocks();
      vi.useRealTimers();
    });
    keeper.start();
    await until(() => started === 1);

    wanted = false;
    await vi.advanceTimersByTimeAsync(20);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    await until(() => lines.includes('No public link: the tunnel waits.'));
    const whyAt = lines.indexOf('Stopping the public link while this keeper holds no lease or waits after a lease ended.');
    expect(whyAt).toBeGreaterThanOrEqual(0);
    expect(whyAt).toBeLessThan(lines.indexOf('No public link: the tunnel waits.'));
    await keeper.stop();
  });

  it('holds a peer reader through one empty read, and lets a second empty read stop it', async () => {
    const queue: Answer[] = [null, settingsWith('first'), null, undefined, settingsWith('first'), null, null, null];
    let index = 0;
    const read = holdThroughOneEmptyRead(async () => (index < queue.length ? queue[index++] : null));
    expect(await read()).toBeNull();
    expect(await read()).toEqual(settingsWith('first'));
    expect(await read()).toBeUndefined();
    expect(await read()).toBeUndefined();
    expect(await read()).toEqual(settingsWith('first'));
    expect(await read()).toBeUndefined();
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
  });

  it('keeps the client running while read answers undefined', async () => {
    const { keeper, answers, write, started, alive, readsFrom } = tunnel();
    write('first');
    keeper.start();
    await until(() => started().length === 1);
    answers(undefined);
    await readsFrom(5);
    expect(started()).toHaveLength(1);
    expect(alive(started()[0]![1]!)).toBe(true);

    /* The same settings after that are no change, since each start may cost the link up to 40 s. */
    write('first');
    await readsFrom(5);
    expect(started()).toHaveLength(1);
  });

  it('starts nothing while read answers undefined from the start', async () => {
    const { keeper, write, started, readsFrom } = tunnel({ first: undefined });
    keeper.start();
    await readsFrom(3);
    expect(started()).toEqual([]);
    write('first');
    await until(() => started().length === 1);
  });

  it('starts a client that ended again, after a pause', async () => {
    const { keeper, write, started, lines } = tunnel();
    write('ends');
    keeper.start();
    await until(() => started().length >= 3);
    expect(lines.some(l => l.includes('ended'))).toBe(true);
  });

  it('keeps waiting on settings the client cannot use', async () => {
    const { keeper, write, started, lines } = tunnel();
    write('unusable');
    keeper.start();
    await until(() => lines.some(l => l.includes('cannot use')));
    expect(started()).toEqual([]);
    write('first');
    await until(() => started().length === 1);
  });

  it('stops the client when it stops itself', async () => {
    const { keeper, write, started, alive } = tunnel();
    write('first');
    keeper.start();
    await until(() => started().length === 1);
    await keeper.stop();
    expect(alive(started()[0]![1]!)).toBe(false);
  });

  it('waits in stop() for a client that was already told to stop, and says nothing after stop()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-tunnel-ending-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, 'started.txt');
    const termFile = join(dir, 'term.txt');
    const slowClient = `
      const fs = require('node:fs');
      const [out, term] = process.argv.slice(1);
      process.on('SIGTERM', () => fs.writeFileSync(term, '1'));
      process.on('SIGUSR2', () => process.exit(0));
      fs.appendFileSync(out, process.pid + '\\n');
      setInterval(() => {}, 1000);
    `;
    let answer: Answer = settingsWith('first');
    const lines: string[] = [];
    const keeper = new TunnelKeeper({
      read: async () => answer,
      everyMs: 20,
      restartMs: 30,
      clientFor: () => ({ program: process.execPath, args: ['-e', slowClient, out, termFile] }),
      log: line => lines.push(line),
    });
    const pidOf = () => completeLines(out)[0];
    onTestFinished(async () => {
      const pid = pidOf();
      if (pid && pidAlive(pid)) process.kill(Number(pid), 'SIGKILL');
      await keeper.stop();
    });
    keeper.start();
    await until(() => pidOf() !== undefined);
    const pid = pidOf()!;

    answer = null;
    await until(() => existsSync(termFile));

    let stopped = false;
    const stopping = keeper.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(pidAlive(pid)).toBe(true);

    process.kill(Number(pid), 'SIGUSR2');
    await stopping;
    expect(pidAlive(pid)).toBe(false);
    expect(lines).not.toContain('No public link: the tunnel waits.');
  });

  it("kills a client that ignores SIGTERM after 5 s on the test's clock", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = mkdtempSync(join(tmpdir(), 'hh-tunnel-sigkill-'));
    const out = join(dir, 'started.txt');
    const termFile = join(dir, 'term.txt');
    const stubborn = `
      const fs = require('node:fs');
      const [out, term] = process.argv.slice(1);
      process.on('SIGTERM', () => fs.writeFileSync(term, '1'));
      fs.appendFileSync(out, process.pid + '\\n');
      setInterval(() => {}, 1000);
    `;
    const keeper = new TunnelKeeper({
      read: async () => settingsWith('first'),
      everyMs: 1000,
      restartMs: 30,
      clientFor: () => ({ program: process.execPath, args: ['-e', stubborn, out, termFile] }),
      log: () => {},
    });
    const pidOf = () => completeLines(out)[0];
    onTestFinished(() => {
      const pid = pidOf();
      if (pid && pidAlive(pid)) process.kill(Number(pid), 'SIGKILL');
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    });
    keeper.start();
    await until(() => pidOf() !== undefined);
    const pid = pidOf()!;

    const stopping = keeper.stop();
    await until(() => existsSync(termFile));
    expect(pidAlive(pid)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(pidAlive(pid)).toBe(false);
  });

  it('finishes stop() when the client binary could not be started', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
    const dir = mkdtempSync(join(tmpdir(), 'hh-tunnel-missing-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const lines: string[] = [];
    const keeper = new TunnelKeeper({
      read: async () => settingsWith('first'),
      everyMs: 1000,
      restartMs: 30,
      clientFor: () => ({ program: join(dir, 'no-such-frpc'), args: [] }),
      log: line => lines.push(line),
    });
    keeper.start();
    await until(() => lines.some(l => l.includes('did not start')));
    let stopped = false;
    void keeper.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(true);

    let spawned = false;
    const early = new TunnelKeeper({
      read: async () => settingsWith('first'),
      everyMs: 1000,
      restartMs: 30,
      clientFor: () => {
        spawned = true;
        return { program: join(dir, 'no-such-frpc'), args: [] };
      },
      log: () => {},
    });
    early.start();
    await until(() => spawned);
    let earlyStopped = false;
    void early.stop().then(() => {
      earlyStopped = true;
    });
    await until(() => earlyStopped);
  });

  it('reads a started client only from a complete line, and never probes pid 0', () => {
    const { out, started, alive } = tunnel();
    writeFileSync(out, '');
    expect(started()).toEqual([]);
    writeFileSync(out, 'first 42');
    expect(started()).toEqual([]);
    expect(() => alive('')).toThrow('Not a process id');
    expect(() => alive('0')).toThrow('Not a process id');
  });

  it('starts no client for a read that answers after it stopped', async () => {
    let answerNow: (settings: TunnelSettings) => void = () => {};
    const reading = new Promise<TunnelSettings>(resolve => {
      answerNow = resolve;
    });
    const client = vi.fn(() => ({ program: process.execPath, args: ['-e', ''] }));
    const keeper = new TunnelKeeper({ read: () => reading, everyMs: 1000, restartMs: 30, clientFor: client, log: () => {} });
    keeper.start();
    await keeper.stop();
    answerNow(settingsWith('late'));
    /* The late answer has been taken once the event loop has turned, with no clock in it. */
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(client).not.toHaveBeenCalled();
  });

  it('reads once at a time, however long a read takes', async () => {
    let reads = 0;
    let finishRead = () => {};
    const keeper = new TunnelKeeper({
      read: () => {
        reads++;
        return new Promise(resolve => {
          finishRead = () => resolve(null);
        });
      },
      everyMs: 5,
      restartMs: 30,
      clientFor: () => ({ program: process.execPath, args: [] }),
      log: () => {},
    });
    /* The keeper looks again when the test moves its clock: ten looks fall due while the first read still runs. */
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    onTestFinished(() => keeper.stop());
    keeper.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(reads).toBe(1);
    finishRead();
    await vi.advanceTimersByTimeAsync(5);
    expect(reads).toBe(2);
  });

  /* frpc fills in the environment wherever its config says {{ .Envs.NAME }}, and the config carries what the relay gave. */
  it("gives the client none of the keeper's secrets, and finds it by the PATH", async () => {
    vi.stubEnv('HORNHOOF_SECRET', 'not a real secret');
    onTestFinished(() => void vi.unstubAllEnvs());
    const { keeper, write, started } = tunnel({ program: 'node' });
    write('first');
    keeper.start();
    await until(() => started().length === 1);
    expect(started()[0]![2]).toBe('false');
  });
});
