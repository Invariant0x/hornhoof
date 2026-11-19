import { chmodSync, cpSync, existsSync, lchownSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { agentUser, ensurePasswd, FIRST_UID, isRootUser, type JobUser, type SystemFiles } from './isolation.js';
import { runProgram, stripEscapes, withTrustedInstall } from './providers/process.js';
import { currentCheckSignal } from './check-queue.js';

const SEED_BROWSERS_PATH = '/opt/ms-playwright';
const GLOBAL_PLAYWRIGHT_DIR = '/usr/local/lib/node_modules/playwright';

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const VERIFY_TIMEOUT_MS = 30_000;
const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';
/* Three engines start one after another. */
const LAUNCH_TIMEOUT_MS = 90_000;
const STARTUP_TOOLS: { bin: string; args: string[] }[] = [
  { bin: 'unzip', args: ['-v'] },
  { bin: 'zip', args: ['-v'] },
  ...['gh', 'shellcheck', '/usr/bin/time', 'strings', 'patch', 'ss', 'objdump'].map(bin => ({ bin, args: ['--version'] })),
];
const MAX_REASON_LENGTH = 240;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PLAYWRIGHT_PACKAGES = ['@playwright/test', 'playwright', 'playwright-core'] as const;
/* The folder of the shared browsers that holds the Playwright packages the node installed, one folder for each version. */
const PACKAGES = '.playwright';
/* The engines a page is checked in, as Playwright names them, and what Playwright installs with them. */
const ENGINES = ['chromium', 'firefox', 'webkit'] as const;
const BROWSER_COMPONENTS = new Set<string>([...ENGINES, 'chromium-headless-shell', 'ffmpeg']);
const SPECIFIC_CAUSE = /shared libraries|Executable doesn't exist|EACCES|ENOENT|permission denied|Exec format error|Download failed|cannot open/i;
const NOISE_LINE = /^[╔║╚╠╣═─┌┐└┘│]|^(?:Call log:|Browser logs:|<launching>|<launched>)/i;

const LAUNCH_CHECK_SCRIPT = [
  "const { createRequire } = require('node:module');",
  "const path = require('node:path');",
  "const req = createRequire(path.join(process.argv[1], 'package.json'));",
  "const engines = req('playwright-core');",
  '(async () => {',
  '  const versions = [];',
  `  for (const name of ${JSON.stringify(ENGINES)}) {`,
  '    const browser = await engines[name].launch({ headless: true }).catch(err => {',
  "      console.error('engine ' + name);",
  '      console.error(err && err.message ? err.message : String(err));',
  '      process.exit(1);',
  '    });',
  "    versions.push(name + ' ' + browser.version());",
  '    await browser.close();',
  '  }',
  "  console.log(versions.join(', '));",
  '})().catch(err => {',
  '  console.error(err && err.message ? err.message : String(err));',
  '  process.exit(1);',
  '});',
].join('\n');

type CommandResult = { code: number | null; output: string; timedOut: boolean };
export type CommandRunner = (bin: string, args: string[], env: NodeJS.ProcessEnv, user?: JobUser | null, cwd?: string) => Promise<CommandResult>;

type PrepareBrowserOptions = {
  dir: string;
  repoDir?: string;
  seedDir?: string;
  globalPlaywrightDir?: string;
  /* A node that runs as root keeps the shared browsers its own; tests say so without being root. */
  isRoot?: boolean;
  runCommand?: CommandRunner;
};

type PrepareBrowserResult =
  | { status: 'not_needed' }
  | { status: 'ready'; version: string; playwrightDir: string; downloaded: boolean };

type VerifyBrowserResult =
  | { ok: true; browserVersion: string }
  | { ok: false; error: string };

type PrepareAndVerifyResult =
  | { ok: true; status: 'not_needed' }
  | { ok: true; status: 'ready'; version: string; browserVersion: string; downloaded: boolean }
  | { ok: false; error: string };

export const browsersDir = (dir: string): string => join(dir, 'browsers');
const browserErrorFile = (dir: string): string => join(dir, 'browser-error');

export function browserEnv(dir: string): Record<string, string> {
  return { PLAYWRIGHT_BROWSERS_PATH: browsersDir(dir), PLAYWRIGHT_SKIP_BROWSER_GC: '1' };
}

const safeVersion = (value: unknown): string | null =>
  typeof value === 'string' && SAFE_VERSION.test(value) ? value : null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const versionOfEntry = (entry: unknown): string | null => safeVersion(asRecord(entry)?.version);

function readJsonRecord(file: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function versionInPackagesMap(packages: Record<string, unknown>, name: string): string | null {
  const direct = versionOfEntry(packages[`node_modules/${name}`]);
  if (direct) return direct;
  const hit = Object.entries(packages).find(([key]) => key.endsWith(`/node_modules/${name}`));
  return versionOfEntry(hit?.[1]);
}

function versionInNpmLock(file: string): string | null {
  const lock = readJsonRecord(file);
  if (!lock) return null;
  const packages = asRecord(lock.packages);
  const deps = asRecord(lock.dependencies);
  for (const name of PLAYWRIGHT_PACKAGES) {
    const found = (packages && versionInPackagesMap(packages, name)) || versionOfEntry(deps?.[name]);
    if (found) return found;
  }
  return null;
}

function versionInTextLock(file: string, versionIn: (text: string) => string | undefined): string | null {
  if (!existsSync(file)) return null;
  try {
    return safeVersion(versionIn(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function versionInPnpmLock(lock: string): string | undefined {
  let packageIndent = Infinity;
  let fieldIndent = Infinity;
  for (const rawLine of lock.split('\n')) {
    const line = rawLine.trimStart();
    if (!line || line.startsWith('#')) continue;
    const indent = rawLine.length - line.length;

    // Stay inside a Playwright entry and read only its immediate fields.
    if (indent <= packageIndent) {
      packageIndent = /^(['"]?)(?:@playwright\/test|playwright)\1:$/.test(line.trimEnd()) ? indent : Infinity;
      fieldIndent = Infinity;
    } else if (indent <= fieldIndent) {
      fieldIndent = indent;
      const version = /^version:[ \t]*['"]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(line)?.[1];
      if (version) return version;
    }
  }
  return undefined;
}

export function playwrightVersionIn(repoDir: string): string | null {
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
    if (existsSync(join(repoDir, name))) return versionInNpmLock(join(repoDir, name));
  }
  const pnpm = versionInTextLock(join(repoDir, 'pnpm-lock.yaml'), versionInPnpmLock);
  if (pnpm) return pnpm;
  return versionInTextLock(join(repoDir, 'yarn.lock'), text =>
    /["']?(?:@playwright\/test|playwright)@[^"'\n:]+["']?:\n\s+version\s+["']?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)?.[1]);
}

function readPackageVersion(pkgDir: string): string | null {
  return safeVersion(readJsonRecord(join(pkgDir, 'package.json'))?.version);
}

function subdirsOf(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(entry => join(dir, entry))
    .filter(path => lstatSync(path).isDirectory());
}

function findWorkspacePlaywrightVersion(dir: string): string | null {
  for (const agentDir of subdirsOf(join(dir, 'work', 'agents'))) {
    for (const repoDir of subdirsOf(agentDir)) {
      const version = playwrightVersionIn(repoDir);
      if (version) return version;
    }
  }
  return null;
}

const rootOwns = (stat: Stats): boolean => stat.uid === 0 && stat.gid === 0;

/* Every user may read and run the shared browsers, and only their owner may change them. On a node that runs as root that
   owner is root, never the user of an agent or a test run: whoever could write here could swap the Chromium another agent
   starts, with that agent's sign-in. The owner changes first, so nobody can put anything else in place of what comes next. */
export function shareTree(path: string, isRoot = isRootUser()): void {
  const stat = lstatSync(path);
  if (isRoot && !rootOwns(stat)) lchownSync(path, 0, 0);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) shareTree(join(path, entry), isRoot);
    return;
  }
  chmodSync(path, (stat.mode & 0o111) !== 0 ? 0o755 : 0o644);
}

/* Where a link really ends, following every link on the way; none when it ends nowhere. */
function realOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/* A tree stays when, on a node that runs as root, all of it is root's, and no link in it ends outside it. */
function trustedTree(path: string, top: string, isRoot: boolean): boolean {
  const stat = lstatSync(path);
  if (isRoot && !rootOwns(stat)) return false;
  if (stat.isSymbolicLink()) return (realOf(path) ?? '').startsWith(top + sep);
  return !stat.isDirectory() || readdirSync(path).every(entry => trustedTree(join(path, entry), top, isRoot));
}

/* What seedFromImage leaves: a browser folder's link, straight to the folder of that name in the image. */
function linksToSeed(path: string, stat: Stats, seedDir: string, isRoot: boolean): boolean {
  const seed = realOf(seedDir);
  return (!isRoot || rootOwns(stat)) && seed !== null && realOf(path) === join(seed, basename(path));
}

function trustedEntry(path: string, seedDir: string, isRoot: boolean): boolean {
  const stat = lstatSync(path);
  return stat.isSymbolicLink() ? linksToSeed(path, stat, seedDir, isRoot) : trustedTree(path, realpathSync(path), isRoot);
}

/* From here only root may add to the folder, so whoever held it adds nothing behind the look that follows. */
function closeFolder(folder: string, isRoot: boolean): void {
  if (isRoot && !rootOwns(lstatSync(folder))) lchownSync(folder, 0, 0);
  chmodSync(folder, 0o755);
}

/* Each browser folder, the npm cache and each version of the package stays or goes whole. What goes comes back from the
   image, npm or Playwright's download. This comes before anything inside changes an owner, which would make any of it look
   like root's. */
function dropUntrusted(folder: string, seedDir: string, isRoot: boolean): void {
  closeFolder(folder, isRoot);
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (name === PACKAGES && lstatSync(path).isDirectory()) dropUntrusted(path, seedDir, isRoot);
    else if (!trustedEntry(path, seedDir, isRoot)) rmSync(path, { recursive: true, force: true });
  }
}

function openSharedFolder(targetDir: string, seedDir: string, isRoot: boolean): void {
  if (lstatSync(targetDir, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(targetDir);
  mkdirSync(targetDir, { recursive: true });
  dropUntrusted(targetDir, seedDir, isRoot);
  shareTree(targetDir, isRoot);
}

function isInstalled(baseDir: string, folder: string): boolean {
  return existsSync(join(baseDir, folder, 'INSTALLATION_COMPLETE'));
}

function browserFolder(item: unknown): string | null {
  const rec = asRecord(item);
  const name = typeof rec?.name === 'string' && BROWSER_COMPONENTS.has(rec.name) ? rec.name : null;
  const rev = typeof rec?.revision === 'string' && /^\d+$/.test(rec.revision) ? rec.revision : null;
  return name && rev ? `${name.replace(/-/g, '_')}-${rev}` : null;
}

function requiredFolders(playwrightDir: string): string[] {
  const candidates = [
    join(playwrightDir, 'node_modules', 'playwright-core', 'browsers.json'),
    join(playwrightDir, '..', 'playwright-core', 'browsers.json'),
  ];
  const file = candidates.find(existsSync);
  const data = file ? readJsonRecord(file) : null;
  const list = Array.isArray(data?.browsers) ? data.browsers : [];
  const folders = list.map(browserFolder).filter((f): f is string => f !== null);
  if (!folders.length) throw new Error(`No browser revisions listed in ${playwrightDir}.`);
  return folders;
}

function isWorldAccessible(path: string): boolean {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return true;
  if (stat.isDirectory()) {
    if ((stat.mode & 0o005) !== 0o005) return false;
    return readdirSync(path).every(entry => isWorldAccessible(join(path, entry)));
  }
  return (stat.mode & 0o004) !== 0 && ((stat.mode & 0o100) === 0 || (stat.mode & 0o001) !== 0);
}

function clearBrokenEntries(targetDir: string, folders: string[]): void {
  for (const folder of folders) {
    const dest = join(targetDir, folder);
    if (!isInstalled(targetDir, folder) && lstatSync(dest, { throwIfNoEntry: false })) {
      rmSync(dest, { recursive: true });
    }
  }
}

function seedFromImage(targetDir: string, seedDir: string, folders: string[], isRoot: boolean): void {
  clearBrokenEntries(targetDir, folders);
  if (!existsSync(seedDir)) return;
  for (const folder of folders) {
    if (isInstalled(targetDir, folder) || !isInstalled(seedDir, folder)) continue;
    const src = join(seedDir, folder);
    const dest = join(targetDir, folder);
    if (isWorldAccessible(src)) {
      symlinkSync(src, dest);
      continue;
    }
    const tmp = join(targetDir, `.${folder}.seed-${process.pid}-${Date.now()}`);
    cpSync(src, tmp, { recursive: true, verbatimSymlinks: true });
    shareTree(tmp, isRoot);
    renameSync(tmp, dest);
  }
}

const defaultRunner = (timeoutMs: number): CommandRunner => (bin, args, env, user, cwd) =>
  runBrowserCommand({ bin, args, env, timeoutMs, user, cwd });

async function runBrowserCommand(options: Parameters<typeof runProgram>[0]): ReturnType<typeof runProgram> {
  const signal = currentCheckSignal();
  signal?.throwIfAborted();
  let cleanup = Promise.resolve();
  /* runProgram kills the group after TERM. Keep admission through that cleanup, even if pipes close early. */
  const aborted = () => { cleanup = new Promise(resolve => setTimeout(resolve, 5000)); };
  signal?.addEventListener('abort', aborted, { once: true });
  try { return await runProgram({ ...options, signal }); }
  finally { signal?.removeEventListener('abort', aborted); await cleanup; }
}

function cleanErrorLine(line: string): string {
  return line
    .replace(/^\[pid=\d+\]\[err\]\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .replace(/^browserType\.launch:\s*/i, '')
    .trim();
}

export function summarizeBrowserError(output: string, code: number | null, timedOut: boolean): string {
  if (timedOut) return 'Playwright browser launch timed out.';
  const lines = stripEscapes(output)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !NOISE_LINE.test(line));
  const specific = lines.find(line => SPECIFIC_CAUSE.test(line));
  const fallback = `Playwright browser check exited with code ${code === null ? 'unknown' : code}.`;
  const chosen = cleanErrorLine(specific || lines[0] || fallback);
  return chosen.length > MAX_REASON_LENGTH ? `${chosen.slice(0, MAX_REASON_LENGTH - 3)}...` : chosen;
}

/* Why the browsers did not start, with the engine that did not when the check got as far as one. */
function launchError(done: CommandResult): string {
  const engine = /^engine (\w+)$/m.exec(done.output)?.[1];
  const reason = summarizeBrowserError(done.output.replace(/^engine \w+$/m, ''), done.code, done.timedOut);
  return engine ? `${engine}: ${reason}` : reason;
}

async function withTempHome<T>(prefix: string, user: JobUser | null, work: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = mkdtempSync(join(tmpdir(), prefix));
  if (user) {
    lchownSync(homeDir, user.uid, user.gid);
    chmodSync(homeDir, 0o700);
  }
  try {
    return await work(homeDir);
  } finally {
    rmSync(homeDir, { recursive: true });
  }
}

async function resolvePlaywrightDir(
  targetDir: string,
  version: string,
  opts: { repoDir?: string; globalPlaywrightDir: string; isRoot: boolean; runCommand: CommandRunner },
): Promise<string> {
  const prefix = join(targetDir, PACKAGES, version);
  const cached = join(prefix, 'node_modules', 'playwright');
  /* What a node runs as root comes from its image or its own cache: a repository's package is whatever its branch holds. */
  const inRepo = opts.repoDir && !opts.isRoot ? join(opts.repoDir, 'node_modules', 'playwright') : null;
  for (const candidate of [inRepo, opts.globalPlaywrightDir, cached]) {
    if (candidate && readPackageVersion(candidate) === version) return candidate;
  }
  mkdirSync(prefix, { recursive: true });
  const done = await withTrustedInstall((env, cwd) => opts.runCommand(
    'npm',
    ['install', '--prefix', prefix, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--ignore-scripts', `playwright@${version}`],
    { ...env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    null,
    cwd,
  ));
  if (done.code !== 0) throw new Error(summarizeBrowserError(done.output, done.code, done.timedOut));
  shareTree(targetDir, opts.isRoot);
  return cached;
}

const browserLocks = new Map<string, Promise<void>>();

async function withBrowserLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = browserLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = prev.then(() => current);
  browserLocks.set(key, tail);
  await prev;
  try {
    return await work();
  } finally {
    release();
    if (browserLocks.get(key) === tail) browserLocks.delete(key);
  }
}

/* A repository's browsers are every folder its Playwright lists. The node's own are one installed folder of each engine it
   lists, whatever else the image brought. */
function hasRequiredInstall(targetDir: string, folders: string[], full: boolean): boolean {
  if (full) return folders.every(folder => isInstalled(targetDir, folder));
  const engines = ENGINES.map(engine => folders.filter(folder => folder.startsWith(engine))).filter(found => found.length);
  return engines.every(found => found.some(folder => isInstalled(targetDir, folder)));
}

export async function prepareBrowser({
  dir,
  repoDir,
  seedDir = SEED_BROWSERS_PATH,
  globalPlaywrightDir = GLOBAL_PLAYWRIGHT_DIR,
  isRoot = isRootUser(),
  runCommand = defaultRunner(INSTALL_TIMEOUT_MS),
}: PrepareBrowserOptions): Promise<PrepareBrowserResult> {
  const workspaceVersion = repoDir ? null : findWorkspacePlaywrightVersion(dir);
  const version = repoDir ? playwrightVersionIn(repoDir) : workspaceVersion || readPackageVersion(globalPlaywrightDir);
  if (!version) return { status: 'not_needed' };
  const full = Boolean(repoDir || workspaceVersion);

  const targetDir = browsersDir(dir);
  return withBrowserLock(targetDir, async () => {
    openSharedFolder(targetDir, seedDir, isRoot);
    const playwrightDir = await resolvePlaywrightDir(targetDir, version, { repoDir, globalPlaywrightDir, isRoot, runCommand });
    const folders = requiredFolders(playwrightDir);
    seedFromImage(targetDir, seedDir, folders, isRoot);
    if (hasRequiredInstall(targetDir, folders, full)) {
      return { status: 'ready', version, playwrightDir, downloaded: false };
    }
    return withTrustedInstall(async (trustedEnv, cwd) => {
      const env: NodeJS.ProcessEnv = {
        ...trustedEnv,
        ...browserEnv(dir),
      };
      const done = await runCommand(process.execPath, [join(playwrightDir, 'cli.js'), 'install', ...ENGINES], env, null, cwd);
      if (done.code !== 0) throw new Error(summarizeBrowserError(done.output, done.code, done.timedOut));
      shareTree(targetDir, isRoot);
      return { status: 'ready', version, playwrightDir, downloaded: true };
    });
  });
}

export async function verifyBrowser({
  browsersDir: targetDir,
  playwrightDir = GLOBAL_PLAYWRIGHT_DIR,
  user = null,
  runCommand = defaultRunner(LAUNCH_TIMEOUT_MS),
}: {
  browsersDir: string;
  playwrightDir?: string;
  user?: JobUser | null;
  runCommand?: CommandRunner;
}): Promise<VerifyBrowserResult> {
  return withTempHome('hh-pw-verify-', user, async homeDir => {
    const env: NodeJS.ProcessEnv = {
      /* WebKit starts through a shell script of its own, which calls the system's tools wherever the node's are. */
      PATH: [process.env.PATH, SYSTEM_PATH].filter(Boolean).join(':'),
      HOME: homeDir,
      TMPDIR: homeDir,
      LANG: 'C.UTF-8',
      PLAYWRIGHT_BROWSERS_PATH: targetDir,
      PLAYWRIGHT_SKIP_BROWSER_GC: '1',
    };
    const done = await runCommand(process.execPath, ['-e', LAUNCH_CHECK_SCRIPT, playwrightDir], env, user);
    const version = stripEscapes(done.output).trim().split('\n')[0]!.trim();
    if (done.code === 0 && version) return { ok: true, browserVersion: version };
    return { ok: false, error: launchError(done) };
  });
}

export async function prepareAndVerifyBrowser(
  opts: PrepareBrowserOptions & { verifyUser?: JobUser | null },
): Promise<PrepareAndVerifyResult> {
  try {
    const prepared = await prepareBrowser(opts);
    if (prepared.status === 'not_needed') return { ok: true, status: 'not_needed' };
    const checked = await verifyBrowser({
      browsersDir: browsersDir(opts.dir),
      playwrightDir: prepared.playwrightDir,
      user: opts.verifyUser ?? null,
      runCommand: opts.runCommand,
    });
    if (!checked.ok) return checked;
    return {
      ok: true,
      status: 'ready',
      version: prepared.version,
      browserVersion: checked.browserVersion,
      downloaded: prepared.downloaded,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function writeBrowserError(dir: string, error: string | null): void {
  const file = browserErrorFile(dir);
  if (error) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${error}\n`, { mode: 0o644 });
  } else {
    rmSync(file, { force: true });
  }
}

export function readBrowserError(dir: string): string | null {
  const file = browserErrorFile(dir);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/* verifyUser only checks that the browsers start: the shared browsers stay out of its hands. */
export async function ensureRepoBrowser(
  dir: string,
  repoDir: string,
  verifyUser: JobUser | null = agentUser(),
  files?: SystemFiles,
): Promise<void> {
  if (verifyUser && verifyUser.uid >= FIRST_UID) ensurePasswd(verifyUser, join(dir, 'home'), files);
  const res = await prepareAndVerifyBrowser({ dir, repoDir, verifyUser });
  if (!res.ok) throw new Error(`Playwright browsers could not start: ${res.error}`);
}

async function startupToolError(bin: string, args: string[], verifyUser: JobUser | null): Promise<string | null> {
  const command = [bin, ...args].join(' ');
  const checked = await runProgram({
    bin, args, user: verifyUser, timeoutMs: VERIFY_TIMEOUT_MS,
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  if (checked.timedOut) return `${command} timed out.`;
  if (checked.code !== 0) {
    const reason = stripEscapes(checked.output).trim().slice(0, MAX_REASON_LENGTH) || `exited with code ${checked.code ?? 'unknown'}`;
    return `${command} failed: ${reason}`;
  }
  return null;
}

type PrepareBrowsers = typeof prepareAndVerifyBrowser;

async function startupReadinessError(dir: string, verifyUser: JobUser | null, prepare: PrepareBrowsers): Promise<string | null> {
  for (const { bin, args } of STARTUP_TOOLS) {
    const error = await startupToolError(bin, args, verifyUser);
    if (error) return error;
  }
  const res = await prepare({ dir, verifyUser });
  return res.ok ? null : res.error;
}

/* prepare readies and launches the browsers; a test passes its own, as the browsers are Playwright's, not the node's. */
export async function startupBrowserCheck(
  dir: string,
  verifyUser: JobUser | null = agentUser(),
  files?: SystemFiles,
  prepare: PrepareBrowsers = prepareAndVerifyBrowser,
): Promise<string | null> {
  if (verifyUser && verifyUser.uid >= FIRST_UID) ensurePasswd(verifyUser, join(dir, 'home'), files);
  return startupReadinessError(dir, verifyUser, prepare);
}
