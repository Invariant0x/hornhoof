import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { folderBytes } from './clean.js';

/* The test helpers of this repository make folders in the machine's temporary folder: the database a run starts from, the
   installs a migration test replays, and the copies of migrations. Their runs remove them as they end. A run that is killed
   outright leaves them, as much as half a GiB each, and nothing of ours removed them, so a few days of runs filled a disk. */

/* The file in which a helper names the process it made the folder for, and when that began: "PID START", START being the
   kernel's start time of the process, which tells it from another that took the same number. */
export const OWNER_FILE = '.hh-owner';
/* What the helpers name their folders: a prefix and the six characters of mkdtemp. */
const NAME = /^(?:hh-test-db|hh-test-initdb|hh-installs|hh-migrations|drz)-[A-Za-z0-9]{6}$/;
/* A folder this young is never taken unless the process it names has gone: its helper may not have written its owner yet. */
export const LEFTOVER_GRACE_MS = 10 * 60_000;
/* A folder that names no owner is kept while a check or a test runner is alive on the machine, and so long as it is not older
   than the longest run, which a test run's own limit ends well before. */
export const LEFTOVER_IDLE_MS = 4 * 60 * 60_000;

type Options = {
  tmp: string;
  /* The users the node runs checks as, and itself: whose folders these are to take. */
  owners: readonly number[];
  /* Whether a check or a test part runs on the node now. */
  checking: () => boolean;
  /* Where the machine's processes are read, as Linux has them. */
  proc?: string;
  now?: () => number;
};

export type Leftovers = { size(): Promise<number>; clean(): Promise<number> };

type Found = { path: string; ageMs: number; dev: number; ino: number };
type Owner = { pid: number; start: string | null };
/* What the processes of the machine hold, as a look at /proc finds. */
type Seen = {
  starts: Map<number, string>;
  paths: string[];
  words: string[];
  runner: boolean;
  /* A process of one of the users could not be read, so what it holds is not known. */
  blind: boolean;
};

const IGNORED = new Set(['ENOENT', 'ESRCH', 'ENOTDIR']);
const failed = (error: unknown) => (error as NodeJS.ErrnoException).code ?? '';
const escape = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const RUNNER = /(?:^|[\s/])vitest(?:[\s/.]|$)/;
const MAX_TEXT = 256 * 1024;

async function text(path: string): Promise<string> {
  try { return (await readFile(path, 'latin1')).slice(0, MAX_TEXT); } catch { return ''; }
}

async function link(path: string): Promise<string | null> {
  try { return (await readlink(path)).replace(/ \(deleted\)$/, ''); } catch { return null; }
}

/* What a process works in, runs and has open. Null where its open files cannot be listed. */
async function holdings(dir: string): Promise<string[] | null> {
  const found = await Promise.all(['cwd', 'exe'].map(own => link(join(dir, own))));
  try {
    const fds = await readdir(join(dir, 'fd'));
    found.push(...await Promise.all(fds.map(fd => link(join(dir, 'fd', fd)))));
  } catch { return null; }
  return found.filter((path): path is string => path !== null);
}

/* One process of the machine: when it began, what it holds, and the words of its command line and environment. */
async function inspect(proc: string, name: string, owners: readonly number[], seen: Seen): Promise<void> {
  const dir = join(proc, name);
  const stat = await text(join(dir, 'stat'));
  const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  if (start) seen.starts.set(Number(name), start);
  const cmdline = (await text(join(dir, 'cmdline'))).split('\0');
  seen.words.push(...cmdline, ...(await text(join(dir, 'environ'))).split('\0'));
  seen.runner ||= RUNNER.test(cmdline.join(' '));
  const held = await holdings(dir);
  if (held) { seen.paths.push(...held); return; }
  /* A process that has gone is no matter; one of the users' that is there and cannot be read is. */
  const info = await lstat(dir).catch(error => (IGNORED.has(failed(error)) ? null : undefined));
  if (info === undefined || (info && owners.includes(info.uid))) seen.blind = true;
}

/* The folders and files every process of the machine works in, has open, or runs, the words of its command line and
   environment, and when each began. Null where the processes cannot be listed. */
async function look(proc: string, owners: readonly number[]): Promise<Seen | null> {
  const names = await readdir(proc).catch(() => null);
  if (!names) return null;
  const seen: Seen = { starts: new Map(), paths: [], words: [], runner: false, blind: false };
  for (const name of names.filter(entry => /^[1-9]\d{0,9}$/.test(entry))) await inspect(proc, name, owners, seen);
  return seen;
}

