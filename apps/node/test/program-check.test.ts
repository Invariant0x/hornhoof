import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckedInstalls, REINSTALLS, startsCheck, type Repair } from '../src/program-check.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

/* What Claude Code said on node 7e79f787 (0.29.1, Windows in Docker) when npm had left out its platform-native package,
   as Ivan recorded it on 16.11; it ended with code 1. */
const BROKEN = 'Error: claude native binary not installed. Either postinstall did not run ... or the platform-native optional dependency was not downloaded (--omit=optional)';

let dir: string;
let bin: string;
let runs: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hh-program-check-'));
  mkdirSync(join(dir, 'bin'));
  bin = join(dir, 'bin', 'claude');
  runs = join(dir, 'runs');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/* The program as the install left it: it prints its words, counts each start and ends with its code. */
function program(code: number, words: string): void {
  writeFileSync(bin, `#!/bin/sh\necho run >> '${runs}'\necho '${words}' >&2\nexit ${code}\n`);
  chmodSync(bin, 0o755);
}
const broken = () => program(1, BROKEN);
const working = () => program(0, '2.1.0 (Claude Code)');
const started = () => { try { return readFileSync(runs, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

/* An install that leaves the program as given, one shape per install in turn, the last one for every later install. */
function installs(...shapes: (() => void)[]) {
  let n = 0;
  const install = async () => { (shapes[Math.min(n, shapes.length - 1)] ?? working)(); n++; };
  return { install, count: () => n };
}

describe('whether an installed program starts', () => {
  it('checks a root-owned installation without agent runtime settings or node secrets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    for (const [name, value] of Object.entries({
      HOME: dir, TMPDIR: dir, PATH: '/agent-writable/bin',
      NODE_OPTIONS: '--require=/agent-writable/start.cjs', NODE_PATH: dir,
      NODE_KEY: 'private-node-marker', HORNHOOF_SECRET: 'private-server-marker',
    })) vi.stubEnv(name, value);
    let checkedHome = '';
    let settings: { env?: NodeJS.ProcessEnv; cwd?: unknown } = {};
    vi.mocked(spawn).mockImplementationOnce((_bin, _args, options) => {
      settings = { env: options?.env, cwd: options?.cwd };
      checkedHome = options?.env?.HOME ?? '';
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 90001 });
      queueMicrotask(() => child.emit('close', 0, null));
      return child as unknown as ChildProcess;
    });
    expect(await startsCheck(bin)).toEqual({ ok: true });
    expect(settings.env?.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(checkedHome).not.toBe(dir);
    expect(checkedHome.startsWith('/tmp/hh-install-')).toBe(true);
    expect(settings.cwd).toBe(checkedHome);
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_KEY', 'HORNHOOF_SECRET']) expect(settings.env?.[name], name).toBeUndefined();
    expect(existsSync(checkedHome)).toBe(false);
  });

  it('hides a known secret before shortening the diagnostic', async () => {
    const secret = `private-${'s'.repeat(240)}-marker`;
    program(1, `Cannot start with ${secret}`);
    expect(await startsCheck(bin, [secret])).toEqual({ ok: false, code: 1, line: 'Cannot start with [hidden]' });
  });

  it('says the code and the last line of a program that does not start', async () => {
    broken();
    expect(await startsCheck(bin)).toEqual({ ok: false, code: 1, line: BROKEN });
  });

  /* Kimi 2.6.2, exit 0: Operations' Weak point collector on node fd5eff72, relayed by the head on 17.11. */
  it.each([['claude', '2.1.325 (Claude Code)'], ['codex', 'codex-cli 0.169.0'], ['kimi', '2.6.2']])('takes the confirmed %s version response with code 0', async (name, version) => {
    bin = join(dir, 'bin', name);
    program(0, version);
    expect(await startsCheck(bin)).toEqual({ ok: true });
    expect(started()).toBe(1);
  });
});

