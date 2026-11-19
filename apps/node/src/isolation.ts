import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lchownSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTBOX_FILE } from './outbox.js';

/* The built-in node runs every company key's jobs under a Linux user of its own, so one key's agent never reads another's folders or the node's env. */

export type JobUser = { uid: number; gid: number };
export const FIRST_UID = 20000;
const LAST_UID = 0x7fffffff; // Node takes signed 32-bit IDs when spawning a process.

export const isRootUser = () => process.getuid?.() === 0;

/* Stable per subscription or agent, kept in <dir>/users.json. Null unless the node runs as root. */
export function userFor(dir: string, subscriptionId: string, isRoot = isRootUser()): JobUser | null {
  if (!isRoot) return null;
  const file = join(dir, 'users.json');
  const users = readUsers(file);
  if (Object.hasOwn(users, subscriptionId)) {
    const uid = users[subscriptionId]!;
    return { uid, gid: uid };
  }
  const uid = Object.values(users).reduce((highest, used) => Math.max(highest, used), FIRST_UID - 1) + 1;
  if (uid > LAST_UID) throw new Error('users.json has no UIDs left to assign.');
  writeUsers(dir, file, { ...users, [subscriptionId]: uid });
  return { uid, gid: uid };
}

function readUsers(file: string): Record<string, number> {
  let text: string | null;
  try {
    text = readUserFile(file);
  } catch (error) {
    throw new Error(`Cannot read users.json: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (text === null) return {};
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    throw new Error('Invalid users.json: expected valid JSON.');
  }
  if (!validUsers(saved)) throw new Error('Invalid users.json: expected a map of distinct node UIDs.');
  return saved;
}

function validUsers(saved: unknown): saved is Record<string, number> {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return false;
  const uids: unknown[] = Object.values(saved);
  return uids.every(uid => typeof uid === 'number' && Number.isInteger(uid) && uid >= FIRST_UID && uid <= LAST_UID)
    && new Set(uids).size === uids.length;
}

/* Open the registry itself so a broken link cannot look like a missing file. */
function readUserFile(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error('expected a regular file.');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function writeUsers(dir: string, file: string, users: Record<string, number>): void {
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `.users-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, JSON.stringify(users));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve the original write error. */ }
    throw error;
  }
  const parent = openSync(dir, 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export type FolderOps = {
  mkdir(path: string): void;
  exists(path: string): boolean;
  owner(path: string): number;
  chown(path: string, uid: number, gid: number): void;
  chownTree(path: string, uid: number, gid: number): void;
  chmod(path: string, mode: number): void;
};

/* lchown and lstat, so a link an agent leaves in its folder never hands over a file outside it. */
function chownTree(path: string, uid: number, gid: number): void {
  lchownSync(path, uid, gid);
  if (lstatSync(path).isDirectory()) for (const entry of readdirSync(path)) chownTree(join(path, entry), uid, gid);
}

const REAL_OPS: FolderOps = {
  mkdir: path => void mkdirSync(path, { recursive: true }),
  exists: path => existsSync(path),
  owner: path => statSync(path).uid,
  chown: lchownSync,
  chownTree,
  chmod: chmodSync,
};

/* Makes the folder and gives it to the user, mode 0700. Files from before the user existed are handed over once. */
export function prepareFolder(path: string, user: JobUser | null, ops: FolderOps = REAL_OPS): string {
  ops.mkdir(path);
  if (user) {
    if (ops.owner(path) !== user.uid) ops.chownTree(path, user.uid, user.gid);
    ops.chmod(path, 0o700);
  }
  return path;
}

/* CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID, SETUID and SYS_PTRACE: what a root node needs to run its agents as another
   user, reach their files and tell which of them calls its bridge. */
const AGENT_CAPS = [0, 1, 3, 5, 6, 7, 19].reduce((all, bit) => all | (1n << BigInt(bit)), 0n);

const field = (text: string, name: string) => new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(text)?.[1];

/* Agents of a personal plan share one sign-in, which their programs write for their own user only, so they all run as
   one user: the image's node user, apart from a node that runs as root. Null keeps them as the node itself, as nodes did
   before, when it is not root or may not do all that. */
export function agentUser({ status = '/proc/self/status', passwd = '/etc/passwd' } = {}): JobUser | null {
  let text = '';
  try {
    text = readFileSync(status, 'utf8');
  } catch {
    return null;
  }
  const caps = field(text, 'CapEff');
  if (field(text, 'Uid') !== '0' || !caps || (BigInt(`0x${caps}`) & AGENT_CAPS) !== AGENT_CAPS) return null;
  const entry = existsSync(passwd) ? readFileSync(passwd, 'utf8').split('\n').find(line => line.startsWith('node:')) : undefined;
  const [, , uid, gid] = entry?.split(':') ?? [];
  return uid && gid && /^\d+$/.test(uid) && /^\d+$/.test(gid) ? { uid: Number(uid), gid: Number(gid) } : null;
}

/* A command line that runs as the agents' user, from a node that runs as root. */
export const asAgent = (argv: string[], user: JobUser): string[] => ['setpriv', `--reuid=${user.uid}`, `--regid=${user.gid}`, '--init-groups', '--', ...argv];

/* A personal node that runs as root keeps its key, its records and the agent programs to itself: no agent can change
   where the node connects, read its key or swap a program or a browser another agent starts. The agents get their homes
   and work folders. Of the shared browsers only the top comes back here: the browser check drops what is not root's, and
   handed to root here what an agent or a test run left in them would pass that check, and run as root. */
export function secureNode(dir: string, user: JobUser, ops: FolderOps = REAL_OPS): void {
  if (ops.owner(dir) !== 0) ops.chown(dir, 0, 0);
  ops.chmod(dir, 0o755);
  for (const file of ['node.json', 'sessions.json', 'users.json', 'login-url', 'removed', 'browser-error', 'browsers', OUTBOX_FILE]) {
    const path = join(dir, file);
    if (ops.exists(path) && ops.owner(path) !== 0) ops.chown(path, 0, 0);
  }
  for (const tree of ['tools', '.hh-recordings']) {
    const path = join(dir, tree);
    if (ops.exists(path) && ops.owner(path) !== 0) ops.chownTree(path, 0, 0);
  }
  for (const sub of ['home', 'work']) prepareFolder(join(dir, sub), user, ops);
}

export type SystemFiles = { passwd: string; group: string };
const SYSTEM_FILES: SystemFiles = { passwd: '/etc/passwd', group: '/etc/group' };

function hasId(file: string, id: number): boolean {
  return existsSync(file) && readFileSync(file, 'utf8').split('\n').some(line => line.split(':')[2] === String(id));
}

function appendLine(file: string, line: string): void {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + line + '\n');
}

/* Programs such as git look the user up by uid, so it gets a passwd and group entry inside the container. */
export function ensurePasswd(user: JobUser, home: string, files: SystemFiles = SYSTEM_FILES): void {
  const name = `hh${user.uid}`;
  if (!hasId(files.passwd, user.uid)) appendLine(files.passwd, `${name}:x:${user.uid}:${user.gid}:Hornhoof agent:${home}:/bin/bash`);
  if (!hasId(files.group, user.gid)) appendLine(files.group, `${name}:x:${user.gid}:`);
}
