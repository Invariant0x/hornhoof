import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckedInstalls, REINSTALLS, startsCheck, type Repair } from '../src/program-check.js';

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
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
  it('says the code and the last line of a program that does not start', async () => {
    broken();
    expect(await startsCheck(bin)).toEqual({ ok: false, code: 1, line: BROKEN });
  });

  it('takes a program that answers its version with code 0', async () => {
    working();
    expect(await startsCheck(bin)).toEqual({ ok: true });
  });
});

describe('a program the node installs', () => {
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