describe('a program the node installs', () => {
  it('keeps known credentials out of failed checks during both installation and update', async () => {
    const secret = 'private-install-secret';
    const bad = () => program(1, `Cannot start with ${secret}`);
    bad();
    const { install } = installs(bad);
    const said: Repair[] = [];
    const checked = new CheckedInstalls();
    await expect(checked.ensure(bin, install, r => said.push(r), () => [secret])).rejects.toThrow('Cannot start with [hidden]');
    await expect(checked.update(bin, install, r => said.push(r), () => [secret])).rejects.toThrow('Cannot start with [hidden]');
    expect(said.filter(r => r?.state === 'broken')).toEqual([
      { state: 'broken', line: 'Cannot start with [hidden]' }, { state: 'broken', line: 'Cannot start with [hidden]' },
    ]);
    expect(JSON.stringify(said)).not.toContain(secret);
  });

  it('does not reject a program for a version command whose response has not been confirmed', async () => {
    const name = 'unconfirmed-program';
    bin = join(dir, 'bin', name);
    program(1, 'Unknown option: --version');
    const { install, count } = installs(() => program(1, 'Unknown option: --version'));
    const said: Repair[] = [];
    const checked = new CheckedInstalls();
    await checked.ensure(bin, install, r => said.push(r));
    expect(count()).toBe(0);
    await checked.update(bin, install, r => said.push(r));
    expect(count()).toBe(1);
    expect(started()).toBe(0);
    expect(said).toEqual([]);
  });

  it('installs a broken installation again and says so, then goes on with the one that starts', async () => {
    broken();
    const { install, count } = installs(working);
    const said: Repair[] = [];
    await new CheckedInstalls().ensure(bin, install, r => said.push(r));
    expect(count()).toBe(1);
    expect(said).toEqual([{ state: 'reinstalling' }, null]);
  });

  it(`installs it again at most ${REINSTALLS} times, then says why it does not start`, async () => {
    broken();
    const { install, count } = installs(broken);
    const said: Repair[] = [];
    await expect(new CheckedInstalls().ensure(bin, install, r => said.push(r))).rejects.toThrow(BROKEN);
    expect(count()).toBe(REINSTALLS);
    expect(said).toEqual([...Array.from({ length: REINSTALLS }, () => ({ state: 'reinstalling' })), { state: 'broken', line: BROKEN }]);
  });

  it('leaves an installation that starts as it is, and asks it once', async () => {
    working();
    const { install, count } = installs(broken);
    const said: Repair[] = [];
    const checked = new CheckedInstalls();
    await checked.ensure(bin, install, r => said.push(r));
    await checked.ensure(bin, install, r => said.push(r));
    expect(count()).toBe(0);
    expect(started()).toBe(1);
    expect(said).toEqual([]);
  });

  it('checks a first install, and one after an update, the same way', async () => {
    const first = installs(broken, working);
    const said: Repair[] = [];
    const checked = new CheckedInstalls();
    await checked.ensure(bin, first.install, r => said.push(r));
    expect(first.count()).toBe(2);
    expect(said).toEqual([{ state: 'reinstalling' }, null]);

    const update = installs(broken, broken, working);
    said.length = 0;
    await checked.update(bin, update.install, r => said.push(r));
    expect(update.count()).toBe(3);
    expect(said).toEqual([{ state: 'reinstalling' }, { state: 'reinstalling' }, null]);
  });

  it('still installs an update asked for while the first check of the program runs', async () => {
    working();
    const { install, count } = installs(working);
    const checked = new CheckedInstalls();
    await Promise.all([checked.ensure(bin, install, () => {}), checked.update(bin, install, () => {})]);
    expect(count()).toBe(1);
  });

  it('shares one install between two that need the program at once', async () => {
    broken();
    const { install, count } = installs(working);
    const checked = new CheckedInstalls();
    await Promise.all([checked.ensure(bin, install, () => {}), checked.ensure(bin, install, () => {})]);
    expect(count()).toBe(1);
  });
});
