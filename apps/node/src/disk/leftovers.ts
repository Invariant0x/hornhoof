import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, opendir, readdir, readlink } from 'node:fs/promises';
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
/* How long one folder's removal may take before the node gives up on it. */
export const REMOVE_TIMEOUT_MS = 5 * 60_000;
/* How long one look at the processes may take. One that takes longer counts as a look that could not read them, and so does
   one that starts while a read of an earlier look never came back: nothing goes. */
export const LOOK_MS = 30_000;
/* How long one cleaning may go on: no folder starts going after it, and the measure and removal of each end by then. */
export const CLEAN_MS = 5 * 60_000;

/* The user and group a folder is removed as. */
export type Rights = { uid: number; gid: number };
/* Removes a folder as the user who owns it, within timeoutMs; whether it all went. */
export type Remover = (path: string, as: Rights, timeoutMs: number) => Promise<boolean>;

type Options = {
  tmp: string;
  /* The users the node runs checks as, and itself: whose folders these are to take. */
  owners: readonly number[];
  /* Whether a check or a test part runs on the node now. */
  checking: () => boolean;
  /* Where the machine's processes are read, as Linux has them. */
  proc?: string;
  now?: () => number;
  remove?: Remover;
  lookMs?: number;
  cleanMs?: number;
};

export type Leftovers = { size(): Promise<number>; clean(): Promise<number> };

type Found = { path: string; name: string; ageMs: number; dev: number; ino: number; uid: number; gid: number };
type Owner = { pid: number; start: string | null };
/* What the processes of the machine hold, as a look at /proc finds. */
type Seen = {
  starts: Map<number, string>;
  /* The folders judged that a process works in, has open, runs from or names. */
  held: Set<string>;
  runner: boolean;
  /* A process of one of the users could not be read, so what it holds is not known. */
  blind: boolean;
};
/* What a look searches for: the folders judged, by name, in the temporary folder that paths start with. */
type Wanted = { prefix: string; bytes: Buffer; names: Set<string> };

const IGNORED = new Set(['ENOENT', 'ESRCH', 'ENOTDIR']);
const failed = (error: unknown) => (error as NodeJS.ErrnoException).code ?? '';
const RUNNER = /(?:^|[\s/])vitest(?:[\s/.]|$)/;
/* How much of a command line, an environment or a stat a look reads, into one buffer of this size that it reads each into in
   turn. A user may give its processes megabytes of them and thousands of processes: a look keeps none of it, only which of
   the folders it names. */
const MAX_TEXT = 256 * 1024;
const MAX_NAME = 64;

