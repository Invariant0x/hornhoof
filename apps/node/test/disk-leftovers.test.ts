import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEFTOVER_GRACE_MS, LEFTOVER_IDLE_MS, OWNER_FILE, removalRights, removeAs, testLeftovers, type Remover } from '../src/disk/leftovers.js';

const MINUTE = 60_000;
const uid = process.getuid?.() ?? 0;
const clock = Date.now();

type Fake = { pid: number; cmdline?: string[]; cwd?: string; fds?: string[]; start?: string; exe?: string };
let root: string, tmp: string, proc: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hh-leftovers-test-'));
  tmp = join(root, 'tmp'); proc = join(root, 'proc');
  mkdirSync(tmp); mkdirSync(proc);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/* A /proc with just these processes: the command line, the folder it works in, what it has open and when it began. */
function processes(...list: Fake[]): void {
  for (const { pid, cmdline = ['node'], cwd, fds = [], start = '100', exe } of list) {
    const dir = join(proc, String(pid));
    mkdirSync(join(dir, 'fd'), { recursive: true });
    writeFileSync(join(dir, 'cmdline'), cmdline.join('\0') + '\0');
    writeFileSync(join(dir, 'environ'), '');
    writeFileSync(join(dir, 'stat'), `${pid} (node) S 1 1 1 0 0 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0`);
    if (cwd) symlinkSync(cwd, join(dir, 'cwd'));
    if (exe) symlinkSync(exe, join(dir, 'exe'));
    fds.forEach((target, i) => symlinkSync(target, join(dir, 'fd', String(i))));
  }
}

/* A folder a test helper made, as old as asked, with something in it. */
function folder(name: string, ageMs: number, owner?: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, 'inner'), { recursive: true });
  writeFileSync(join(dir, 'migrated.tar'), Buffer.alloc(64 * 1024, 1));
  writeFileSync(join(dir, 'inner', 'x'), 'x');
  if (owner !== undefined) writeFileSync(join(dir, OWNER_FILE), owner);
  const at = new Date(clock - ageMs);
  utimesSync(dir, at, at);
  return dir;
}

const cleaner = (options: { checking?: boolean; owners?: number[]; remove?: Remover } = {}) =>
  testLeftovers({ tmp, owners: options.owners ?? [uid], checking: () => options.checking ?? false, proc, now: () => clock, ...(options.remove ? { remove: options.remove } : {}) });
const HOUR = 60 * MINUTE;

describe('the leftovers of test runs in the temporary folder', () => {
  it('removes the folders the test helpers make once nothing owns or holds them, and says how much it freed', async () => {
    processes({ pid: 10 });
    const names = ['hh-test-db-AbCd12', 'hh-test-initdb-aBcD34', 'hh-installs-Zz9Yy8', 'hh-migrations-q1W2e3', 'drz-6h0q6K'];
    const dirs = names.map(name => folder(name, HOUR));
    const freed = await cleaner().clean();
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
    expect(freed).toBeGreaterThanOrEqual(names.length * 64 * 1024);
  });

  it('counts what it would take without taking it', async () => {
    processes({ pid: 10 });
    const dir = folder('hh-test-db-AbCd12', HOUR);
    folder('keep-me-AbCd12', HOUR);
    expect(await cleaner().size()).toBeGreaterThanOrEqual(64 * 1024);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps what the helpers did not make: other names, plain files, and links, with what they point to', async () => {
    processes({ pid: 10 });
    const other = folder('keep-me-AbCd12', HOUR);
    const noSuffix = folder('hh-test-db', HOUR);
    const longSuffix = folder('hh-test-db-AbCd12Ef', HOUR);
    const dotted = folder('hh-test-db-AbCd12.old', HOUR);
    writeFileSync(join(tmp, 'hh-test-db-File12'), 'a file');
    const target = join(root, 'precious');
    mkdirSync(target); writeFileSync(join(target, 'data'), 'keep');
    symlinkSync(target, join(tmp, 'hh-test-db-LnK123'));
    await cleaner().clean();
    for (const dir of [other, noSuffix, longSuffix, dotted, join(tmp, 'hh-test-db-File12'), join(tmp, 'hh-test-db-LnK123'), join(target, 'data')]) expect(existsSync(dir)).toBe(true);
  });

  it('removes a folder that holds a link without following it', async () => {
    processes({ pid: 10 });
    const target = join(root, 'precious');
    mkdirSync(target); writeFileSync(join(target, 'data'), 'keep');
    const dir = folder('hh-installs-AbCd12', HOUR);
    symlinkSync(target, join(dir, 'inner', 'link'));
    await cleaner().clean();
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(target, 'data'), 'utf8')).toBe('keep');
  });

  it('keeps what the users of the node do not own', async () => {
    processes({ pid: 10 });
    const dir = folder('hh-test-db-AbCd12', HOUR);
    await cleaner({ owners: [uid + 4242] }).clean();
    expect(existsSync(dir)).toBe(true);
    await cleaner({ owners: [uid + 4242, uid] }).clean();
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps a young folder with no owner for a while, for its helper may not have written its owner yet', async () => {
    processes({ pid: 10 });
    const young = folder('hh-test-db-AbCd12', LEFTOVER_GRACE_MS - MINUTE);
    const grown = folder('hh-test-initdb-AbCd12', LEFTOVER_GRACE_MS + MINUTE);
    await cleaner().clean();
    expect(existsSync(young)).toBe(true);
    expect(existsSync(grown)).toBe(false);
  });
});

