import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { TunnelKeeper, type TunnelSettings } from '../src/modules/link/tunnel.js';
import { until } from './helpers-basic.js';

/* A stand-in for the tunnel client: it writes the token it was started with and its process id, then runs until it is
   stopped, or ends at once when its token says so. */
const FAKE_CLIENT = `
const [out, token] = process.argv.slice(1);
require('node:fs').appendFileSync(out, token + ' ' + process.pid + '\\n');
if (token === 'ends') process.exit(3);
setInterval(() => {}, 1000);
`;

function tunnel() {
  const dir = mkdtempSync(join(tmpdir(), 'hh-tunnel-'));
  const file = join(dir, 'tunnel.json');
  const out = join(dir, 'started.txt');
  const lines: string[] = [];
  const keeper = new TunnelKeeper({
    file,
    everyMs: 20,
    restartMs: 30,
    clientFor: (s: TunnelSettings) => {
      if (s.tunnel.token === 'unusable') throw new Error('The tunnel settings name no server.');
      return { program: process.execPath, args: ['-e', FAKE_CLIENT, out, String(s.tunnel.token)] };
    },
    log: line => lines.push(line),
  });
  onTestFinished(() => keeper.stop());
  const write = (token: string) => writeFileSync(file, JSON.stringify({ url: 'https://acme.hornhoof.test', name: 'acme', key: 'k', tunnel: { token } }));
  const started = () => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').map(l => l.split(' ')) : []);
  const alive = (pid: string) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };
  return { keeper, file, write, started, alive, lines };
}

describe('the tunnel container', () => {
  it('waits while there are no settings, then starts the client with them', async () => {
    const { keeper, write, started } = tunnel();
    keeper.start();
    await new Promise(r => setTimeout(r, 100));
    expect(started()).toEqual([]);
    write('first');
    await until(() => started().length === 1);
    expect(started()[0]![0]).toBe('first');
  });

  it('starts the client again with new settings, and stops it when they go', async () => {
    const { keeper, file, write, started, alive } = tunnel();
    write('first');
    keeper.start();
    await until(() => started().length === 1);
    const firstPid = started()[0]![1]!;
    write('second');
    await until(() => started().length === 2);
    expect(started()[1]![0]).toBe('second');
    await until(() => !alive(firstPid));
    const secondPid = started()[1]![1]!;
    rmSync(file);
    await until(() => !alive(secondPid));
    await new Promise(r => setTimeout(r, 100));
    expect(started()).toHaveLength(2);
  });

  it('starts a client that ended again, after a pause', async () => {
    const { keeper, write, started, lines } = tunnel();
    write('ends');
    keeper.start();
    await until(() => started().length >= 3);
    expect(lines.some(l => l.includes('ended'))).toBe(true);
  });

  it('keeps waiting on settings it cannot read', async () => {
    const { keeper, file, write, started, lines } = tunnel();
    writeFileSync(file, '{not json');
    keeper.start();
    await until(() => lines.some(l => l.includes('cannot read')));
    expect(started()).toEqual([]);
    write('first');
    await until(() => started().length === 1);
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
});
