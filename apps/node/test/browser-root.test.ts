import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browsersDir, ensureRepoBrowser, prepareBrowser, shareTree, startupBrowserCheck, type CommandRunner } from '../src/browser.js';
import { FIRST_UID } from '../src/isolation.js';

/* No test here runs as root, so ownership is played: on a node that runs as root every file reads as root's but the
   paths named foreign, and an owner changes only on the record. */
const owners = vi.hoisted(() => ({ asRoot: false, foreign: new Set<string>(), otherGroup: new Set<string>(), chowned: [] as string[] }));
const programs = vi.hoisted(() => ({ calls: [] as { bin: string; args: string[]; user: unknown }[], fake: null as null | ((args: string[], env: NodeJS.ProcessEnv) => void) }));

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    lchownSync: (path: string, uid: number, gid: number) => void owners.chowned.push(`${path} ${uid}:${gid}`),
    lstatSync: (path: string, options?: { throwIfNoEntry?: boolean }) => {
      const stat = fs.lstatSync(path, options as { throwIfNoEntry: false });
      if (!stat || !owners.asRoot) return stat;
      return Object.assign(stat, { uid: owners.foreign.has(path) ? FIRST_UID : 0, gid: owners.foreign.has(path) || owners.otherGroup.has(path) ? FIRST_UID : 0 });
    },
  };
});

vi.mock('../src/providers/process.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/providers/process.js')>()),
  runProgram: async ({ bin, args, env, user }: { bin: string; args: string[]; env: NodeJS.ProcessEnv; user?: unknown }) => {
    programs.calls.push({ bin, args, user });
    programs.fake?.(args, env);
    return { code: 0, output: '130.0.1\n', timedOut: false };
  },
}));

const LOCKED = '1.65.0';
const REVISION = '1260';
const FOLDERS = ['chromium-1260', 'chromium_headless_shell-1260', 'ffmpeg-1999'];
const testUser = { uid: FIRST_UID - 1, gid: FIRST_UID - 1 };

const temps: string[] = [];
const temp = (prefix = 'hh-root-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

function playwrightPackage(prefix: string): string {
  const pkg = join(prefix, 'node_modules', 'playwright');
  const core = join(pkg, 'node_modules', 'playwright-core');
  mkdirSync(core, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'playwright', version: LOCKED }));
  writeFileSync(join(pkg, 'cli.js'), '');
  writeFileSync(join(core, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium', revision: REVISION }, { name: 'chromium-headless-shell', revision: REVISION }, { name: 'ffmpeg', revision: '1999' }] }));
  return pkg;
}

function installed(base: string, folders = FOLDERS): void {
  for (const folder of folders) {
    mkdirSync(join(base, folder), { recursive: true });
    writeFileSync(join(base, folder, 'INSTALLATION_COMPLETE'), '');
  }
}

/* A seed every user can read, so its folders are linked. */
function openSeed(): string {
  const seedDir = temp('hh-root-seed-');
  installed(seedDir);
  chmodSync(seedDir, 0o755);
  for (const folder of FOLDERS) {
    chmodSync(join(seedDir, folder), 0o755);
    chmodSync(join(seedDir, folder, 'INSTALLATION_COMPLETE'), 0o644);
  }
  return seedDir;
}

function lockedRepo(): string {
  const repo = temp('hh-root-repo-');
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: LOCKED } } }));
  return repo;
}

/* What npm and Playwright's installer leave, the way they leave it. */
const installs: CommandRunner = async (bin, args, env, user) => {
  programs.calls.push({ bin, args, user });
  programs.fake?.(args, env);
  return { code: 0, output: '', timedOut: false };
};

const leavesWhatItInstalls = (args: string[], env: NodeJS.ProcessEnv) => {
  if (args.includes('--prefix')) playwrightPackage(args[args.indexOf('--prefix') + 1]!);
  else if (args[1] === 'install') installed(env.PLAYWRIGHT_BROWSERS_PATH!);
};

const underBrowsers = (dir: string) => owners.chowned.filter(call => call.startsWith(browsersDir(dir)));

