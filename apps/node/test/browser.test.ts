import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  browserEnv,
  browsersDir,
  ensureRepoBrowser,
  playwrightVersionIn,
  prepareAndVerifyBrowser,
  prepareBrowser,
  readBrowserError,
  startupBrowserCheck,
  summarizeBrowserError,
  verifyBrowser,
  writeBrowserError,
} from '../src/browser.js';
import { CheckClient } from '../src/check-client.js';
import { setCheckClient, withCheckSlot } from '../src/check-queue.js';
import { FIRST_UID } from '../src/isolation.js';
import * as programs from '../src/providers/process.js';
import { eventually } from '../../../test-support/eventually.mjs';

/* Playwright's browsers stand in for themselves only in the tests of preparing them; elsewhere they are ready at once. */
const browsersReady = async () => ({ ok: true as const, status: 'not_needed' as const });

const tempDirs: string[] = [];
const realRunProgram = programs.runProgram;

function makeTemp(prefix = 'hh-browser-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function startupToolsOnPath(missing?: string): string {
  const bin = makeTemp('hh-startup-tools-');
  for (const name of ['unzip', 'zip', 'gh', 'shellcheck', 'time', 'strings', 'patch', 'ss', 'objdump']) {
    if (name === missing) continue;
    writeFileSync(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$*" > "$0.args"\necho "fixture version 1"\n', { mode: 0o755 });
  }
  vi.spyOn(programs, 'runProgram').mockImplementation(options => realRunProgram({
    ...options, bin: options.bin === '/usr/bin/time' ? join(bin, 'time') : options.bin,
  }));
  vi.stubEnv('PATH', bin);
  return bin;
}

function unzipOnPath(body: string): string {
  const bin = startupToolsOnPath();
  const executable = join(bin, 'unzip');
  writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$*" > "$0.args"\n' + body + '\n', { mode: 0o755 });
  return executable + '.args';
}

function fakePlaywrightPackage(root: string, version: string, rev: string, engines: string[] = []): string {
  const pkgDir = join(root, 'node_modules', 'playwright');
  const coreDir = join(pkgDir, 'node_modules', 'playwright-core');
  mkdirSync(coreDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'playwright', version }));
  writeFileSync(join(pkgDir, 'cli.js'), '#!/usr/bin/env node\n');
  writeFileSync(
    join(coreDir, 'browsers.json'),
    JSON.stringify({
      browsers: [
        { name: 'chromium', revision: rev, installByDefault: true },
        { name: 'chromium-headless-shell', revision: rev, installByDefault: true },
        { name: 'ffmpeg', revision: '1013', installByDefault: true },
        ...engines.map(name => ({ name, revision: `${rev}0`, installByDefault: true })),
      ],
    }),
  );
  return pkgDir;
}

