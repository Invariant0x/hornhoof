import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRootUser } from '../isolation.js';
import type { StoreOwner } from './store.js';

export const MIN_DEDUPE_BYTES = 4096;
export const MAX_DEDUPE_FILE_BYTES = 64 * 1024 * 1024;
export const SETTLE_MS = 60_000;
export const CAS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_HASH_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_MS = 30_000;

const CHUNK_BYTES = 64 * 1024;
const TEMP_STALE_MS = 60 * 60 * 1000;
const WORKER_TIMEOUT_MS = 120_000;
const HEX_PREFIX = /^[0-9a-f]{2}$/;
const WORKER_PATH = fileURLToPath(new URL('./dedupe-worker.js', import.meta.url));

export type DedupeTarget = { rootDir: string; nodeModulesDir: string };

export type DedupeOptions = {
  store: string;
  targets: DedupeTarget[];
  nowMs?: number;
  minBytes?: number;
  settleMs?: number;
  maxHashBytes?: number;
  maxFiles?: number;
  maxMs?: number;
  /* Injectable hard-link op for testing cross-device EXDEV cleanly. */
  link?: (existingPath: string, newPath: string) => void;
};

export type DedupeResult = {
  hashed: number;
  linked: number;
  freed: number;
  exdev: boolean;
};

export type PruneOptions = {
  nowMs?: number;
  maxAgeMs?: number;
  aggressive?: boolean;
};

export type PruneResult = {
  pruned: number;
  freed: number;
};

export type OwnerDedupeOptions = Omit<DedupeOptions, 'link'> & {
  owner: StoreOwner;
  prune?: PruneOptions;
  isRoot?: boolean;
};

export type OwnerDedupeResult = DedupeResult & { gcPruned: number; gcFreed: number };

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/* Creates dir with mode 0700 if absent, and verifies it is a real directory (never a symlink). */
function ensureRealDir(dir: string): Stats | null {
  const existing = safeLstat(dir);
  if (existing) return existing.isDirectory() ? existing : null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  const made = safeLstat(dir);
  return made?.isDirectory() ? made : null;
}

/* Verifies that nodeModulesDir sits strictly inside rootDir without crossing any symlink or parent traversal, and ends in
   node_modules. Returns the verified real path or null if any segment is a symlink, missing, or escapes rootDir. */
function verifiedNodeModules(rootDir: string, nodeModulesDir: string): string | null {
  const rootStat = safeLstat(rootDir);
  if (!rootStat?.isDirectory()) return null;
  let realRoot: string;
  try {
    realRoot = realpathSync(rootDir);
  } catch {
    return null;
  }
  const rel = relative(resolve(rootDir), resolve(nodeModulesDir));
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  const parts = rel.split(sep);
  if (parts.length === 0 || parts[parts.length - 1] !== 'node_modules') return null;
  let cur = realRoot;
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return null;
    cur = join(cur, part);
    const st = safeLstat(cur);
    if (!st?.isDirectory()) return null;
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(cur);
  } catch {
    return null;
  }
  return realTarget.startsWith(realRoot + sep) ? realTarget : null;
}

function hashFd(fd: number, expectedSize: number, buf: Buffer): string | null {
  const hash = createHash('sha256');
  let pos = 0;
  while (true) {
    const n = readSync(fd, buf, 0, buf.length, pos);
    if (n === 0) break;
    hash.update(buf.subarray(0, n));
    pos += n;
    if (pos > expectedSize) return null;
  }
  return pos === expectedSize ? hash.digest('hex') : null;
}

/* Copies fd from offset 0 into a fresh read-only temp file in prefixDir, verifying its sha256 matches digest before
   linking it into casPath. Returns whether casPath already existed before this call, or null on any error/mismatch. */
function populateCas(
  fd: number,
  expectedSize: number,
  digest: string,
  canonicalMode: number,
  prefixDir: string,
  casPath: string,
  buf: Buffer,
  linkOp: (from: string, to: string) => void,
  seq: number,
): boolean | null {
  const existing = safeLstat(casPath);
  if (existing) return existing.isFile() && existing.size === expectedSize && (existing.mode & 0o777) === canonicalMode ? true : null;

  const tmpPath = join(prefixDir, `.tmp-${process.pid}-${seq}`);
  let tmpFd: number | null = null;
  try {
    tmpFd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const verify = createHash('sha256');
    let pos = 0;
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      verify.update(buf.subarray(0, n));
      let written = 0;
      while (written < n) written += writeSync(tmpFd, buf, written, n - written);
      pos += n;
      if (pos > expectedSize) return null;
    }
    if (pos !== expectedSize || verify.digest('hex') !== digest) return null;
    fchmodSync(tmpFd, canonicalMode);
    closeSync(tmpFd);
    tmpFd = null;
    try {
      linkOp(tmpPath, casPath);
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return true;
      return null;
    }
  } catch {
    return null;
  } finally {
    if (tmpFd !== null) {
      try {
        closeSync(tmpFd);
      } catch {
        /* Ignore close errors after a failed write. */
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      /* Ignore cleanup error if temp file was never created. */
    }
  }
}

