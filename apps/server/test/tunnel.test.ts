import { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
  const started = () => (existsSync(out) ? readFileSync(out, 'utf8').split('\n').slice(0, -1).map(l => l.split(' ')) : []);
  const alive = (pid: string) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };
  const readsFrom = async (count: number) => {
    const from = reads;
    await until(() => reads >= from + count);
  };
  return { keeper, answers, write, started, alive, lines, readsFrom };
}

const settingsWith = (token: string): TunnelSettings => ({ url: 'https://acme.hornhoof.test', name: 'acme', key: 'k', tunnel: { token }, mode: 'http' });

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