beforeEach(() => {
  owners.asRoot = false;
  owners.foreign.clear();
  owners.otherGroup.clear();
  owners.chowned.length = 0;
  programs.calls.length = 0;
  programs.fake = leavesWhatItInstalls;
});

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('who holds the shared browsers', () => {
  it('never hands them to the user of a test run or an agent, who only checks that Chromium starts', async () => {
    const dir = temp();
    await ensureRepoBrowser(dir, lockedRepo(), testUser);
    expect(underBrowsers(dir)).toEqual([]);
    const npm = programs.calls.find(c => c.bin === 'npm')!;
    const download = programs.calls.find(c => c.args[1] === 'install')!;
    const launch = programs.calls.find(c => c.args[0] === '-e')!;
    expect(npm.user ?? null).toBeNull();
    expect(download.user ?? null).toBeNull();
    expect(launch.user).toEqual(testUser);
  });

  it('keeps to that at the start of a node too, with the package the workspace names', async () => {
    const dir = temp();
    const clone = join(dir, 'work', 'agents', 'agent-1', 'shop');
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(clone, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: LOCKED } } }));
    expect(await startupBrowserCheck(dir, testUser)).toBeNull();
    expect(underBrowsers(dir)).toEqual([]);
    expect(programs.calls.filter(c => c.args[0] !== '-e').map(c => c.user ?? null)).toEqual([null, null]);
    expect(programs.calls.find(c => c.args[0] === '-e')!.user).toEqual(testUser);
  });

  it('gives all it installed to root on a node that runs as root, with nobody else as owner', async () => {
    const dir = temp();
    const madeBy = (args: string[], env: NodeJS.ProcessEnv) => {
      leavesWhatItInstalls(args, env);
      if (args.includes('--prefix')) owners.foreign.add(join(args[args.indexOf('--prefix') + 1]!, 'node_modules', 'playwright', 'cli.js'));
      else owners.foreign.add(join(env.PLAYWRIGHT_BROWSERS_PATH!, 'chromium-1260'));
    };
    programs.fake = madeBy;
    owners.asRoot = true;
    const done = await prepareBrowser({ dir, repoDir: lockedRepo(), seedDir: temp('hh-root-seed-'), globalPlaywrightDir: temp('hh-root-global-'), isRoot: true, runCommand: installs });
    expect(done).toMatchObject({ status: 'ready', downloaded: true });
    const target = browsersDir(dir);
    expect(owners.chowned).toEqual(expect.arrayContaining([`${join(target, '.playwright', LOCKED, 'node_modules', 'playwright', 'cli.js')} 0:0`, `${join(target, 'chromium-1260')} 0:0`]));
    expect(owners.chowned.every(call => call.endsWith(' 0:0'))).toBe(true);
    expect(programs.calls.map(c => c.user ?? null)).toEqual([null, null]);
  });

  it('runs nothing of a repository as root: the package comes from its own cache even when the repository holds the same version', async () => {
    const dir = temp();
    const repo = lockedRepo();
    playwrightPackage(repo);
    owners.asRoot = true;
    const done = await prepareBrowser({ dir, repoDir: repo, seedDir: temp('hh-root-seed-'), globalPlaywrightDir: temp('hh-root-global-'), isRoot: true, runCommand: installs });
    const cached = join(browsersDir(dir), '.playwright', LOCKED, 'node_modules', 'playwright');
    expect(done).toEqual({ status: 'ready', version: LOCKED, playwrightDir: cached, downloaded: true });
    expect(programs.calls.map(c => c.args[1] === 'install' ? c.args[0] : c.bin)).toEqual(['npm', join(cached, 'cli.js')]);
  });

  it("takes the image's package over the repository's on a node that runs as root", async () => {
    const dir = temp();
    const repo = lockedRepo();
    playwrightPackage(repo);
    const global = playwrightPackage(temp('hh-root-global-'));
    owners.asRoot = true;
    const done = await prepareBrowser({ dir, repoDir: repo, seedDir: temp('hh-root-seed-'), globalPlaywrightDir: global, isRoot: true, runCommand: installs });
    expect(done).toMatchObject({ status: 'ready', playwrightDir: global });
    expect(programs.calls.map(c => c.args[0])).toEqual([join(global, 'cli.js')]);
  });

  it('takes a package of the repository where no root is at stake, as a node of its own user runs everything as that user', async () => {
    const dir = temp();
    const repo = lockedRepo();
    const own = playwrightPackage(repo);
    const done = await prepareBrowser({ dir, repoDir: repo, seedDir: temp('hh-root-seed-'), globalPlaywrightDir: temp('hh-root-global-'), isRoot: false, runCommand: installs });
    expect(done).toMatchObject({ status: 'ready', playwrightDir: own });
  });
});