type State = {
  casDir: string;
  storeDev: number;
  buf: Buffer;
  nowMs: number;
  minBytes: number;
  settleMs: number;
  maxHashBytes: number;
  maxFiles: number;
  deadlineMs: number;
  linkOp: (from: string, to: string) => void;
  hashedBytes: number;
  filesSeen: number;
  seq: number;
  result: DedupeResult;
};

function budgetLeft(state: State): boolean {
  return state.hashedBytes < state.maxHashBytes && state.filesSeen < state.maxFiles && Date.now() < state.deadlineMs;
}

/* Deduplicates one regular file via O_NOFOLLOW + fstat + sha256 + atomic sibling link/rename. Files with nlink !== 1 are
   already hard-linked (either to our CAS or to pnpm's store) and skipped without reading. Returns 'exdev' if linking
   crossed filesystems so the caller can skip the rest of that mount cleanly. */
function dedupeFile(filePath: string, state: State): 'ok' | 'exdev' {
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return 'ok';
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.nlink !== 1 || fst.size < state.minBytes || fst.size > MAX_DEDUPE_FILE_BYTES) return 'ok';
    if (state.nowMs - fst.mtimeMs < state.settleMs) return 'ok';
    if (fst.dev !== state.storeDev) {
      state.result.exdev = true;
      return 'exdev';
    }

    state.filesSeen++;
    const digest = hashFd(fd, fst.size, state.buf);
    if (!digest) return 'ok';
    state.hashedBytes += fst.size;
    state.result.hashed++;

    const execBit = (fst.mode & 0o111) !== 0 ? '1' : '0';
    const canonicalMode = execBit === '1' ? 0o555 : 0o444;
    const prefixDir = join(state.casDir, digest.slice(0, 2));
    if (!ensureRealDir(prefixDir)) return 'ok';
    const casPath = join(prefixDir, `${digest}-${execBit}`);

    const existed = populateCas(fd, fst.size, digest, canonicalMode, prefixDir, casPath, state.buf, state.linkOp, state.seq++);
    if (existed === null) return 'ok';

    const casStat = safeLstat(casPath);
    if (!casStat?.isFile() || casStat.size !== fst.size) return 'ok';
    if (casStat.dev === fst.dev && casStat.ino === fst.ino) return 'ok';

    const sibling = join(dirname(filePath), `.hh-dedupe-${process.pid}-${state.seq++}`);
    try {
      state.linkOp(casPath, sibling);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        state.result.exdev = true;
        return 'exdev';
      }
      return 'ok';
    }

    try {
      const cur = safeLstat(filePath);
      if (!cur?.isFile() || cur.nlink !== 1 || cur.dev !== fst.dev || cur.ino !== fst.ino || cur.size !== fst.size || cur.mtimeMs !== fst.mtimeMs || cur.ctimeMs !== fst.ctimeMs) {
        unlinkSync(sibling);
        return 'ok';
      }
      renameSync(sibling, filePath);
      state.result.linked++;
      if (existed) state.result.freed += fst.size;
    } catch {
      try {
        unlinkSync(sibling);
      } catch {
        /* Ignore cleanup error if rename already moved sibling. */
      }
    }
    return 'ok';
  } finally {
    closeSync(fd);
  }
}

/* Recursively walks a verified node_modules directory without following symlinks or entering dot-folders. */
function walkNodeModules(dir: string, state: State): 'ok' | 'exdev' {
  if (!budgetLeft(state)) return 'ok';
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 'ok';
  }
  for (const name of names) {
    if (!budgetLeft(state)) return 'ok';
    if (!name || name.startsWith('.') || name.includes('/') || name.includes('\0')) continue;
    const entry = join(dir, name);
    const st = safeLstat(entry);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (walkNodeModules(entry, state) === 'exdev') return 'exdev';
    } else if (st.isFile() && st.nlink === 1 && st.size >= state.minBytes) {
      if (dedupeFile(entry, state) === 'exdev') return 'exdev';
    }
  }
  return 'ok';
}

/* Content-addressed hard-link deduplication over verified ignored node_modules folders. Never follows symlinks, never
   crosses outside each target's rootDir, skips dot-folders and recently modified files, and skips EXDEV cleanly. */
export function dedupeNodeModules(opts: DedupeOptions): DedupeResult {
  const result: DedupeResult = { hashed: 0, linked: 0, freed: 0, exdev: false };
  if (opts.targets.length === 0) return result;
  const storeStat = ensureRealDir(opts.store);
  if (!storeStat) return result;
  const casDir = join(opts.store, 'cas');
  const casStat = ensureRealDir(casDir);
  if (!casStat) return result;

  const state: State = {
    casDir,
    storeDev: casStat.dev,
    buf: Buffer.allocUnsafe(CHUNK_BYTES),
    nowMs: opts.nowMs ?? Date.now(),
    minBytes: opts.minBytes ?? MIN_DEDUPE_BYTES,
    settleMs: opts.settleMs ?? SETTLE_MS,
    maxHashBytes: opts.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES,
    maxFiles: opts.maxFiles ?? DEFAULT_MAX_FILES,
    deadlineMs: Date.now() + (opts.maxMs ?? DEFAULT_MAX_MS),
    linkOp: opts.link ?? linkSync,
    hashedBytes: 0,
    filesSeen: 0,
    seq: 0,
    result,
  };

  for (const target of opts.targets) {
    if (!budgetLeft(state)) break;
    const verified = verifiedNodeModules(target.rootDir, target.nodeModulesDir);
    if (!verified) continue;
    walkNodeModules(verified, state);
  }
  return result;
}

