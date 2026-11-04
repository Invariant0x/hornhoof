import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  browserEnv,
  browsersDir,
  ensureRepoBrowser,
  GLOBAL_PLAYWRIGHT_DIR,
  playwrightVersionIn,
  prepareAndVerifyBrowser,
  prepareBrowser,
  readBrowserError,
  SEED_BROWSERS_PATH,
  shareTree,
  startupBrowserCheck,
  summarizeBrowserError,
  verifyBrowser,
  writeBrowserError,
} from '../src/browser.js';
import { FIRST_UID } from '../src/isolation.js';

const tempDirs: string[] = [];

function makeTemp(prefix = 'hh-browser-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakePlaywrightPackage(root: string, version: string, rev: string): string {
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
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
    if (process.getuid) {
      shareTree(join(browsersDir(dir), 'chromium-1248'), { uid: process.getuid(), gid: 99999 });
    }
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
    expect(invocations[1]!.args).toEqual([join(first.playwrightDir, 'cli.js'), 'install', 'chromium']);
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

describe('verifyBrowser and prepareAndVerifyBrowser', () => {
  it('launches real Chromium headless from a prepared browser folder and names the cause when broken', async () => {
    if (!existsSync(GLOBAL_PLAYWRIGHT_DIR) || !existsSync(SEED_BROWSERS_PATH)) return;
    const dir = makeTemp('hh-real-pw-');
    const target = browsersDir(dir);
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(SEED_BROWSERS_PATH)) {
      if (entry.startsWith('.')) continue;
      cpSync(join(SEED_BROWSERS_PATH, entry), join(target, entry), { recursive: true });
    }

    const ok = await verifyBrowser({ browsersDir: target, playwrightDir: GLOBAL_PLAYWRIGHT_DIR });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.browserVersion).toMatch(/^\d+\.\d+/);

    /* Break the headless shell binary to prove launch failure reports a clear, named reason. */
    const shellDir = readdirSync(target).find(entry => entry.startsWith('chromium_headless_shell-'))!;
    const binDir = readdirSync(join(target, shellDir)).find(entry => entry.startsWith('chrome-headless-shell'))!;
    const binary = join(target, shellDir, binDir, 'chrome-headless-shell');
    writeFileSync(binary, '#!/bin/sh\necho "error while loading shared libraries: libnss3.so: cannot open shared object file" >&2\nexit 127\n');
    chmodSync(binary, 0o755);

    const broken = await verifyBrowser({ browsersDir: target, playwrightDir: GLOBAL_PLAYWRIGHT_DIR });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain('libnss3.so');
  });

  it('extracts concise reasons from Playwright launch errors without ASCII box borders', () => {
    const boxed = [
      'browserType.launch: Executable doesn\'t exist at /data/browsers/chromium-1248/chrome-linux64/chrome',
      '╔══════════════════════════════════════════════════════╗',
      '║ Looks like Playwright Test was just installed.       ║',
      '╚══════════════════════════════════════════════════════╝',
    ].join('\n');
    expect(summarizeBrowserError(boxed, 1, false)).toContain("Executable doesn't exist at /data/browsers/chromium-1248");
    expect(summarizeBrowserError(boxed, 1, false)).not.toContain('╔');
    expect(summarizeBrowserError('', null, true)).toBe('Playwright Chromium launch timed out.');
    expect(summarizeBrowserError('', 127, false)).toBe('Playwright Chromium exited with code 127.');
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
          { name: 'firefox', revision: '1000' },
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
    expect(missingManifest).toEqual({ ok: false, error: expect.stringContaining('No Chromium revisions listed') });
  });

  it('persists and clears browser-error files and runs startupBrowserCheck / ensureRepoBrowser with passwd setup', async () => {
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
    await ensureRepoBrowser(makeTemp('hh-low-uid-'), plainRepo, null, lowUser, files);
    expect(existsSync(files.passwd)).toBe(false);
    await ensureRepoBrowser(dir, plainRepo, null, jobUser, files);
    expect(readFileSync(files.passwd, 'utf8')).toContain(`hh${FIRST_UID}:x:${FIRST_UID}:${FIRST_UID}`);

    const badRepo = makeTemp('hh-bad-ensure-');
    writeFileSync(join(badRepo, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '9.9.9' } } }));
    mkdirSync(join(badRepo, 'node_modules', 'playwright'), { recursive: true });
    writeFileSync(join(badRepo, 'node_modules', 'playwright', 'package.json'), JSON.stringify({ version: '9.9.9' }));
    await expect(ensureRepoBrowser(makeTemp(), badRepo, null, null)).rejects.toThrow('Playwright Chromium could not start:');

    if (existsSync(GLOBAL_PLAYWRIGHT_DIR) && existsSync(SEED_BROWSERS_PATH)) {
      expect(await startupBrowserCheck(makeTemp('hh-startup-null-'), null, null)).toBeNull();
    }
    const sysDir2 = makeTemp('hh-sysfiles-2-');
    const files2 = { passwd: join(sysDir2, 'passwd'), group: join(sysDir2, 'group') };
    await startupBrowserCheck(makeTemp('hh-startup-low-'), null, lowUser, files2);
    expect(existsSync(files2.passwd)).toBe(false);
    await startupBrowserCheck(makeTemp('hh-startup-job-'), null, jobUser, files2);
    expect(readFileSync(files2.passwd, 'utf8')).toContain(`hh${FIRST_UID}:x:${FIRST_UID}:${FIRST_UID}`);
  });
});