describe('what a node that runs as root does not trust', () => {
  const ready = (dir: string, seedDir: string, globalPlaywrightDir: string) =>
    prepareBrowser({ dir, repoDir: lockedRepo(), seedDir, globalPlaywrightDir, isRoot: true, runCommand: installs });

  it('installs a cached package again when any of it is not root\'s, instead of making it root\'s', async () => {
    const dir = temp();
    const prefix = join(browsersDir(dir), '.playwright', LOCKED);
    const cli = join(playwrightPackage(prefix), 'cli.js');
    writeFileSync(cli, 'planted');
    owners.asRoot = true;
    owners.foreign.add(cli);
    const seedDir = temp('hh-root-seed-');
    installed(seedDir);
    /* What npm writes is root's. */
    programs.fake = (args, env) => {
      owners.foreign.clear();
      leavesWhatItInstalls(args, env);
    };
    await ready(dir, seedDir, temp('hh-root-global-'));
    expect(programs.calls.map(c => c.bin)).toEqual(['npm']);
    expect(readFileSync(cli, 'utf8')).toBe('');
    expect(underBrowsers(dir).filter(call => call.startsWith(cli))).toEqual([]);
  });

  it('keeps a cached package that is all root\'s, and installs nothing', async () => {
    const dir = temp();
    const pkg = playwrightPackage(join(browsersDir(dir), '.playwright', LOCKED));
    const seedDir = temp('hh-root-seed-');
    installed(seedDir);
    owners.asRoot = true;
    await expect(ready(dir, seedDir, temp('hh-root-global-'))).resolves.toEqual({ status: 'ready', version: LOCKED, playwrightDir: pkg, downloaded: false });
    expect(programs.calls).toEqual([]);
  });

  it.each([['owner', owners.foreign], ['group', owners.otherGroup]])('drops a browser folder with a file of another %s, and takes it from the image again', async (_, marks) => {
    const dir = temp();
    const target = browsersDir(dir);
    installed(target, ['chromium-1260']);
    writeFileSync(join(target, 'chromium-1260', 'chrome'), 'planted');
    const global = playwrightPackage(temp('hh-root-global-'));
    const seedDir = openSeed();
    owners.asRoot = true;
    marks.add(join(target, 'chromium-1260', 'chrome'));
    await ready(dir, seedDir, global);
    expect(lstatSync(join(target, 'chromium-1260')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(target, 'chromium-1260', 'chrome'))).toBe(false);
    expect(underBrowsers(dir).filter(call => call.includes('chrome'))).toEqual([]);
  });

  it('drops a link to the image that is not root\'s, as anyone else could have left it there', async () => {
    const dir = temp();
    const target = browsersDir(dir);
    mkdirSync(target, { recursive: true });
    const seedDir = openSeed();
    const link = join(target, 'chromium-1260');
    symlinkSync(join(seedDir, 'chromium-1260'), link);
    owners.asRoot = true;
    owners.foreign.add(link);
    await ready(dir, seedDir, playwrightPackage(temp('hh-root-global-')));
    expect(readlinkSync(link)).toBe(join(seedDir, 'chromium-1260'));
    /* Made anew, by root: the record shows no owner handed on it. */
    expect(underBrowsers(dir).filter(call => call.startsWith(link))).toEqual([]);
  });

  it('takes the shared folder itself back from whoever holds it', () => {
    const dir = temp();
    const target = browsersDir(dir);
    installed(target, ['chromium-1260']);
    owners.asRoot = true;
    owners.foreign.add(target);
    shareTree(target, true);
    expect(owners.chowned).toEqual([`${target} 0:0`]);
  });

  it('asks for no owner at all on a node that does not run as root', () => {
    const dir = temp();
    const target = browsersDir(dir);
    installed(target, ['chromium-1260']);
    shareTree(target, false);
    expect(owners.chowned).toEqual([]);
  });
});
