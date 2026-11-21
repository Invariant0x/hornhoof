import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { folderBytes } from '../src/disk/clean.js';
import { workingCopies } from '../src/disk/copies.js';
import { CAS_MAX_AGE_MS, MIN_DEDUPE_BYTES, SETTLE_MS, dedupeNodeModules, pruneCas, runDedupeForOwner } from '../src/disk/dedupe.js';
import { packageStoreEnv, storeDir } from '../src/disk/store.js';
import { runJob, type ProviderAdapter, type RunInput, type RunResult } from '../src/runner.js';
import { realGit } from '../src/workspace.js';

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;

const dirs: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OLD_TIME = new Date(Date.now() - SETTLE_MS - 120_000);

function writeAged(file: string, content: Buffer | string, mode = 0o644, mtime = OLD_TIME): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  utimesSync(file, mtime, mtime);
}

/* Deterministic synthetic payload large enough to allocate multiple filesystem blocks so du reflects hard-link savings. */
function payload(tag: string, bytes = 64 * 1024): Buffer {
  const chunk = Buffer.from(`// synthetic package module ${tag}\n`);
  const out = Buffer.alloc(bytes);
  for (let off = 0; off < bytes; off += chunk.length) chunk.copy(out, off, 0, Math.min(chunk.length, bytes - off));
  return out;
}

function fakeAdapter(owner?: ProviderAdapter['owner']): ProviderAdapter & { inputs: RunInput[] } {
  const inputs: RunInput[] = [];
  const ok = (): RunResult => ({ ok: true, sessionId: null, result: 'done', output: '', error: null, limits: null });
  return {
    inputs,
    owner,
    install: async () => {},
    loggedIn: async () => true,
    login: async () => {},
    run: async input => {
      inputs.push(input);
      return ok();
    },
    secrets: async () => [],
  };
}

const job = (overrides: Partial<JobRun> = {}): JobRun => ({
  type: 'job.run',
  jobId: 'job-1',
  subscriptionId: 'sub-1',
  provider: 'claude',
  prompt: 'hi',
  sessionId: null,
  model: null,
  secret: null,
  timeoutMs: 10_000,
  instructions: null,
  toolToken: null,
  ...overrides,
});