/* A character a folder's name may hold: what a name runs on through, so a path names a folder only where its name ends. */
const nameByte = (byte: number) =>
  (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x2e || byte === 0x5f || byte === 0x2d;

function wanted(tmp: string, names: Iterable<string>): Wanted {
  const prefix = tmp.endsWith('/') ? tmp : `${tmp}/`;
  return { prefix, bytes: Buffer.from(prefix), names: new Set(names) };
}

/* The folder judged that a path is in or is, if any. */
function heldAt(path: string, want: Wanted, held: Set<string>): void {
  if (!path.startsWith(want.prefix)) return;
  const end = path.indexOf('/', want.prefix.length);
  const name = path.slice(want.prefix.length, end === -1 ? undefined : end);
  if (want.names.has(name)) held.add(name);
}

/* The folders judged that a command line or an environment names by their path. */
function namedIn(text: Buffer, want: Wanted, held: Set<string>): void {
  for (let at = text.indexOf(want.bytes); at !== -1; at = text.indexOf(want.bytes, at + 1)) {
    const from = at + want.bytes.length;
    let to = from;
    while (to < text.length && to - from <= MAX_NAME && nameByte(text[to]!)) to++;
    if (to - from <= MAX_NAME) {
      const name = text.toString('latin1', from, to);
      if (want.names.has(name)) held.add(name);
    }
  }
}

/* As much of a file of a process as fits, read into the buffer; what it holds is good until the next read. */
async function readInto(path: string, into: Buffer): Promise<Buffer> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return into.subarray(0, 0);
  let size = 0;
  try {
    for (;;) {
      if (size >= into.length) break;
      const { bytesRead } = await handle.read(into, size, into.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
  } catch {
    /* What was read before stands. */
  } finally {
    await handle.close().catch(() => {});
  }
  return into.subarray(0, size);
}

async function link(path: string): Promise<string | null> {
  try { return (await readlink(path)).replace(/ \(deleted\)$/, ''); } catch { return null; }
}

/* Which of the folders judged a process works in, runs from and has open, one link at a time. False where its open files
   cannot be listed. */
async function holdings(dir: string, want: Wanted, held: Set<string>): Promise<boolean> {
  for (const own of ['cwd', 'exe']) {
    const path = await link(join(dir, own));
    if (path) heldAt(path, want, held);
  }
  try {
    for await (const fd of await opendir(join(dir, 'fd'))) {
      const path = await link(join(dir, 'fd', fd.name));
      if (path) heldAt(path, want, held);
    }
  } catch { return false; }
  return true;
}

/* One process of the machine: when it began, whether it is a test runner, and which of the folders judged it holds or names. */
async function inspect(proc: string, name: string, owners: readonly number[], want: Wanted, seen: Seen, buffer: Buffer): Promise<void> {
  const dir = join(proc, name);
  const stat = (await readInto(join(dir, 'stat'), buffer.subarray(0, 4096))).toString('latin1');
  const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  if (start) seen.starts.set(Number(name), start);
  const cmdline = await readInto(join(dir, 'cmdline'), buffer);
  namedIn(cmdline, want, seen.held);
  seen.runner ||= RUNNER.test(cmdline.toString('latin1').replace(/\0/g, ' '));
  namedIn(await readInto(join(dir, 'environ'), buffer), want, seen.held);
  if (await holdings(dir, want, seen.held)) return;
  /* A process that has gone is no matter; one of the users' that is there and cannot be read is. */
  const info = await lstat(dir).catch(error => (IGNORED.has(failed(error)) ? null : undefined));
  if (info === undefined || (info && owners.includes(info.uid))) seen.blind = true;
}

/* The reads of the processes that an earlier look gave up waiting for and that have not come back yet. */
let unanswered = 0;

/* A step of a look, given up once the look's time is over; one given up is unanswered until it ends. */
function inTime<T>(step: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      unanswered++;
      void step.then(() => {}, () => {}).finally(() => { unanswered--; });
      reject(new Error('The look at the processes took too long.'));
    }, Math.max(0, deadline - Date.now()));
    timer.unref();
  });
  return Promise.race([step, late]).finally(() => clearTimeout(timer));
}

/* When every process of the machine began, whether a test runner is one of them, and which of the folders judged one works
   in, has open, runs from or names. Null where the processes cannot be listed, a read of them fails or does not come back in
   time, or one of an earlier look still has not. */
async function look(proc: string, owners: readonly number[], want: Wanted, ms: number): Promise<Seen | null> {
  if (unanswered > 0) return null;
  const deadline = Date.now() + ms;
  const names = await inTime(readdir(proc), deadline).catch(() => null);
  if (!names) return null;
  const seen: Seen = { starts: new Map(), held: new Set(), runner: false, blind: false };
  const buffer = Buffer.alloc(MAX_TEXT);
  for (const name of names.filter(entry => /^[1-9]\d{0,9}$/.test(entry))) {
    if (!(await inTime(inspect(proc, name, owners, want, seen, buffer), deadline).then(() => true, () => false))) return null;
  }
  return seen;
}