function markInstalled(baseDir: string, folders: string[]): void {
  for (const folder of folders) {
    const dir = join(baseDir, folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INSTALLATION_COMPLETE'), '');
    const bin = join(dir, 'run');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o700);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('startup tool readiness', () => {
  it.each(['gh', 'shellcheck', 'time', 'strings', 'patch', 'ss', 'objdump'])('names missing %s before preparing any browsers', async name => {
    startupToolsOnPath(name);
    const dir = makeTemp();
    const error = await startupBrowserCheck(dir, null);
    expect(error).not.toBeNull();
    expect(error).toContain(name === 'time' ? '/usr/bin/time --version' : `${name} --version`);
    expect(error).toContain('ENOENT');
    expect(existsSync(browsersDir(dir))).toBe(false);
  });

  it('checks the complete runtime tool set with the required version arguments', async () => {
    const bin = startupToolsOnPath();
    expect(await startupBrowserCheck(makeTemp(), null, undefined, browsersReady)).toBeNull();
    for (const [name, args] of [
      ['unzip', '-v'], ['zip', '-v'], ['gh', '--version'], ['shellcheck', '--version'], ['time', '--version'],
      ['strings', '--version'], ['patch', '--version'], ['ss', '--version'], ['objdump', '--version'],
    ]) {
      const recorded = join(bin, `${name}.args`);
      expect(existsSync(recorded)).toBe(true);
      expect(readFileSync(recorded, 'utf8').trim()).toBe(args);
    }
  });

  it('bounds a later tool check with the normal timeout and verification user', async () => {
    const bin = startupToolsOnPath();
    const user = { uid: process.getuid!(), gid: process.getgid!() };
    const checked = vi.spyOn(programs, 'runProgram').mockImplementation(options => options.bin === 'ss'
      ? Promise.resolve({ code: null, signal: 'SIGTERM', at: new Date().toISOString(), output: '', timedOut: true })
      : realRunProgram({ ...options, bin: options.bin === '/usr/bin/time' ? join(bin, 'time') : options.bin }));
    expect(await startupBrowserCheck(makeTemp(), user)).toBe('ss --version timed out.');
    expect(checked.mock.calls.find(([options]) => options.bin === 'ss')?.[0]).toMatchObject({ user, timeoutMs: 30_000 });
  });

  it('names a missing zip, which packs what unzip unpacks, before preparing any browsers', async () => {
    startupToolsOnPath('zip');
    const dir = makeTemp();
    const error = await startupBrowserCheck(dir, null, undefined, browsersReady);
    expect(error).toContain('zip -v');
    expect(error).toContain('ENOENT');
    expect(existsSync(browsersDir(dir))).toBe(false);
  });

  it('refuses work when unzip is absent, before preparing any browsers', async () => {
    const dir = makeTemp();
    vi.stubEnv('PATH', makeTemp('hh-no-tools-'));
    const error = await startupBrowserCheck(dir, null);
    expect(error).toContain('unzip');
    expect(error).toContain('ENOENT');
    expect(existsSync(browsersDir(dir))).toBe(false);
  });

  it('refuses work when unzip cannot run successfully and names the failed command', async () => {
    const dir = makeTemp();
    const args = unzipOnPath('echo "unzip binary is broken" >&2\nexit 3');
    const error = await startupBrowserCheck(dir, null);
    expect(error).toContain('unzip -v');
    expect(error).toContain('unzip binary is broken');
    expect(existsSync(args)).toBe(true);
    expect(readFileSync(args, 'utf8').trim()).toBe('-v');
    expect(existsSync(browsersDir(dir))).toBe(false);
  });

  it('reports the exit code when unzip fails without output', async () => {
    unzipOnPath('exit 7');
    const error = await startupBrowserCheck(makeTemp(), null);
    expect(error).toContain('unzip -v');
    expect(error).toContain('code 7');
  });

  it('reports a timed out unzip check as a readiness failure', async () => {
    vi.spyOn(programs, 'runProgram').mockResolvedValue({
      code: null, signal: 'SIGTERM', at: new Date().toISOString(), output: '', timedOut: true,
    });
    const error = await startupBrowserCheck(makeTemp(), null);
    expect(error).toContain('unzip -v');
    expect(error).toContain('timed out');
  });

  it('continues readiness after unzip -v succeeds', async () => {
    const args = unzipOnPath('echo "UnZip 6.00"\nexit 0');
    expect(await startupBrowserCheck(makeTemp(), null, undefined, browsersReady)).toBeNull();
    expect(existsSync(args)).toBe(true);
    expect(readFileSync(args, 'utf8').trim()).toBe('-v');
  });
});

describe('playwrightVersionIn', () => {
  it('reads @playwright/test version from root or workspace entries in package-lock.json', () => {
    const repo = makeTemp();
    writeFileSync(
      join(repo, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'demo' },
          'node_modules/@playwright/test': { version: '1.64.1' },
        },
      }),
    );
    expect(playwrightVersionIn(repo)).toBe('1.64.1');

    const workspaceRepo = makeTemp();
    writeFileSync(
      join(workspaceRepo, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'mono' },
          'apps/web/node_modules/@playwright/test': { version: '1.65.2-beta.1' },
        },
      }),
    );
    expect(playwrightVersionIn(workspaceRepo)).toBe('1.65.2-beta.1');
  });

  it('falls back to playwright, v1 dependencies, pnpm-lock.yaml and yarn.lock, and rejects unsafe strings', () => {
    const v1 = makeTemp();
    writeFileSync(join(v1, 'package-lock.json'), JSON.stringify({ dependencies: { playwright: { version: '1.63.0' } } }));
    expect(playwrightVersionIn(v1)).toBe('1.63.0');

    const pnpm = makeTemp();
    writeFileSync(join(pnpm, 'pnpm-lock.yaml'), "devDependencies:\n  '@playwright/test':\n    specifier: ^1.62.0\n    version: 1.62.1(playwright@1.62.1)\n");
    expect(playwrightVersionIn(pnpm)).toBe('1.62.1');

    const yarn = makeTemp();
    writeFileSync(join(yarn, 'yarn.lock'), '"@playwright/test@^1.61.0":\n  version "1.61.2"\n');
    expect(playwrightVersionIn(yarn)).toBe('1.61.2');

    const unsafe = makeTemp();
    writeFileSync(
      join(unsafe, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '1.0.0; rm -rf /' } } }),
    );
    expect(playwrightVersionIn(unsafe)).toBeNull();

    const primitiveJson = makeTemp();
    writeFileSync(join(primitiveJson, 'package-lock.json'), JSON.stringify('not-an-object'));
    expect(playwrightVersionIn(primitiveJson)).toBeNull();

    const plainYarn = makeTemp();
    writeFileSync(join(plainYarn, 'yarn.lock'), '"vitest@^5.0.0":\n  version "5.0.5"\n');
    expect(playwrightVersionIn(plainYarn)).toBeNull();
    expect(playwrightVersionIn(makeTemp())).toBeNull();
  });
});

