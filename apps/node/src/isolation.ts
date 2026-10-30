import { appendFileSync, chmodSync, existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerMessage } from '@hornhoof/protocol';
import { adapterFor } from './providers/index.js';
import type { ProviderAdapter } from './runner.js';

/* The built-in node runs every company key's jobs under a Linux user of its own, so one key's agent never reads another's folders or the node's env. */

export type JobUser = { uid: number; gid: number };
export const FIRST_UID = 20000;

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;

const isRootUser = () => process.getuid?.() === 0;

/* Stable per subscription, kept in <dir>/users.json. Null unless the node runs as root, as personal nodes never do. */
export function userFor(dir: string, subscriptionId: string, isRoot = isRootUser()): JobUser | null {
  if (!isRoot) return null;
  const file = join(dir, 'users.json');
  let users: Record<string, number> = {};
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object') users = saved as Record<string, number>;
  } catch {
    /* No users yet. */
  }
  let uid = Object.hasOwn(users, subscriptionId) ? users[subscriptionId] : undefined;
  if (typeof uid !== 'number') {
    uid = Math.max(FIRST_UID - 1, ...Object.values(users).filter(n => typeof n === 'number')) + 1;
    users[subscriptionId] = uid;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(users), { mode: 0o600 });
  }
  return { uid, gid: uid };
}

export type FolderOps = {
  mkdir(path: string): void;
  owner(path: string): number;
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
  owner: path => statSync(path).uid,
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

type SystemFiles = { passwd: string; group: string };
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

type BuiltinOptions = { isRoot?: boolean; ops?: FolderOps; files?: SystemFiles };

/* The built-in node's adapter for a job: the key's own home in subs/<id>, its own user, and a work folder handed to that user. */
export function builtinAdapters(dir: string, tools: string, { isRoot = isRootUser(), ops = REAL_OPS, files = SYSTEM_FILES }: BuiltinOptions = {}) {
  return (job: JobRun): ProviderAdapter => {
    const user = userFor(dir, job.subscriptionId, isRoot);
    const home = prepareFolder(join(dir, 'subs', job.subscriptionId), user, ops);
    if (user) ensurePasswd(user, home, files);
    const adapter = adapterFor(job.provider, { home, tools, user });
    return {
      ...adapter,
      run: input => {
        prepareFolder(input.workDir, user, ops);
        return adapter.run(input);
      },
    };
  };
}