describe('the owner a helper writes in its folder', () => {
  it('keeps a folder whose owner is still the process that began it, however old, and removes it once it is gone', async () => {
    processes({ pid: 4242, start: '777' });
    const dir = folder('hh-test-db-AbCd12', 30 * HOUR, '4242 777');
    await cleaner({ checking: false }).clean();
    expect(existsSync(dir)).toBe(true);
    rmSync(join(proc, '4242'), { recursive: true });
    await cleaner().clean();
    expect(existsSync(dir)).toBe(false);
  });

  it('removes a folder at once, though young, when its owner has gone', async () => {
    processes({ pid: 10 });
    const dir = folder('hh-test-db-AbCd12', MINUTE, '4242 777');
    await cleaner().clean();
    expect(existsSync(dir)).toBe(false);
  });

  it('does not take another process for the owner when its number was taken again', async () => {
    processes({ pid: 4242, start: '999' });
    const dir = folder('hh-test-db-AbCd12', HOUR, '4242 777');
    await cleaner().clean();
    expect(existsSync(dir)).toBe(false);
  });

  it('knows the owner by its number alone where the machine says no start', async () => {
    processes({ pid: 4242 });
    const dir = folder('hh-test-db-AbCd12', HOUR, '4242');
    await cleaner().clean();
    expect(existsSync(dir)).toBe(true);
  });

  it.each(['', 'nonsense', '0 5', '-3 5', '12x 5', '99999999999999999999 1'])('treats an owner it cannot read, %j, as none', async owner => {
    processes({ pid: 10 });
    const dir = folder('hh-test-db-AbCd12', HOUR, owner);
    await cleaner().clean();
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps a folder with no readable owner while it is young', async () => {
    processes({ pid: 10 });
    const dir = folder('hh-test-db-AbCd12', MINUTE, 'nonsense');
    await cleaner().clean();
    expect(existsSync(dir)).toBe(true);
  });
});

/* The ways a live process holds a folder. */
const HOLDERS: [string, (dir: string) => Fake][] = [
  ['works in it', dir => ({ pid: 20, cwd: join(dir, 'inner') })],
  ['has a file of it open', dir => ({ pid: 20, fds: [join(dir, 'migrated.tar')] })],
  ['has the folder itself open', dir => ({ pid: 20, fds: [dir] })],
  ['runs a program from it', dir => ({ pid: 20, exe: join(dir, 'inner', 'x') })],
  ['names it in its command line', dir => ({ pid: 20, cmdline: ['node', 'run', `--data=${dir}/migrated.tar`] })],
];