describe('prepareBrowser', () => {
  it('cancels a real browser preparation process when its check lease is lost', async () => {
    const dir = makeTemp(), repo = makeTemp(), seedDir = makeTemp();
    const globalPlaywrightDir = fakePlaywrightPackage(makeTemp(), '1.64.1', '1248');
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/playwright': { version: '1.64.1' } } }));
    const started = join(dir, 'started'), stopped = join(dir, 'stopped');
    writeFileSync(join(globalPlaywrightDir, 'cli.js'), `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, String(process.pid)); process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped')); setInterval(() => {}, 1000);`);
    let lease = '';
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') { lease = frame.id; queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 })); }
      return true;
    });
    client.online(true); setCheckClient(client);
    /* The node's grace and its hold run on a clock the test moves. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false, fixturePid = 0, programEnded = false;
    vi.spyOn(programs, 'runProgram').mockImplementation(options => realRunProgram(options).finally(() => { programEnded = true; }));
    const pending = withCheckSlot(() => prepareBrowser({ dir, repoDir: repo, seedDir, globalPlaywrightDir, isRoot: false })).finally(() => { settled = true; });
    void pending.catch(() => {});
    onTestFinished(async () => {
      if (fixturePid) { try { process.kill(-fixturePid, 'SIGKILL'); } catch { /* Already gone. */ } }
      await pending.catch(() => {}); client.stop(); setCheckClient(null);
    });
    onTestFinished(async () => { await vi.runAllTimersAsync(); vi.useRealTimers(); });
    await eventually(() => existsSync(started));
    fixturePid = Number(readFileSync(started, 'utf8'));
    /* Hornhoof ends the lease. */
    client.receive({ type: 'check.state', id: lease, state: 'ended', position: 0 });
    await eventually(() => existsSync(stopped));
    expect(settled).toBe(false);
    /* The program takes no notice of TERM, so it is killed at the end of its grace of 2 s, and the slot is held through
       the cleanup, 5 s after the stop. */
    await vi.advanceTimersByTimeAsync(2000);
    await eventually(() => programEnded);
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending.catch(() => {});
  });

  it('seeds matching revisions from the image seed without downloading and makes binaries readable for job users', async () => {
    const dir = makeTemp();
    const seedDir = makeTemp('hh-seed-');
    const globalRoot = makeTemp('hh-global-');
    const globalPw = fakePlaywrightPackage(globalRoot, '1.64.1', '1248');
    markInstalled(seedDir, ['chromium-1248', 'chromium_headless_shell-1248', 'ffmpeg-1013']);

    const repo = makeTemp('hh-repo-');
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '1.64.1' } } }));

    let calls = 0;
    const first = await prepareBrowser({
      dir,
      repoDir: repo,
      seedDir,
      globalPlaywrightDir: globalPw,
      runCommand: async () => {
        calls++;
        return { code: 0, output: '', timedOut: false };
      },
    });

    expect(first).toEqual({ status: 'ready', version: '1.64.1', playwrightDir: globalPw, downloaded: false });
    expect(calls).toBe(0);
    expect(existsSync(join(browsersDir(dir), 'chromium-1248', 'INSTALLATION_COMPLETE'))).toBe(true);
    expect(statSync(join(browsersDir(dir), 'chromium-1248', 'run')).mode & 0o777).toBe(0o755);
    expect(statSync(join(browsersDir(dir), 'chromium-1248', 'INSTALLATION_COMPLETE')).mode & 0o777).toBe(0o644);
    expect(browserEnv(dir)).toEqual({ PLAYWRIGHT_BROWSERS_PATH: browsersDir(dir), PLAYWRIGHT_SKIP_BROWSER_GC: '1' });

    const second = await prepareBrowser({
      dir,
      repoDir: repo,
      seedDir,
      globalPlaywrightDir: globalPw,
      runCommand: async () => {
        calls++;
        return { code: 0, output: '', timedOut: false };
      },
    });
    expect(second).toEqual({ status: 'ready', version: '1.64.1', playwrightDir: globalPw, downloaded: false });
    expect(calls).toBe(0);
  });

  it('isolates npm and Chromium installers from inherited settings and working directories', async () => {
    const dir = makeTemp();
    const repoDir = makeTemp();
    writeFileSync(join(repoDir, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/playwright': { version: '1.65.0' } } }));
    writeFileSync(join(repoDir, '.npmrc'), 'registry=https://project.invalid/\n');
    vi.stubEnv('HOME', repoDir);
    vi.stubEnv('npm_config_registry', 'https://lower.invalid/');
    vi.stubEnv('NPM_CONFIG_REGISTRY', 'https://upper.invalid/');
    vi.stubEnv('npm_config_userconfig', join(repoDir, '.npmrc'));
    vi.stubEnv('NODE_OPTIONS', '--no-warnings');
    vi.stubEnv('PLAYWRIGHT_DOWNLOAD_HOST', 'https://download.invalid');
    const homes: string[] = [];
    const result = await prepareBrowser({
      dir, repoDir, isRoot: false, seedDir: makeTemp(), globalPlaywrightDir: makeTemp(),
      runCommand: async (bin, args, env, _user, cwd) => {
        homes.push(env.HOME!);
        expect(cwd).toBe(env.HOME);
        expect(env.HOME).not.toBe(repoDir);
        expect(statSync(env.HOME!).mode & 0o777).toBe(0o700);
        expect(env.npm_config_registry).toBeUndefined();
        expect(env.NPM_CONFIG_REGISTRY).toBe('https://registry.npmjs.org/');
        expect(env.npm_config_userconfig).toBeUndefined();
        expect(env.NODE_OPTIONS).toBeUndefined();
        expect(env.PLAYWRIGHT_DOWNLOAD_HOST).toBeUndefined();
        if (bin === 'npm') {
          expect(args).toContain('--ignore-scripts');
          expect(readFileSync(env.NPM_CONFIG_USERCONFIG!, 'utf8')).toBe('');
          expect(readFileSync(env.NPM_CONFIG_GLOBALCONFIG!, 'utf8')).toBe('');
          expect(Object.keys(env).filter(key => /^npm_config_/i.test(key)).sort()).toEqual(['NPM_CONFIG_CACHE', 'NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_WORKSPACES']);
          fakePlaywrightPackage(args[args.indexOf('--prefix') + 1]!, '1.65.0', '1260');
        } else markInstalled(env.PLAYWRIGHT_BROWSERS_PATH!, ['chromium-1260', 'chromium_headless_shell-1260']);
        return { code: 0, output: '', timedOut: false };
      },
    });
    expect(result).toMatchObject({ status: 'ready', downloaded: true });
    expect(homes).toHaveLength(2);
    expect(homes.every(home => !existsSync(home))).toBe(true);
  });

  it('downloads once when a project updates @playwright/test in its lockfile and skips download on repeat runs', async () => {
    const dir = makeTemp();
    const seedDir = makeTemp('hh-seed-');
    const globalRoot = makeTemp('hh-global-');
    const globalPw = fakePlaywrightPackage(globalRoot, '1.64.1', '1248');
    markInstalled(seedDir, ['chromium-1248', 'chromium_headless_shell-1248', 'ffmpeg-1013']);

    const repo = makeTemp('hh-repo-');
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '1.65.0' } } }));

    const invocations: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const runCommand = async (bin: string, args: string[], env: NodeJS.ProcessEnv) => {
      invocations.push({ bin, args, env });
      if (bin === 'npm') {
        const prefix = args[args.indexOf('--prefix') + 1]!;
        fakePlaywrightPackage(prefix, '1.65.0', '1260');
      } else {
        markInstalled(env.PLAYWRIGHT_BROWSERS_PATH!, ['chromium-1260', 'chromium_headless_shell-1260']);
      }
      return { code: 0, output: '', timedOut: false };
    };

    const first = await prepareBrowser({ dir, repoDir: repo, seedDir, globalPlaywrightDir: globalPw, runCommand });
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') throw new Error('expected ready');
    expect(first.version).toBe('1.65.0');
    expect(first.downloaded).toBe(true);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.bin).toBe('npm');
    expect(invocations[0]!.args).toContain('playwright@1.65.0');
    expect(invocations[1]!.args).toEqual([join(first.playwrightDir, 'cli.js'), 'install', 'chromium', 'firefox', 'webkit']);
    expect(invocations[1]!.env.PATH).toBeTruthy();
    expect(invocations[1]!.env.PLAYWRIGHT_BROWSERS_PATH).toBe(browsersDir(dir));
    expect(invocations[1]!.env.PLAYWRIGHT_SKIP_BROWSER_GC).toBe('1');
    /* ffmpeg-1013 was seeded locally from seedDir without re-downloading. */
    expect(existsSync(join(browsersDir(dir), 'ffmpeg-1013', 'INSTALLATION_COMPLETE'))).toBe(true);

    const second = await prepareBrowser({ dir, repoDir: repo, seedDir, globalPlaywrightDir: globalPw, runCommand });
    expect(second).toEqual({ status: 'ready', version: '1.65.0', playwrightDir: first.playwrightDir, downloaded: false });
    expect(invocations).toHaveLength(2);
  });

  it('skips repositories that do not depend on Playwright', async () => {
    const dir = makeTemp();
    const repo = makeTemp('hh-plain-repo-');
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/vitest': { version: '5.0.5' } } }));
    const result = await prepareBrowser({
      dir,
      repoDir: repo,
      runCommand: async () => {
        throw new Error('should not install');
      },
    });
    expect(result).toEqual({ status: 'not_needed' });
  });
});