function gitInit(dir: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@test' };
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.env\n');
  writeFileSync(join(dir, 'index.js'), 'export const x = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env });
}

describe('shared package store paths and turn env', () => {
  it('uses <dir>/work/.pkg-store on personal nodes and <owner.home>/.pkg-store per UID on built-in nodes', () => {
    const dir = '/data';
    expect(storeDir(dir, { user: null, home: null })).toBe('/data/work/.pkg-store');
    expect(storeDir(dir, { user: { uid: 1000, gid: 1000 }, home: '/data/home' })).toBe('/data/work/.pkg-store');
    expect(storeDir(dir, { user: { uid: 20001, gid: 20001 }, home: '/data/agents/agent-a' })).toBe('/data/agents/agent-a/.pkg-store');
    expect(storeDir(dir, { user: { uid: 20002, gid: 20002 }, home: '/data/agents/agent-b' })).toBe('/data/agents/agent-b/.pkg-store');
  });

  it('builds PNPM_STORE_DIR and npm_config_cache without overriding values already set in env', () => {
    expect(packageStoreEnv('/data', { user: null, home: null }, {})).toEqual({
      PNPM_STORE_DIR: '/data/work/.pkg-store/pnpm',
      npm_config_cache: '/data/work/.pkg-store/npm',
    });
    expect(packageStoreEnv('/data', { user: null, home: null }, { PNPM_STORE_DIR: '/custom/pnpm' })).toEqual({
      npm_config_cache: '/data/work/.pkg-store/npm',
    });
    expect(packageStoreEnv('/data', { user: null, home: null }, { PNPM_STORE_DIR: '/custom/pnpm', npm_config_cache: '/custom/npm' })).toEqual({});
  });

  it('passes per-UID package store env on workspace turns and omits it on non-workspace jobs', async () => {
    const dir = temp('hh-store-runner-');
    const personal = fakeAdapter();
    await runJob(personal, job({ workspace: { key: 'agent-1', repo: null } }), dir);
    expect(personal.inputs[0]!.env).toMatchObject({
      PNPM_STORE_DIR: join(dir, 'work', '.pkg-store', 'pnpm'),
      npm_config_cache: join(dir, 'work', '.pkg-store', 'npm'),
    });

    const builtinHome = join(dir, 'agents', 'agent-2');
    const builtin = fakeAdapter({ user: null, home: builtinHome, prepare: () => {} });
    await runJob(builtin, job({ jobId: 'job-2', workspace: { key: 'agent-2', repo: null } }), dir);
    expect(builtin.inputs[0]!.env).toMatchObject({
      PNPM_STORE_DIR: join(builtinHome, '.pkg-store', 'pnpm'),
      npm_config_cache: join(builtinHome, '.pkg-store', 'npm'),
    });

    const plain = fakeAdapter();
    await runJob(plain, job({ jobId: 'job-3' }), dir);
    expect(plain.inputs[0]!.env).toBeUndefined();
  });
});

describe('content-addressed hard-link deduplication', () => {
  it('hard-links identical node_modules files across two clones so disk usage does not double, and rm -rf / reinstall works cleanly over read-only links', async () => {
    const root = temp('hh-dedupe-real-');
    const work = join(root, 'work');
    const store = join(work, '.pkg-store');
    const cloneA = join(work, 'agents', '11111111-1111-4111-8111-111111111111', 'shop');
    const cloneB = join(work, 'agents', '22222222-2222-4222-8222-222222222222', 'shop');
    const nmA = join(cloneA, 'node_modules');
    const nmB = join(cloneB, 'node_modules');

    /* Populate both clones with identical multi-block regular and executable files. */
    const files: { rel: string; data: Buffer; mode: number }[] = [
      { rel: 'pkg-alpha/dist/bundle.js', data: payload('alpha-bundle', 256 * 1024), mode: 0o644 },
      { rel: 'pkg-beta/dist/index.js', data: payload('beta-index', 256 * 1024), mode: 0o644 },
      { rel: 'pkg-cli/bin/cli.js', data: payload('cli-bin', 128 * 1024), mode: 0o755 },
    ];
    for (const f of files) {
      writeAged(join(nmA, f.rel), f.data, f.mode);
      writeAged(join(nmB, f.rel), f.data, f.mode);
    }

    const beforeBytes = await folderBytes(work);
    const singleBytes = await folderBytes(nmA);
    expect(beforeBytes).toBeGreaterThanOrEqual(singleBytes * 1.8);

    const first = dedupeNodeModules({
      store,
      targets: [
        { rootDir: cloneA, nodeModulesDir: nmA },
        { rootDir: cloneB, nodeModulesDir: nmB },
      ],
    });
    expect(first.linked).toBe(files.length * 2);
    expect(first.freed).toBe(files.reduce((sum, f) => sum + f.data.length, 0));
    expect(first.exdev).toBe(false);

    /* Identical files now share one read-only inode (0444 / 0555) with nlink === 3 (CAS + cloneA + cloneB). */
    for (const f of files) {
      const stA = lstatSync(join(nmA, f.rel));
      const stB = lstatSync(join(nmB, f.rel));
      expect(stA.ino).toBe(stB.ino);
      expect(stA.nlink).toBe(3);
      expect(stA.mode & 0o777).toBe((f.mode & 0o111) !== 0 ? 0o555 : 0o444);
    }

    /* Disk blocks across both clones + store stay ~1x instead of doubling. */
    const afterBytes = await folderBytes(work);
    expect(afterBytes).toBeLessThan(beforeBytes * 0.65);

    /* A second pass skips already-linked CAS inodes without re-hashing. */
    const second = dedupeNodeModules({
      store,
      targets: [
        { rootDir: cloneA, nodeModulesDir: nmA },
        { rootDir: cloneB, nodeModulesDir: nmB },
      ],
    });
    expect(second.hashed).toBe(0);
    expect(second.linked).toBe(0);
    expect(second.freed).toBe(0);

    /* Removing (rm -rf) and reinstalling node_modules in cloneA works cleanly over read-only 0444/0555 hard links without affecting cloneB. */
    execFileSync('rm', ['-rf', nmA]);
    expect(existsSync(nmA)).toBe(false);
    for (const f of files) {
      expect(readFileSync(join(nmB, f.rel)).equals(f.data)).toBe(true);
      expect(lstatSync(join(nmB, f.rel)).nlink).toBe(2);
    }
    const freshData = payload('reinstalled-alpha', 32 * 1024);
    writeAged(join(nmA, 'pkg-alpha/dist/bundle.js'), freshData, 0o644);
    expect(readFileSync(join(nmA, 'pkg-alpha/dist/bundle.js')).equals(freshData)).toBe(true);
    expect(readFileSync(join(nmB, 'pkg-alpha/dist/bundle.js')).equals(files[0]!.data)).toBe(true);
  });

  it('skips small files, dot-folders, and recently modified files', () => {
    const root = temp('hh-dedupe-skip-');
    const store = join(root, '.pkg-store');
    const clone = join(root, 'clone');
    const nm = join(clone, 'node_modules');

    const small = join(nm, 'tiny/index.js');
    const dotBin = join(nm, '.bin/tool');
    const dotCache = join(nm, '.vite/deps/chunk.js');
    const dotLock = join(nm, '.package-lock.json');
    const fresh = join(nm, 'active/bundle.js');

    writeAged(small, Buffer.alloc(MIN_DEDUPE_BYTES - 1, 0x61));
    writeAged(dotBin, payload('bin', 16 * 1024), 0o755);
    writeAged(dotCache, payload('vite', 16 * 1024));
    writeAged(dotLock, payload('lock', 16 * 1024));
    writeAged(fresh, payload('fresh', 16 * 1024), 0o644, new Date());

    const res = dedupeNodeModules({ store, targets: [{ rootDir: clone, nodeModulesDir: nm }] });
    expect(res.linked).toBe(0);
    expect(res.hashed).toBe(0);
    for (const file of [small, dotBin, dotCache, dotLock, fresh]) {
      expect(lstatSync(file).nlink).toBe(1);
    }
  });

  it('never follows symlinks or escapes outside rootDir, and aborts on a symlinked store', () => {
    const root = temp('hh-dedupe-escape-');
    const store = join(root, '.pkg-store');
    const outside = join(root, 'outside');
    const outsideFile = join(outside, 'secret.dat');
    const outsideNm = join(outside, 'node_modules');
    const outsideNmFile = join(outsideNm, 'pkg/index.js');
    writeAged(outsideFile, payload('secret', 16 * 1024), 0o600);
    writeAged(outsideNmFile, payload('outside-nm', 16 * 1024), 0o644);
    const secretInoBefore = statSync(outsideFile).ino;
    const outsideNmInoBefore = statSync(outsideNmFile).ino;

    const clone = join(root, 'clone');
    const nm = join(clone, 'node_modules');
    mkdirSync(join(nm, 'pkg'), { recursive: true });
    /* Symlinked file inside node_modules pointing outside. */
    symlinkSync(outsideFile, join(nm, 'pkg/linked-file.js'));
    /* Symlinked directory inside node_modules pointing outside. */
    symlinkSync(outside, join(nm, 'linked-dir'));
    /* Symlinked intermediate directory leading to node_modules. */
    mkdirSync(join(clone, 'packages'), { recursive: true });
    symlinkSync(outside, join(clone, 'packages/escape'));
    /* Symlinked node_modules itself. */
    const cloneLink = join(root, 'clone-link');
    mkdirSync(cloneLink, { recursive: true });
    symlinkSync(outsideNm, join(cloneLink, 'node_modules'));

    const res = dedupeNodeModules({
      store,
      targets: [
        { rootDir: clone, nodeModulesDir: nm },
        { rootDir: clone, nodeModulesDir: join(clone, 'packages/escape/node_modules') },
        { rootDir: clone, nodeModulesDir: join(clone, '../outside/node_modules') },
        { rootDir: cloneLink, nodeModulesDir: join(cloneLink, 'node_modules') },
      ],
    });
    expect(res.linked).toBe(0);
    expect(statSync(outsideFile).ino).toBe(secretInoBefore);
    expect(statSync(outsideFile).mode & 0o777).toBe(0o600);
    expect(statSync(outsideNmFile).ino).toBe(outsideNmInoBefore);
    expect(statSync(outsideNmFile).nlink).toBe(1);

    /* Symlinked store root is refused without writing through it. */
    const linkedStore = join(root, 'linked-store');
    symlinkSync(outside, linkedStore);
    const cloneGood = join(root, 'clone-good');
    const goodFile = join(cloneGood, 'node_modules/pkg/index.js');
    writeAged(goodFile, payload('good', 16 * 1024));
    const storeRes = dedupeNodeModules({ store: linkedStore, targets: [{ rootDir: cloneGood, nodeModulesDir: join(cloneGood, 'node_modules') }] });
    expect(storeRes.linked).toBe(0);
    expect(existsSync(join(outside, 'cas'))).toBe(false);
  });

  it('skips cleanly on cross-device EXDEV without throwing or failing the disk pass', () => {
    const root = temp('hh-dedupe-exdev-');
    const store = join(root, '.pkg-store');
    const clone = join(root, 'clone');
    const nm = join(clone, 'node_modules');
    const file = join(nm, 'pkg/bundle.js');
    const data = payload('exdev', 16 * 1024);
    writeAged(file, data);
    const inoBefore = lstatSync(file).ino;

    const exdevLink = (from: string, to: string) => {
      if (to.startsWith(nm)) {
        const err = Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
        throw err;
      }
      linkSync(from, to);
    };

    const res = dedupeNodeModules({
      store,
      targets: [{ rootDir: clone, nodeModulesDir: nm }],
      link: exdevLink,
    });
    expect(res.exdev).toBe(true);
    expect(res.linked).toBe(0);
    expect(lstatSync(file).ino).toBe(inoBefore);
    expect(readFileSync(file).equals(data)).toBe(true);
  });

  it('is a no-op when invoked as root without an unprivileged owner user', async () => {
    const root = temp('hh-dedupe-root-');
    const store = join(root, '.pkg-store');
    const clone = join(root, 'clone');
    const nm = join(clone, 'node_modules');
    const file = join(nm, 'pkg/index.js');
    writeAged(file, payload('root-guard', 16 * 1024));

    const res = await runDedupeForOwner({
      store,
      targets: [{ rootDir: clone, nodeModulesDir: nm }],
      owner: { user: null, home: null },
      isRoot: true,
    });
    expect(res.linked).toBe(0);
    expect(lstatSync(file).nlink).toBe(1);
    expect(existsSync(store)).toBe(false);
  });

  it('prunes unreferenced CAS entries (nlink === 1) after retention or immediately when aggressive, keeping live entries', () => {
    const root = temp('hh-dedupe-gc-');
    const store = join(root, '.pkg-store');
    const cloneA = join(root, 'cloneA');
    const cloneB = join(root, 'cloneB');
    const dataDead = payload('dead-pkg', 32 * 1024);
    const dataLive = payload('live-pkg', 32 * 1024);
    writeAged(join(cloneA, 'node_modules/dead/index.js'), dataDead);
    writeAged(join(cloneA, 'node_modules/live/index.js'), dataLive);
    writeAged(join(cloneB, 'node_modules/live/index.js'), dataLive);

    dedupeNodeModules({
      store,
      targets: [
        { rootDir: cloneA, nodeModulesDir: join(cloneA, 'node_modules') },
        { rootDir: cloneB, nodeModulesDir: join(cloneB, 'node_modules') },
      ],
    });

    /* Remove cloneA: dead now has nlink === 1 in CAS; live still has nlink === 2 (CAS + cloneB). */
    rmSync(join(cloneA, 'node_modules'), { recursive: true, force: true });

    const now = Date.now();
    /* Fresh nlink === 1 stays under normal retention. */
    expect(pruneCas(store, { nowMs: now, aggressive: false })).toEqual({ pruned: 0, freed: 0 });
    /* Past 7-day retention: dead entry is pruned; live entry survives. */
    const afterWeek = pruneCas(store, { nowMs: now + CAS_MAX_AGE_MS + 1000, aggressive: false });
    expect(afterWeek).toEqual({ pruned: 1, freed: dataDead.length });
    expect(readFileSync(join(cloneB, 'node_modules/live/index.js')).equals(dataLive)).toBe(true);
    expect(lstatSync(join(cloneB, 'node_modules/live/index.js')).nlink).toBe(2);

    /* Remove cloneB too: aggressive GC removes live immediately even before 7 days. */
    rmSync(join(cloneB, 'node_modules'), { recursive: true, force: true });
    const aggressive = pruneCas(store, { nowMs: now, aggressive: true });
    expect(aggressive).toEqual({ pruned: 1, freed: dataLive.length });
  });
});

describe('workingCopies integration with shared package store', () => {
  it('deduplicates ignored node_modules across agents clones while leaving .env and tracked files untouched', async () => {
    const dir = temp('hh-work-dedupe-');
    const store = join(dir, 'work', '.pkg-store');
    const clone1 = join(dir, 'work', 'agents', '11111111-1111-4111-8111-111111111111', 'shop');
    const clone2 = join(dir, 'work', 'agents', '22222222-2222-4222-8222-222222222222', 'shop');
    gitInit(clone1);
    gitInit(clone2);

    const bigA = payload('shared-dep-a', 256 * 1024);
    const bigB = payload('shared-dep-b', 256 * 1024);
    writeAged(join(clone1, 'node_modules/lib/a.js'), bigA);
    writeAged(join(clone1, 'apps/web/node_modules/lib/b.js'), bigB);
    writeAged(join(clone2, 'node_modules/lib/a.js'), bigA);
    writeAged(join(clone2, 'apps/web/node_modules/lib/b.js'), bigB);
    writeAged(join(clone1, '.env'), payload('secret-env', 16 * 1024), 0o600);
    writeAged(join(clone2, '.env'), payload('secret-env', 16 * 1024), 0o600);

    const git = (args: string[], cwd: string) => realGit(args, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, GIT_TERMINAL_PROMPT: '0' }, user: null });
    const cleaner = workingCopies({ dir, git, tasks: () => ({ open: [], upTo: 0 }), store, owner: { user: null, home: null } });

    const before = await cleaner.size();
    const freed = await cleaner.clean();
    const after = await cleaner.size();

    expect(freed).toBe(bigA.length + bigB.length);
    expect(after).toBeLessThan(before * 0.65);
    expect(lstatSync(join(clone1, 'node_modules/lib/a.js')).ino).toBe(lstatSync(join(clone2, 'node_modules/lib/a.js')).ino);
    expect(lstatSync(join(clone1, 'apps/web/node_modules/lib/b.js')).ino).toBe(lstatSync(join(clone2, 'apps/web/node_modules/lib/b.js')).ino);
    /* .env outside node_modules is never hard-linked or altered. */
    expect(lstatSync(join(clone1, '.env')).nlink).toBe(1);
    expect(lstatSync(join(clone2, '.env')).nlink).toBe(1);
    expect(lstatSync(join(clone1, '.env')).ino).not.toBe(lstatSync(join(clone2, '.env')).ino);
  });
});