/* A marker that is not a pid and a start time, or names no process, is no owner. */
async function ownerOf(path: string): Promise<Owner | null> {
  const file = join(path, OWNER_FILE);
  try {
    if (!(await lstat(file)).isFile()) return null;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return null;
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

/* The folders of the helpers in the temporary folder, as they are now. */
async function found({ tmp, owners, now = Date.now }: Options): Promise<Found[]> {
  const list: Found[] = [];
  for (const name of (await readdir(tmp).catch(() => [] as string[])).filter(entry => NAME.test(entry))) {
    const path = join(tmp, name), info = await lstat(path).catch(() => null);
    if (info?.isDirectory() && owners.includes(info.uid)) list.push({ path, name, ageMs: now() - info.mtimeMs, dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid });
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
  if ((owner && alive(owner, seen, real)) || seen.held.has(one.name)) return false;
  const live = waits && one.ageMs < LEFTOVER_IDLE_MS;
  if (owner) return !(seen.blind && live);
  return !seen.blind && one.ageMs >= LEFTOVER_GRACE_MS && !live;
}

/* A node that cannot read the processes takes nothing, as a folder may be held. With no folder to judge it reads none. */
async function doomed(options: Options, list: Found[]): Promise<Found[]> {
  if (!list.length) return [];
  const proc = options.proc ?? '/proc';
  const seen = await look(proc, options.owners, wanted(options.tmp, list.map(one => one.name)), options.lookMs ?? LOOK_MS);
  if (!seen) return [];
  const waits = options.checking() || seen.runner, gone: Found[] = [];
  for (const one of list) if (await goes(one, seen, waits, proc === '/proc')) gone.push(one);
  return gone;
}

/* The rights a folder is removed with: the node's own for its own folder, else its owner's. The owner may change what is in
   its folder while the removal walks it, swapping a folder for a link to anywhere, and a removal with the node's rights, which
   are root's on the built-in node, would then remove what the owner may not. With the owner's rights it removes no more than
   the owner could itself. A node that may not take them removes nothing. */
export function removalRights(owner: Rights, node = process.getuid?.()): Partial<Rights> {
  return owner.uid === node ? {} : { uid: owner.uid, gid: owner.gid };
}

/* A program run with a folder owner's rights, and whether it ended well in time. Its owner may stop it, which only a kill ends,
   so one that has not ended in time is killed and counts as failed at once, whether or not it ends after. */
export function runAs(file: string, args: readonly string[], as: Rights, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let timer: NodeJS.Timeout | undefined;
    const done = (ok: boolean) => { clearTimeout(timer); resolve(ok); };
    try {
      const child = execFile(file, args, { ...removalRights(as), env: { PATH: '/usr/bin:/bin' } }, error => done(!error));
      timer = setTimeout(() => { child.kill('SIGKILL'); done(false); }, timeoutMs);
      timer.unref();
    } catch {
      done(false);
    }
  });
}

/* rm with the owner's rights alone, which walks the folder by what it has open and stays on its file system; a node that may not
   take those rights, which spawning refuses at once, removes nothing. */
export const removeAs = (path: string, as: Rights, timeoutMs = REMOVE_TIMEOUT_MS): Promise<boolean> =>
  runAs('rm', ['-rf', '--one-file-system', '--', path], as, timeoutMs);

/* The folder is still the one that was judged, not taken again by another name since; then it goes, as its owner, and its
   bytes are freed. Its measure and its removal end by the time given. */
async function remove(one: Found, removal: Remover, until: number, now: () => number): Promise<number> {
  const again = await lstat(one.path).catch(() => null);
  if (!again?.isDirectory() || again.dev !== one.dev || again.ino !== one.ino || again.uid !== one.uid) return 0;
  const left = () => Math.min(REMOVE_TIMEOUT_MS, until - now());
  const bytes = await folderBytes(one.path, Math.max(1, left())).catch(() => 0);
  if (left() <= 0) return 0;
  return (await removal(one.path, { uid: again.uid, gid: again.gid }, left()).catch(() => false)) ? bytes : 0;
}

/* The folders the test helpers leave in the temporary folder: what nothing owns or holds any more goes. */
export function testLeftovers(options: Options): Leftovers {
  return {
    async size() {
      let bytes = 0;
      for (const one of await found(options)) bytes += await folderBytes(one.path).catch(() => 0);
      return bytes;
    },
    /* A cleaning has its time, so that a pass ends however many folders a user leaves and however long they take to go. */
    async clean() {
      const { now = Date.now } = options, until = now() + (options.cleanMs ?? CLEAN_MS);
      let freed = 0;
      for (const one of await doomed(options, await found(options))) {
        if (until - now() <= 0) break;
        freed += await remove(one, options.remove ?? removeAs, until, now);
      }
      return freed;
    },
  };
}