describe('links in the shared browsers', () => {
  const FOLDERS = ['chromium-1248', 'chromium_headless_shell-1248', 'ffmpeg-1013'];

  /* A seed every user can read, so prepareBrowser links its folders. */
  function worldSeed(): string {
    const seedDir = makeTemp('hh-world-seed-');
    chmodSync(seedDir, 0o755);
    markInstalled(seedDir, FOLDERS);
    for (const folder of FOLDERS) {
      chmodSync(join(seedDir, folder), 0o755);
      chmodSync(join(seedDir, folder, 'run'), 0o755);
      chmodSync(join(seedDir, folder, 'INSTALLATION_COMPLETE'), 0o644);
    }
    return seedDir;
  }

  function lockedRepo(version: string): string {
    const repo = makeTemp('hh-repo-');
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/test': { version } } }));
    return repo;
  }

  function planted(): string {
    const dir = makeTemp('hh-planted-');
    markInstalled(dir, FOLDERS);
    writeFileSync(join(dir, 'evil'), 'planted');
    return dir;
  }

  const gone = (path: string) => lstatSync(path, { throwIfNoEntry: false }) === undefined;

  /* The node as it starts: the image's package at the version the repository locks, the image's browsers. */
  function setUp() {
    const dir = makeTemp();
    const target = browsersDir(dir);
    mkdirSync(target, { recursive: true });
    const seedDir = worldSeed();
    const globalPlaywrightDir = fakePlaywrightPackage(makeTemp('hh-global-'), '1.64.1', '1248');
    const repoDir = lockedRepo('1.64.1');
    const ready = () => prepareBrowser({ dir, repoDir, seedDir, globalPlaywrightDir, isRoot: false, runCommand: async () => { throw new Error('nothing should be installed'); } });
    return { dir, target, seedDir, ready };
  }

  it("keeps the image's own folder where a link leads elsewhere, and drops every other link", async () => {
    const { target, seedDir, ready } = setUp();
    const elsewhere = planted();
    symlinkSync(join(elsewhere, 'chromium-1248'), join(target, 'chromium-1248'));
    symlinkSync(elsewhere, join(target, 'stray'));
    /* Into the seed, but not to the folder of its own name. */
    symlinkSync(join(seedDir, 'ffmpeg-1013'), join(target, 'chromium_headless_shell-1248'));
    await expect(ready()).resolves.toMatchObject({ status: 'ready', downloaded: false });
    expect(readlinkSync(join(target, 'chromium-1248'))).toBe(join(seedDir, 'chromium-1248'));
    expect(readlinkSync(join(target, 'chromium_headless_shell-1248'))).toBe(join(seedDir, 'chromium_headless_shell-1248'));
    expect(gone(join(target, 'stray'))).toBe(true);
    expect(existsSync(join(elsewhere, 'evil'))).toBe(true);
  });

  it("leaves a link of the image's own folder alone", async () => {
    const { target, seedDir, ready } = setUp();
    await ready();
    const before = lstatSync(join(target, 'chromium-1248')).ino;
    await ready();
    expect(lstatSync(join(target, 'chromium-1248')).ino).toBe(before);
    expect(readlinkSync(join(target, 'chromium-1248'))).toBe(join(seedDir, 'chromium-1248'));
  });

  it('drops a browser folder with a link that leads out of it, whichever way the link goes', async () => {
    const { target, seedDir, ready } = setUp();
    const elsewhere = planted();
    markInstalled(target, FOLDERS);
    /* Straight out. */
    symlinkSync(join(elsewhere, 'evil'), join(target, 'chromium-1248', 'chrome'));
    /* Out only once the link inside it is followed: the path alone seems to stay inside. */
    mkdirSync(join(target, 'outside'));
    writeFileSync(join(target, 'outside', 'evil'), 'planted');
    const deep = join(target, 'chromium_headless_shell-1248', 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    symlinkSync('../..', join(deep, 'up'));
    symlinkSync('up/../../outside', join(deep, 'out'));
    /* Leads nowhere. */
    symlinkSync(join(elsewhere, 'gone'), join(target, 'ffmpeg-1013', 'broken'));
    await ready();
    for (const folder of FOLDERS) expect(readlinkSync(join(target, folder))).toBe(join(seedDir, folder));
    expect(existsSync(join(elsewhere, 'evil'))).toBe(true);
  });

  it('takes a folder whose name only starts like this one for another folder', async () => {
    const { target, seedDir, ready } = setUp();
    markInstalled(target, ['chromium-1248']);
    mkdirSync(join(target, 'chromium-1248-other'));
    symlinkSync('../chromium-1248-other', join(target, 'chromium-1248', 'next-door'));
    await ready();
    expect(readlinkSync(join(target, 'chromium-1248'))).toBe(join(seedDir, 'chromium-1248'));
  });

  it('drops every link when the image has no browsers to link to', async () => {
    const { dir, target } = setUp();
    symlinkSync(planted(), join(target, 'chromium-1248'));
    const missingSeed = join(makeTemp('hh-no-seed-'), 'none');
    const globalPlaywrightDir = fakePlaywrightPackage(makeTemp('hh-global-'), '1.64.1', '1248');
    const runCommand = async (_bin: string, _args: string[], env: NodeJS.ProcessEnv) => {
      markInstalled(env.PLAYWRIGHT_BROWSERS_PATH!, FOLDERS);
      return { code: 0, output: '', timedOut: false };
    };
    await expect(prepareBrowser({ dir, repoDir: lockedRepo('1.64.1'), seedDir: missingSeed, globalPlaywrightDir, isRoot: false, runCommand })).resolves.toMatchObject({ status: 'ready', downloaded: true });
    expect(lstatSync(join(target, 'chromium-1248')).isSymbolicLink()).toBe(false);
  });

  it('keeps a browser folder whose links stay inside it, as Chromium for a Mac has them', async () => {
    const { target, ready } = setUp();
    markInstalled(target, FOLDERS);
    mkdirSync(join(target, 'chromium-1248', 'Versions', '130'), { recursive: true });
    writeFileSync(join(target, 'chromium-1248', 'Versions', '130', 'kept'), '');
    symlinkSync('130', join(target, 'chromium-1248', 'Versions', 'Current'));
    await ready();
    expect(lstatSync(join(target, 'chromium-1248')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(target, 'chromium-1248', 'Versions', 'Current', 'kept'))).toBe(true);
  });

  it('drops a link in place of the folder of packages, a link in the npm cache, and a link in place of the shared folder itself', async () => {
    const { dir, target, ready } = setUp();
    const elsewhere = planted();
    symlinkSync(elsewhere, join(target, '.playwright'));
    mkdirSync(join(target, '.npm-cache'));
    symlinkSync(elsewhere, join(target, '.npm-cache', 'out'));
    await ready();
    expect(gone(join(target, '.playwright'))).toBe(true);
    expect(gone(join(target, '.npm-cache'))).toBe(true);

    rmSync(target, { recursive: true });
    symlinkSync(elsewhere, target);
    await ready();
    expect(lstatSync(browsersDir(dir)).isSymbolicLink()).toBe(false);
    expect(readdirSync(elsewhere).sort()).toEqual([...FOLDERS, 'evil'].sort());
  });

  it('installs a cached package again when a link in it leads out, keeps one whose links stay inside, and judges each version by itself', async () => {
    const dir = makeTemp();
    const target = browsersDir(dir);
    const elsewhere = planted();
    const version = (name: string, rev: string) => fakePlaywrightPackage(join(target, '.playwright', name), name, rev);
    const bad = version('1.65.0', '1260');
    const good = version('1.66.0', '1270');
    mkdirSync(join(target, '.playwright', '1.66.0', 'node_modules', '.bin'));
    symlinkSync('../playwright/cli.js', join(target, '.playwright', '1.66.0', 'node_modules', '.bin', 'playwright'));
    symlinkSync(join(elsewhere, 'evil'), join(bad, 'node_modules', 'playwright-core', 'index.js'));

    const npm: string[] = [];
    const runCommand = async (bin: string, args: string[], env: NodeJS.ProcessEnv) => {
      if (bin === 'npm') {
        npm.push(args.at(-1)!);
        fakePlaywrightPackage(args[args.indexOf('--prefix') + 1]!, '1.65.0', '1260');
      } else markInstalled(env.PLAYWRIGHT_BROWSERS_PATH!, ['chromium-1260', 'chromium_headless_shell-1260', 'chromium-1270', 'chromium_headless_shell-1270']);
      return { code: 0, output: '', timedOut: false };
    };
    const options = { dir, seedDir: makeTemp('hh-empty-seed-'), globalPlaywrightDir: makeTemp('hh-global-'), isRoot: false, runCommand };

    await expect(prepareBrowser({ ...options, repoDir: lockedRepo('1.66.0') })).resolves.toMatchObject({ status: 'ready', playwrightDir: good });
    expect(npm).toEqual([]);
    expect(existsSync(bad)).toBe(false);

    const again = await prepareBrowser({ ...options, repoDir: lockedRepo('1.65.0') });
    expect(again).toMatchObject({ status: 'ready', playwrightDir: bad });
    expect(npm).toEqual(['playwright@1.65.0']);
    expect(gone(join(bad, 'node_modules', 'playwright-core', 'index.js'))).toBe(true);
    expect(readFileSync(join(good, 'package.json'), 'utf8')).toContain('1.66.0');
  });

  it('keeps a copy of a restricted seed through the next start, its links as the seed has them', async () => {
    const { dir, target, seedDir } = setUp();
    const restricted = join(seedDir, 'ffmpeg-1013');
    chmodSync(join(restricted, 'INSTALLATION_COMPLETE'), 0o600);
    symlinkSync('run', join(restricted, 'run-link'));
    const globalPlaywrightDir = fakePlaywrightPackage(makeTemp('hh-global-'), '1.64.1', '1248');
    const ready = () => prepareBrowser({ dir, repoDir: lockedRepo('1.64.1'), seedDir, globalPlaywrightDir, isRoot: false });
    await ready();
    expect(lstatSync(join(target, 'ffmpeg-1013')).isSymbolicLink()).toBe(false);
    expect(readlinkSync(join(target, 'ffmpeg-1013', 'run-link'))).toBe('run');
    writeFileSync(join(target, 'ffmpeg-1013', 'kept'), '');
    await ready();
    expect(existsSync(join(target, 'ffmpeg-1013', 'kept'))).toBe(true);
  });
});

/* A Playwright package whose engines start as named: each one with a version, or fails with its words. */
function enginesPackage(engines: Record<string, string | Error>): string {
  const pkgDir = join(makeTemp('hh-engines-'), 'playwright');
  const core = join(pkgDir, 'node_modules', 'playwright-core');
  mkdirSync(core, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.64.1' }));
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.64.1', main: 'index.js' }));
  const body = Object.entries(engines).map(([name, answer]) => answer instanceof Error
    ? `exports.${name} = { launch: async () => { throw new Error(${JSON.stringify(answer.message)}); } };`
    : `exports.${name} = { launch: async options => { if (!options.headless) throw new Error('not headless'); return { version: () => ${JSON.stringify(answer)}, close: async () => {} }; } };`);
  writeFileSync(join(core, 'index.js'), body.join('\n'));
  return pkgDir;
}

const runNode = async (bin: string, args: string[], env: NodeJS.ProcessEnv) => {
  const ran = spawnSync(bin, args, { env, encoding: 'utf8' });
  return { code: ran.status, output: `${ran.stdout}${ran.stderr}`, timedOut: false };
};

describe('the three browser engines', () => {
  it('installs Chromium, Firefox and WebKit where the image brought Chromium only', async () => {
    const dir = makeTemp();
    const seedDir = makeTemp('hh-seed-');
    const globalPw = fakePlaywrightPackage(makeTemp('hh-global-'), '1.64.1', '1248', ['firefox', 'webkit']);
    markInstalled(seedDir, ['chromium-1248', 'chromium_headless_shell-1248', 'ffmpeg-1013']);
    const installs: string[][] = [];
    const res = await prepareBrowser({
      dir, seedDir, globalPlaywrightDir: globalPw,
      runCommand: async (_bin, args, env) => {
        installs.push(args.slice(1));
        markInstalled(env.PLAYWRIGHT_BROWSERS_PATH!, ['firefox-12480', 'webkit-12480']);
        return { code: 0, output: '', timedOut: false };
      },
    });
    expect(res).toMatchObject({ status: 'ready', downloaded: true });
    expect(installs).toEqual([['install', 'chromium', 'firefox', 'webkit']]);

    const again = await prepareBrowser({ dir, seedDir, globalPlaywrightDir: globalPw, runCommand: async () => { throw new Error('no second install'); } });
    expect(again).toMatchObject({ status: 'ready', downloaded: false });
  });

  it('seeds every engine the image brought without a download', async () => {
    const dir = makeTemp();
    const seedDir = makeTemp('hh-seed-');
    const globalPw = fakePlaywrightPackage(makeTemp('hh-global-'), '1.64.1', '1248', ['firefox', 'webkit']);
    markInstalled(seedDir, ['chromium-1248', 'chromium_headless_shell-1248', 'ffmpeg-1013', 'firefox-12480', 'webkit-12480']);
    const res = await prepareBrowser({ dir, seedDir, globalPlaywrightDir: globalPw, runCommand: async () => { throw new Error('no install'); } });
    expect(res).toMatchObject({ status: 'ready', downloaded: false });
    expect(existsSync(join(browsersDir(dir), 'webkit-12480', 'INSTALLATION_COMPLETE'))).toBe(true);
  });

  it('starts each engine headless and names the version of each', async () => {
    const playwrightDir = enginesPackage({ chromium: '130.0.6723.31', firefox: '132.0', webkit: '18.2' });
    expect(await verifyBrowser({ browsersDir: makeTemp(), playwrightDir, runCommand: runNode })).toEqual({ ok: true, browserVersion: 'chromium 130.0.6723.31, firefox 132.0, webkit 18.2' });
  });

  it('names the engine that does not start, and why', async () => {
    const playwrightDir = enginesPackage({ chromium: '130.0.6723.31', firefox: new Error('browserType.launch: Executable doesn\'t exist at /data/browsers/firefox-1466/firefox/firefox'), webkit: '18.2' });
    expect(await verifyBrowser({ browsersDir: makeTemp(), playwrightDir, runCommand: runNode })).toEqual({ ok: false, error: "firefox: Executable doesn't exist at /data/browsers/firefox-1466/firefox/firefox" });
  });
});

describe('verifyBrowser and prepareAndVerifyBrowser', () => {
  it('extracts concise reasons from Playwright launch errors without ASCII box borders', () => {
    const boxed = [
      'browserType.launch: Executable doesn\'t exist at /data/browsers/chromium-1248/chrome-linux64/chrome',
      '╔══════════════════════════════════════════════════════╗',
      '║ Looks like Playwright Test was just installed.       ║',
      '╚══════════════════════════════════════════════════════╝',
    ].join('\n');
    expect(summarizeBrowserError(boxed, 1, false)).toContain("Executable doesn't exist at /data/browsers/chromium-1248");
    expect(summarizeBrowserError(boxed, 1, false)).not.toContain('╔');
    expect(summarizeBrowserError('', null, true)).toBe('Playwright browser launch timed out.');
    expect(summarizeBrowserError('', 127, false)).toBe('Playwright browser check exited with code 127.');
    expect(summarizeBrowserError('\n\nX\n', 1, false)).toBe('X');
    expect(summarizeBrowserError('x'.repeat(300), 1, false)).toHaveLength(240);
  });

  it('picks the Playwright version from an existing agent workspace clone on startup and ensures full Chromium', async () => {
    const dir = makeTemp();
    const agentRepo = join(dir, 'work', 'agents', 'agent-1', 'hornhoof');
    mkdirSync(agentRepo, { recursive: true });
    writeFileSync(join(agentRepo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '1.65.0' } } }));
    const globalPw = fakePlaywrightPackage(makeTemp('hh-global-'), '1.64.1', '1248');
    const partialSeed = makeTemp('hh-partial-seed-');
    markInstalled(partialSeed, ['chromium_headless_shell-1255', 'ffmpeg-1013']);

    const res = await prepareBrowser({
      dir,
      seedDir: partialSeed,
      globalPlaywrightDir: globalPw,
      runCommand: async (_bin, args) => {
        if (args[0] === 'install' && args.includes('playwright@1.65.0')) {
          fakePlaywrightPackage(join(browsersDir(dir), '.playwright', '1.65.0'), '1.65.0', '1255');
          return { code: 0, output: '', timedOut: false };
        }
        markInstalled(browsersDir(dir), ['chromium-1255', 'chromium_headless_shell-1255', 'ffmpeg-1013']);
        return { code: 0, output: '', timedOut: false };
      },
    });
    expect(res).toMatchObject({ status: 'ready', version: '1.65.0', downloaded: true });
  });

  it('returns named results from prepareAndVerifyBrowser across not_needed, ready, verify failure and install failure', async () => {
    const dir = makeTemp();
    const globalRoot = makeTemp('hh-global-');
    const globalPw = fakePlaywrightPackage(globalRoot, '1.64.1', '9999');
    const res = await prepareAndVerifyBrowser({
      dir,
      seedDir: makeTemp('hh-empty-seed-'),
      globalPlaywrightDir: globalPw,
      runCommand: async () => ({ code: 1, output: 'Download failed: server returned code 503', timedOut: false }),
    });
    expect(res).toEqual({ ok: false, error: expect.stringContaining('Download failed: server returned code 503') });

    const plainRepo = makeTemp('hh-plain-');
    writeFileSync(join(plainRepo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/vitest': { version: '5.0.5' } } }));
    expect(await prepareAndVerifyBrowser({ dir: makeTemp(), repoDir: plainRepo })).toEqual({ ok: true, status: 'not_needed' });

    const seededDir = makeTemp();
    const seed = makeTemp('hh-seed-ok-');
    markInstalled(seed, ['chromium-9999', 'chromium_headless_shell-9999', 'ffmpeg-1013']);
    const okRes = await prepareAndVerifyBrowser({
      dir: seededDir,
      seedDir: seed,
      globalPlaywrightDir: globalPw,
      runCommand: async () => ({ code: 0, output: '130.0.6723.31\n', timedOut: false }),
    });
    expect(okRes).toEqual({ ok: true, status: 'ready', version: '1.64.1', browserVersion: '130.0.6723.31', downloaded: false });

    const badVerify = await prepareAndVerifyBrowser({
      dir: seededDir,
      seedDir: seed,
      globalPlaywrightDir: globalPw,
      runCommand: async () => ({ code: 127, output: 'error while loading shared libraries: libgbm.so.1', timedOut: false }),
    });
    expect(badVerify).toEqual({ ok: false, error: 'error while loading shared libraries: libgbm.so.1' });
  });

  it('links world-readable image seeds, copies restricted ones, and replaces incomplete or dangling entries', async () => {
    const dir = makeTemp();
    const seedDir = makeTemp('hh-world-seed-');
    chmodSync(seedDir, 0o755);
    const globalRoot = makeTemp('hh-global-');
    const globalPw = fakePlaywrightPackage(globalRoot, '1.64.1', '1248');
    writeFileSync(
      join(globalPw, 'node_modules', 'playwright-core', 'browsers.json'),
      JSON.stringify({
        browsers: [
          null,
          { name: 123, revision: 456 },
          { name: 'android', revision: '1000' },
          { name: 'chromium', revision: 'not-a-number' },
          { name: 'chromium', revision: '1248' },
          { name: 'chromium-headless-shell', revision: '1248' },
          { name: 'ffmpeg', revision: '1013' },
        ],
      }),
    );
    markInstalled(seedDir, ['chromium-1248', 'chromium_headless_shell-1248', 'ffmpeg-1013']);
    for (const entry of readdirSync(seedDir)) {
      chmodSync(join(seedDir, entry), 0o755);
      chmodSync(join(seedDir, entry, 'run'), 0o755);
      chmodSync(join(seedDir, entry, 'INSTALLATION_COMPLETE'), 0o644);
    }
    symlinkSync('run', join(seedDir, 'chromium-1248', 'run-link'));
    /* Make chromium_headless_shell-1248 have a restricted directory and ffmpeg-1013 a restricted file so those copy instead of symlinking. */
    mkdirSync(join(seedDir, 'chromium_headless_shell-1248', 'priv'), { mode: 0o700 });
    chmodSync(join(seedDir, 'chromium_headless_shell-1248', 'priv'), 0o700);
    chmodSync(join(seedDir, 'ffmpeg-1013', 'INSTALLATION_COMPLETE'), 0o600);

    /* Leave a broken symlink at chromium-1248 and an incomplete folder at chromium_headless_shell-1248. */
    mkdirSync(browsersDir(dir), { recursive: true });
    symlinkSync(join(seedDir, 'gone-chromium-1248'), join(browsersDir(dir), 'chromium-1248'));
    mkdirSync(join(browsersDir(dir), 'chromium_headless_shell-1248', 'partial'), { recursive: true });
    writeFileSync(join(browsersDir(dir), 'chromium_headless_shell-1248', 'partial', 'part.bin'), 'x');

    const repo = makeTemp('hh-repo-');
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '1.64.1' } } }));

    const [res, concurrent] = await Promise.all([
      prepareBrowser({ dir, repoDir: repo, seedDir, globalPlaywrightDir: globalPw }),
      prepareBrowser({ dir, repoDir: repo, seedDir, globalPlaywrightDir: globalPw }),
    ]);
    expect(res).toEqual({ status: 'ready', version: '1.64.1', playwrightDir: globalPw, downloaded: false });
    expect(concurrent).toEqual({ status: 'ready', version: '1.64.1', playwrightDir: globalPw, downloaded: false });
    expect(lstatSync(join(browsersDir(dir), 'chromium-1248')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(browsersDir(dir), 'chromium_headless_shell-1248')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(browsersDir(dir), 'ffmpeg-1013')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(browsersDir(dir), 'chromium-1248', 'INSTALLATION_COMPLETE'))).toBe(true);

    /* Missing browsers.json reports a named error. */
    const brokenPw = makeTemp('hh-broken-pw-');
    mkdirSync(join(brokenPw, 'node_modules', 'playwright'), { recursive: true });
    writeFileSync(join(brokenPw, 'node_modules', 'playwright', 'package.json'), JSON.stringify({ version: '1.64.1' }));
    const missingManifest = await prepareAndVerifyBrowser({
      dir: makeTemp(),
      repoDir: repo,
      globalPlaywrightDir: join(brokenPw, 'node_modules', 'playwright'),
    });
    expect(missingManifest).toEqual({ ok: false, error: expect.stringContaining('No browser revisions listed') });
  });

  it('persists and clears browser-error files and runs startupBrowserCheck / ensureRepoBrowser with passwd setup', async () => {
    unzipOnPath('exit 0');
    const dir = makeTemp('hh-err-state-');
    expect(readBrowserError(dir)).toBeNull();
    writeBrowserError(dir, 'libnss3.so missing');
    expect(readBrowserError(dir)).toBe('libnss3.so missing');
    writeFileSync(join(dir, 'browser-error'), '   \n');
    expect(readBrowserError(dir)).toBeNull();
    writeBrowserError(dir, 'broken again');
    writeBrowserError(dir, null);
    expect(readBrowserError(dir)).toBeNull();

    const plainRepo = makeTemp('hh-plain-ensure-');
    writeFileSync(join(plainRepo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/vitest': { version: '5.0.5' } } }));
    const jobUser = { uid: FIRST_UID, gid: FIRST_UID };
    const lowUser = { uid: FIRST_UID - 1, gid: FIRST_UID - 1 };
    const sysDir = makeTemp('hh-sysfiles-');
    const files = { passwd: join(sysDir, 'passwd'), group: join(sysDir, 'group') };
    await ensureRepoBrowser(makeTemp('hh-low-uid-'), plainRepo, lowUser, files);
    expect(existsSync(files.passwd)).toBe(false);
    await ensureRepoBrowser(dir, plainRepo, jobUser, files);
    expect(readFileSync(files.passwd, 'utf8')).toContain(`hh${FIRST_UID}:x:${FIRST_UID}:${FIRST_UID}`);

    const badRepo = makeTemp('hh-bad-ensure-');
    writeFileSync(join(badRepo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '9.9.9' } } }));
    mkdirSync(join(badRepo, 'node_modules', 'playwright'), { recursive: true });
    writeFileSync(join(badRepo, 'node_modules', 'playwright', 'package.json'), JSON.stringify({ version: '9.9.9' }));
    await expect(ensureRepoBrowser(makeTemp(), badRepo, null)).rejects.toThrow('Playwright browsers could not start:');

    expect(await startupBrowserCheck(makeTemp('hh-startup-null-'), null, undefined, browsersReady)).toBeNull();
    const sysDir2 = makeTemp('hh-sysfiles-2-');
    const files2 = { passwd: join(sysDir2, 'passwd'), group: join(sysDir2, 'group') };
    await startupBrowserCheck(makeTemp('hh-startup-low-'), lowUser, files2, browsersReady);
    expect(existsSync(files2.passwd)).toBe(false);
    await startupBrowserCheck(makeTemp('hh-startup-job-'), jobUser, files2, browsersReady);
    expect(readFileSync(files2.passwd, 'utf8')).toContain(`hh${FIRST_UID}:x:${FIRST_UID}:${FIRST_UID}`);
  });
});