/* A marker that is not a pid and a start time, or names no process, is no owner. */
async function ownerOf(path: string): Promise<Owner | null> {
  const file = join(path, OWNER_FILE);
  try {
    if (!(await lstat(file)).isFile()) return null;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const { bytesRead, buffer } = await handle.read(Buffer.alloc(64), 0, 64, 0);
      const match = /^(\d{1,9})(?: (\d{1,20}))?\s*$/.exec(buffer.toString('utf8', 0, bytesRead));
      return match && Number(match[1]) > 0 ? { pid: Number(match[1]), start: match[2] ?? null } : null;
    } finally { await handle.close(); }
  } catch { return null; }
}

/* Whether the process an owner names still lives. A process the listing does not show may still be there, as a machine can hide
   the processes of other users from it, and then it answers a signal of 0; only the real listing is asked so. */
function alive(owner: Owner, seen: Seen, real: boolean): boolean {
  const start = seen.starts.get(owner.pid);
  if (start !== undefined) return owner.start === null || owner.start === start;
  if (!real) return false;
  try { process.kill(owner.pid, 0); return true; } catch (error) { return failed(error) === 'EPERM'; }
}

function holds(path: string, seen: Seen): boolean {
  const named = new RegExp(`${escape(path)}(?![A-Za-z0-9._-])`);
  return seen.paths.some(held => held === path || held.startsWith(`${path}/`)) || seen.words.some(word => named.test(word));
}

/* The folders of the helpers in the temporary folder, as they are now. */
async function found({ tmp, owners, now = Date.now }: Options): Promise<Found[]> {
  const list: Found[] = [];
  for (const name of (await readdir(tmp).catch(() => [] as string[])).filter(entry => NAME.test(entry))) {
    const path = join(tmp, name), info = await lstat(path).catch(() => null);
    if (info?.isDirectory() && owners.includes(info.uid)) list.push({ path, ageMs: now() - info.mtimeMs, dev: info.dev, ino: info.ino });
  }
  return list;
}

/* Whether a folder is nobody's any more. It stays where its owner lives, and where a process of the machine works in it, has a
   file of it open or names it, whoever made it: the workers of a run whose main process was killed still read what it made.
   A folder whose owner has gone stays too while a process of the users cannot be read and a check or a test runner may be
   running, unless it is very old. With no owner named, it stays while it is young, while a process of the users cannot be
   read, or while a check or a test runner may be running and it is not very old. */
async function goes(one: Found, seen: Seen, waits: boolean, real: boolean): Promise<boolean> {
  const owner = await ownerOf(one.path);
  if ((owner && alive(owner, seen, real)) || holds(one.path, seen)) return false;
  const live = waits && one.ageMs < LEFTOVER_IDLE_MS;
  if (owner) return !(seen.blind && live);
  return !seen.blind && one.ageMs >= LEFTOVER_GRACE_MS && !live;
}

/* A node that cannot read the processes takes nothing, as a folder may be held. */
async function doomed(options: Options, list: Found[]): Promise<Found[]> {
  const proc = options.proc ?? '/proc', seen = await look(proc, options.owners);
  if (!seen) return [];
  const waits = options.checking() || seen.runner, gone: Found[] = [];
  for (const one of list) if (await goes(one, seen, waits, proc === '/proc')) gone.push(one);
  return gone;
}

/* The folder is still the one that was judged, not taken again by another name since; then it goes, and its bytes are freed. */
async function remove(one: Found): Promise<number> {
  const again = await lstat(one.path).catch(() => null);
  if (!again?.isDirectory() || again.dev !== one.dev || again.ino !== one.ino) return 0;
  const bytes = await folderBytes(one.path).catch(() => 0);
  try { await rm(one.path, { recursive: true, force: true }); return bytes; } catch { return 0; }
}

/* The folders the test helpers leave in the temporary folder: what nothing owns or holds any more goes. */
export function testLeftovers(options: Options): Leftovers {
  return {
    async size() {
      let bytes = 0;
      for (const one of await found(options)) bytes += await folderBytes(one.path).catch(() => 0);
      return bytes;
    },
    async clean() {
      let freed = 0;
      for (const one of await doomed(options, await found(options))) freed += await remove(one);
      return freed;
    },
  };
}