/* Removes unreferenced CAS files (nlink === 1) past retention, or immediately when aggressive (disk low), plus stale temp
   files left by an interrupted pass. Live hard-linked entries (nlink >= 2) are never removed. */
export function pruneCas(store: string, opts: PruneOptions = {}): PruneResult {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? CAS_MAX_AGE_MS;
  const aggressive = opts.aggressive ?? false;
  let pruned = 0;
  let freed = 0;

  if (!safeLstat(store)?.isDirectory()) return { pruned, freed };
  const casDir = join(store, 'cas');
  if (!safeLstat(casDir)?.isDirectory()) return { pruned, freed };

  let prefixes: string[];
  try {
    prefixes = readdirSync(casDir);
  } catch {
    return { pruned, freed };
  }

  for (const prefix of prefixes) {
    if (!HEX_PREFIX.test(prefix)) continue;
    const sub = join(casDir, prefix);
    if (!safeLstat(sub)?.isDirectory()) continue;
    let names: string[];
    try {
      names = readdirSync(sub);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(sub, name);
      const st = safeLstat(file);
      if (!st?.isFile()) continue;
      if (name.startsWith('.tmp-')) {
        if (nowMs - st.mtimeMs >= TEMP_STALE_MS) {
          try {
            unlinkSync(file);
          } catch {
            /* Ignore race with another pass. */
          }
        }
        continue;
      }
      if (st.nlink === 1 && (aggressive || nowMs - st.mtimeMs >= maxAgeMs)) {
        try {
          unlinkSync(file);
          pruned++;
          freed += st.size;
        } catch {
          /* Ignore race if file disappeared meanwhile. */
        }
      }
    }
  }
  return { pruned, freed };
}

const ZERO_OWNER_RESULT: OwnerDedupeResult = { hashed: 0, linked: 0, freed: 0, exdev: false, gcPruned: 0, gcFreed: 0 };

/* Runs deduplication and optional CAS GC strictly as owner.user (never as root). When the node itself runs unprivileged,
   runs in-process; when root with an owner.user, spawns a bounded unprivileged worker with uid/gid; when root without an
   owner.user, returns a safe no-op. */
export async function runDedupeForOwner(opts: OwnerDedupeOptions): Promise<OwnerDedupeResult> {
  const root = opts.isRoot ?? isRootUser();
  if (!root) {
    const dedup = dedupeNodeModules(opts);
    const gc = opts.prune ? pruneCas(opts.store, opts.prune) : { pruned: 0, freed: 0 };
    return { ...dedup, gcPruned: gc.pruned, gcFreed: gc.freed };
  }
  if (!opts.owner.user) return { ...ZERO_OWNER_RESULT };

  const payload = JSON.stringify({
    store: opts.store,
    targets: opts.targets,
    nowMs: opts.nowMs,
    minBytes: opts.minBytes,
    settleMs: opts.settleMs,
    maxHashBytes: opts.maxHashBytes,
    maxFiles: opts.maxFiles,
    maxMs: opts.maxMs,
    prune: opts.prune,
  });

  return new Promise<OwnerDedupeResult>(resolvePromise => {
    const child = spawn(process.execPath, [WORKER_PATH], {
      uid: opts.owner.user!.uid,
      gid: opts.owner.user!.gid,
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), WORKER_TIMEOUT_MS);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (out.length < 64 * 1024) out += chunk;
    });
    const finish = (res: OwnerDedupeResult) => {
      clearTimeout(timer);
      resolvePromise(res);
    };
    child.on('error', () => finish({ ...ZERO_OWNER_RESULT }));
    child.on('exit', code => {
      if (code !== 0) return finish({ ...ZERO_OWNER_RESULT });
      try {
        const parsed = JSON.parse(out.trim()) as Partial<OwnerDedupeResult>;
        finish({
          hashed: typeof parsed.hashed === 'number' ? parsed.hashed : 0,
          linked: typeof parsed.linked === 'number' ? parsed.linked : 0,
          freed: typeof parsed.freed === 'number' ? parsed.freed : 0,
          exdev: Boolean(parsed.exdev),
          gcPruned: typeof parsed.gcPruned === 'number' ? parsed.gcPruned : 0,
          gcFreed: typeof parsed.gcFreed === 'number' ? parsed.gcFreed : 0,
        });
      } catch {
        finish({ ...ZERO_OWNER_RESULT });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}
