import { closeSync, constants, cpSync, fchownSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { JobUser } from './isolation.js';

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const ENTRY = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const descriptorPath = (fd: number) => `/proc/self/fd/${fd}`;

function enter(parent: number, name: string, create: boolean): number {
  const path = join(descriptorPath(parent), name);
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  try { return openSync(path, DIRECTORY); }
  catch (error) { throw new Error('Service path must contain directories without links', { cause: error }); }
}

// Pin every ancestor, including those the job can rename. O_NOFOLLOW on the last component alone is insufficient.
export function withServiceDirectory<T>(path: string, create: boolean, use: (path: string, fd: number) => T): T {
  let fd = openSync(sep, DIRECTORY);
  try {
    for (const name of resolve(path).split(sep).filter(Boolean)) {
      const next = enter(fd, name, create);
      closeSync(fd); fd = next;
    }
    return use(descriptorPath(fd), fd);
  } finally { closeSync(fd); }
}

function ownDescriptor(fd: number, user: JobUser): void {
  const stat = fstatSync(fd);
  if (!stat.isDirectory() && !(stat.isFile() && stat.nlink === 1)) throw new Error('Service state cannot contain links or special files');
  if (stat.isDirectory()) {
    for (const name of readdirSync(descriptorPath(fd))) {
      const child = openSync(join(descriptorPath(fd), name), ENTRY);
      try { ownDescriptor(child, user); } finally { closeSync(child); }
    }
  }
  fchownSync(fd, user.uid, user.gid);
}

export function writeServiceFile(path: string, content: string, user: JobUser, replace = false): void {
  withServiceDirectory(dirname(path), false, parent => {
    const file = join(parent, basename(path));
    if (replace) rmSync(file, { force: true });
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, content); fchownSync(fd, user.uid, user.gid); } finally { closeSync(fd); }
  });
}

// Copy and transfer ownership before exposing the tree to the job, which may already have a running service.
export function copyServiceTree(source: string, destination: string, user: JobUser): void {
  withServiceDirectory(dirname(source), false, sourceParent => {
    withServiceDirectory(dirname(destination), false, parent => {
      const stage = mkdtempSync(join(parent, '.service-copy-'));
      const fd = openSync(stage, DIRECTORY);
      try {
        const stat = fstatSync(fd);
        if (stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('Service copy staging must be private to the node');
        const payload = join(descriptorPath(fd), 'payload');
        cpSync(join(sourceParent, basename(source)), payload, { recursive: true, dereference: false });
        const tree = openSync(payload, ENTRY);
        try { ownDescriptor(tree, user); } finally { closeSync(tree); }
        renameSync(payload, join(parent, basename(destination)));
      } finally { closeSync(fd); rmSync(stage, { recursive: true, force: true }); }
    });
  });
}