describe('a folder a live process holds', () => {
  it.each(HOLDERS)('stays, as a process that %s', async (_how, make) => {
    const dir = folder('hh-test-db-AbCd12', HOUR);
    processes({ pid: 10 }, make(dir));
    await cleaner().clean();
    expect(existsSync(dir)).toBe(true);
    rmSync(join(proc, '20'), { recursive: true });
    await cleaner().clean();
    expect(existsSync(dir)).toBe(false);
  });

  /* A worker of a test run whose main process was killed still reads the database its main process made. */
  it.each(HOLDERS)('stays though its owner has gone, as a process that %s', async (_how, make) => {
    const dir = folder('hh-test-db-AbCd12', HOUR, '4242 777');
    processes({ pid: 10 }, make(dir));
    await cleaner({ checking: true }).clean();
    expect(existsSync(dir)).toBe(true);
    rmSync(join(proc, '20'), { recursive: true });
    await cleaner({ checking: true }).clean();
    expect(existsSync(dir)).toBe(false);
  });

  it('is not held by a process that works in a folder next to it with a name that starts the same', async () => {
    const dir = folder('hh-test-db-AbCd12', HOUR);
    processes({ pid: 10 }, { pid: 20, cwd: `${dir}-other`, fds: [`${dir}x/file`] });
    mkdirSync(`${dir}-other`);
    await cleaner().clean();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('a folder with no owner while a test run may be live', () => {
  it('stays while a check runs on the node or a test runner is a process of the machine, unless it is very old', async () => {
    const dir = folder('hh-test-db-AbCd12', HOUR);
    processes({ pid: 10 });
    await cleaner({ checking: true }).clean();
    expect(existsSync(dir)).toBe(true);
    rmSync(join(proc, '10'), { recursive: true });
    processes({ pid: 11, cmdline: ['node', '/work/hornhoof/node_modules/vitest/vitest.mjs', 'run'] });
    await cleaner().clean();
    expect(existsSync(dir)).toBe(true);
    const old = folder('hh-test-initdb-AbCd12', LEFTOVER_IDLE_MS + MINUTE);
    await cleaner({ checking: true }).clean();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('goes once no run is live', async () => {
    const dir = folder('hh-test-db-AbCd12', HOUR);
    processes({ pid: 10 });
    await cleaner({ checking: false }).clean();
    expect(existsSync(dir)).toBe(false);
  });

  it('does not take a test runner of the machine for a reason to keep a folder whose owner is gone', async () => {
    const dir = folder('hh-test-db-AbCd12', HOUR, '4242 777');
    processes({ pid: 11, cmdline: ['node', 'vitest', 'run'] });
    await cleaner({ checking: true }).clean();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('a folder whose owner has gone while a process of the users cannot be read', () => {
  it('stays while a run may be live, unless it is very old, and goes once none is', async () => {
    const dir = folder('hh-test-db-AbCd12', HOUR, '4242 777');
    const old = folder('hh-test-initdb-AbCd12', LEFTOVER_IDLE_MS + MINUTE, '4242 777');
    processes({ pid: 10 });
    /* What it has open cannot be listed, so what it holds is not known. */
    rmSync(join(proc, '10', 'fd'), { recursive: true });
    await cleaner({ checking: true }).clean();
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(old)).toBe(false);
    await cleaner({ checking: false }).clean();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('the rights a folder is removed with', () => {
  it('hands each folder to the removal with the user and group that own it, not the node\'s own rights', async () => {
    processes({ pid: 10 });
    const dir = folder('hh-test-db-AbCd12', HOUR);
    const { uid: owner, gid } = lstatSync(dir);
    const asked: [string, { uid: number; gid: number }][] = [];
    const freed = await cleaner({ remove: async (path, as) => { asked.push([path, as]); return true; } }).clean();
    expect(asked).toEqual([[dir, { uid: owner, gid }]]);
    expect(existsSync(dir)).toBe(true);
    expect(freed).toBeGreaterThanOrEqual(64 * 1024);
  });

  it('frees nothing when the removal fails', async () => {
    processes({ pid: 10 });
    const dir = folder('hh-test-db-AbCd12', HOUR);
    expect(await cleaner({ remove: async () => false }).clean()).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  /* The owner of a folder swaps its folders for links to elsewhere, again and again, while the removal walks it. */
  const SWAP = `const { renameSync, symlinkSync, unlinkSync } = require('node:fs');
const [tree, victim, count] = process.argv.slice(1);
for (;;) for (let i = 0; i < Number(count); i++) {
  const d = tree + '/d' + i, x = tree + '/x' + i;
  try { renameSync(d, x); symlinkSync(victim, d); unlinkSync(d); renameSync(x, d); } catch { try { renameSync(x, d); } catch {} }
}`;

  it('removes nothing outside a folder whose owner swaps a folder in it for a link while it goes', async () => {
    processes({ pid: 10 });
    const victim = join(root, 'precious');
    mkdirSync(victim);
    for (let i = 0; i < 50; i++) writeFileSync(join(victim, `f${i}`), 'keep');
    for (let round = 0; round < 20; round++) {
      const tree = join(tmp, `hh-test-db-Swp${String(round).padStart(3, '0')}`);
      for (let d = 0; d < 40; d++) {
        mkdirSync(join(tree, `d${d}`), { recursive: true });
        for (let i = 0; i < 10; i++) writeFileSync(join(tree, `d${d}`, `f${i}`), 'x');
      }
      writeFileSync(join(tree, OWNER_FILE), '4242 777');
      const swapper = spawn(process.execPath, ['-e', SWAP, tree, victim, '40'], { stdio: 'ignore' });
      await new Promise(resolve => setTimeout(resolve, 50));
      await cleaner().clean();
      swapper.kill('SIGKILL');
      await new Promise(resolve => swapper.once('exit', resolve));
      rmSync(tree, { recursive: true, force: true });
      expect(readdirSync(victim)).toHaveLength(50);
    }
  }, 60_000);

  it('runs the removal as the owner wherever the owner is not the node itself', () => {
    expect(removalRights({ uid: 20001, gid: 20001 }, 0)).toEqual({ uid: 20001, gid: 20001 });
    expect(removalRights({ uid: 1000, gid: 1000 }, 1000)).toEqual({});
    expect(removalRights({ uid: 0, gid: 0 }, 0)).toEqual({});
    expect(removalRights({ uid: 20001, gid: 20001 }, 1000)).toEqual({ uid: 20001, gid: 20001 });
  });

  it('removes a folder of the node\'s own user, links inside it without what they point to', async () => {
    const target = join(root, 'precious');
    mkdirSync(target); writeFileSync(join(target, 'data'), 'keep');
    const dir = folder('hh-installs-AbCd12', HOUR);
    symlinkSync(target, join(dir, 'inner', 'link'));
    expect(await removeAs(dir, { uid, gid: lstatSync(dir).gid })).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(target, 'data'), 'utf8')).toBe('keep');
  });

  it.runIf(uid !== 0)('removes nothing where the node may not take the owner\'s rights', async () => {
    const dir = folder('hh-test-db-AbCd12', HOUR);
    expect(await removeAs(dir, { uid: uid + 4242, gid: uid + 4242 })).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it.runIf(uid === 0)('as root, leaves inside another user\'s folder what that user may not remove', async () => {
    const other = 20_000 + 4242;
    const dir = folder('hh-test-db-AbCd12', HOUR);
    chmodSync(root, 0o755); chmodSync(tmp, 0o1777);
    chownSync(dir, other, other); chownSync(join(dir, 'inner'), other, other); chownSync(join(dir, 'inner', 'x'), other, other);
    const theirs = join(dir, 'roots');
    mkdirSync(theirs, { mode: 0o700 }); writeFileSync(join(theirs, 'data'), 'keep');
    expect(await removeAs(dir, { uid: other, gid: other })).toBe(false);
    expect(readFileSync(join(theirs, 'data'), 'utf8')).toBe('keep');
    expect(existsSync(join(dir, 'inner'))).toBe(false);
  });
});

describe('a node that cannot look', () => {
  it('removes nothing where it cannot read the processes, for a folder may be held', async () => {
    const dir = folder('hh-test-db-AbCd12', HOUR);
    rmSync(proc, { recursive: true });
    expect(await cleaner().clean()).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('counts none and removes none where the temporary folder is not there', async () => {
    processes({ pid: 10 });
    rmSync(tmp, { recursive: true });
    expect(await cleaner().size()).toBe(0);
    expect(await cleaner().clean()).toBe(0);
  });
});
